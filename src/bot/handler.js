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
    // 非私聊 + 引用回复 → 可能是讨论群组的回复
    if (update.message.chat.type !== 'private' && update.message.reply_to_message) {
      await handleGroupReply(update.message, env);
    } else {
      await processMessage(update.message, env);
    }
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

/**
 * 处理讨论群组中的回复（通过 forward_origin 自动识别）
 * 频道关联讨论组后，TG 自动转发帖子到群组（带 forward_origin），
 * 群组成员回复时可通过 origin message_id 匹配到频道原帖
 * @param {object} msg - message 对象（非 private）
 * @param {object} env
 */
async function handleGroupReply(msg, env) {
  if (!msg.reply_to_message) return;

  const replied = msg.reply_to_message;

  // 仅处理由本频道自动转发到群组的消息
  const origin = replied.forward_origin;
  if (!origin || origin.type !== 'channel') return;
  if (String(origin.chat.id) !== String(env.CHANNEL_ID)) return;

  // origin.message_id 即频道中的原始 message_id，直接查 msgmap
  const channelMsgId = origin.message_id;
  const mapping = await getMsgMapping(channelMsgId, env);
  if (!mapping) return;

  // 不通知自己评论自己
  if (msg.from && msg.from.id === mapping.userId) return;

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
    channelMsgId,
    // 讨论组中的回复需要回复到频道时，引用的是频道评论消息本身
    // 但由于群组消息 ID 和频道消息 ID 不同，这里保存群组消息 ID
    commentMsgId: msg.message_id,  // 注：此 ID 是群组中的 ID，回复时会发到频道
    isGroupReply: true,
  }, env);

  // 私聊通知投稿人，附带回复按钮
  const notifyText = `<b>📢 ${commenter} 在讨论组评论了你的投稿：</b>\n\n${commentText}`;
  const replyMarkup = {
    inline_keyboard: [[
      { text: '💬 回复', callback_data: CB.REPLY },
    ]],
  };

  await sendMessage(mapping.userId, notifyText, replyMarkup, env);
}
