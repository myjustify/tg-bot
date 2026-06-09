// ============================================================
// Webhook 入口 — 签名验证 + Update 分发
// ============================================================

import { processMessage, processCallback } from './state.js';
import { getMsgMapping, saveReplyContext } from '../storage/kv.js';
import { sendMessage } from '../utils/telegram.js';
import { CB } from '../utils/constants.js';

/**
 * 处理 Webhook 请求
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleWebhook(request, env) {
  // 1. 验证 Secret Token
  const secret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (secret !== env.WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response('Bad Request', { status: 400 });
  }

  // 2. 分发 Update
  if (update.message) {
    await processMessage(update.message, env);
  }

  if (update.channel_post) {
    await handleChannelPost(update.channel_post, env);
  }

  if (update.callback_query) {
    await processCallback(update.callback_query, env);
  }

  // 3. 始终返回 200
  return new Response('OK', { status: 200 });
}

/**
 * 处理频道消息（管理员回复检测）
 * @param {object} msg - channel_post message 对象
 * @param {object} env
 */
async function handleChannelPost(msg, env) {
  // 仅处理来自目标频道的回复消息
  if (String(msg.chat.id) !== String(env.CHANNEL_ID)) return;
  if (!msg.reply_to_message) return;

  // 查找被回复消息的投稿人
  const originalMsgId = msg.reply_to_message.message_id;
  const mapping = await getMsgMapping(originalMsgId, env);
  if (!mapping) return;

  // 构造评论者标识
  const commenter = msg.from
    ? (msg.from.username ? `@${msg.from.username}` : msg.from.first_name || '用户')
    : '用户';

  // 提取评论文本
  let commentText;
  if (msg.text) {
    commentText = msg.text;
  } else if (msg.caption) {
    commentText = msg.caption;
  } else {
    commentText = '（非文字消息）';
  }

  // 保存回复上下文，供投稿者点击"回复"按钮后使用
  await saveReplyContext(mapping.userId, {
    channelMsgId: originalMsgId,
    commentMsgId: msg.message_id,
  }, env);

  // 私聊通知投稿人，附带回复按钮
  const notifyText = `<b>📢 ${commenter} 评论了你的投稿：</b>\n\n${commentText}`;
  const replyMarkup = {
    inline_keyboard: [[
      { text: '💬 回复', callback_data: CB.REPLY },
    ]],
  };

  await sendMessage(mapping.userId, notifyText, replyMarkup, env);
}
