// ============================================================
// Telegram Bot API 封装 — 纯 fetch，零依赖
// ============================================================

const BASE_URL = 'https://api.telegram.org';

/**
 * 调用 Telegram Bot API
 * @param {string} method - API 方法名
 * @param {object} params - 请求参数
 * @param {object} env - Worker 环境变量（含 BOT_TOKEN）
 * @returns {Promise<object>} API 响应 JSON
 */
export async function callTG(method, params, env) {
  try {
    const url = `${BASE_URL}/bot${env.BOT_TOKEN}/${method}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (!json.ok) {
      console.error(`TG API error [${method}]:`, json.description, params);
    }
    return json;
  } catch (e) {
    console.error(`TG API network error [${method}]:`, e.message, params);
    return { ok: false, description: e.message };
  }
}

/**
 * 发送消息
 * @param {number} chatId
 * @param {string} text
 * @param {object} [replyMarkup] - Inline Keyboard markup
 * @param {object} env
 * @param {number} [replyToMessageId] - 引用回复的消息 ID
 */
export async function sendMessage(chatId, text, replyMarkup, env, replyToMessageId) {
  const params = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
  };
  if (replyMarkup) {
    params.reply_markup = replyMarkup;
  }
  if (replyToMessageId) {
    params.reply_to_message_id = replyToMessageId;
  }
  return callTG('sendMessage', params, env);
}

/**
 * 复制消息到频道（转发单条媒体）
 */
export async function copyMessage(chatId, fromChatId, messageId, env) {
  return callTG('copyMessage', {
    chat_id: chatId,
    from_chat_id: fromChatId,
    message_id: messageId,
  }, env);
}

/**
 * 发送媒体组
 * @param {string} chatId
 * @param {Array<object>} media - TG media group 格式数组
 */
export async function sendMediaGroup(chatId, media, env) {
  return callTG('sendMediaGroup', {
    chat_id: chatId,
    media,
  }, env);
}

/**
 * 编辑消息文本（用于更新已发送消息的按钮等）
 */
export async function editMessageText(chatId, messageId, text, replyMarkup, env) {
  return callTG('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    reply_markup: replyMarkup,
  }, env);
}

/**
 * 回答 Callback Query（关闭按钮 loading 状态）
 */
export async function answerCallbackQuery(callbackId, text, env) {
  return callTG('answerCallbackQuery', {
    callback_query_id: callbackId,
    text,
    show_alert: !!text,
  }, env);
}

/**
 * 设置 Webhook（部署时调用）
 */
export async function setWebhook(url, secret, env) {
  const result = await callTG('setWebhook', {
    url,
    secret_token: secret,
    allowed_updates: ['message', 'callback_query', 'channel_post'],
  }, env);
  // 同步设置 Bot 命令列表
  await setMyCommands(env);
  return result;
}

/**
 * 设置 Bot 命令列表（TG 客户端 / 菜单显示）
 */
export async function setMyCommands(env) {
  return callTG('setMyCommands', {
    commands: [
      { command: 'start', description: '开始投稿' },
      { command: 'stop', description: '停止投稿' },
    ],
  }, env);
}

/**
 * 从消息中提取 file_id（仅 photo 取最大尺寸 + video）
 * @param {object} msg - TG Message 对象
 * @returns {Array<{type: string, file_id: string}>}
 */
export function extractMedia(msg) {
  const items = [];

  if (msg.photo && msg.photo.length > 0) {
    // photo 是数组，取最大尺寸（最后一个）
    const largest = msg.photo[msg.photo.length - 1];
    items.push({ type: 'photo', file_id: largest.file_id });
  }
  if (msg.video) {
    items.push({ type: 'video', file_id: msg.video.file_id });
  }
  // 仅支持照片和视频，其他类型（文件/音频/动画/贴纸）不提取

  return items;
}

/**
 * 删除消息（频道或私聊）
 * @param {string|number} chatId
 * @param {number} messageId
 * @param {object} env
 */
export async function deleteMessage(chatId, messageId, env) {
  return callTG('deleteMessage', { chat_id: chatId, message_id: messageId }, env);
}

/**
 * 获取文件下载路径
 * @param {string} fileId - TG file_id
 * @param {object} env
 * @returns {Promise<object>} { file_id, file_path, file_unique_id }
 */
export async function getFile(fileId, env) {
  return callTG('getFile', { file_id: fileId }, env);
}

/**
 * 构建媒体组输入（用于 sendMediaGroup）
 * @param {Array<{type: string, file_id: string}>} mediaList
 * @param {string|null} caption - 文案（仅首项带）
 * @returns {Array<object>}
 */
export function buildMediaGroup(mediaList, caption) {
  return mediaList.map((item, idx) => {
    const entry = {
      type: item.type,
      media: item.file_id,
    };
    if (idx === 0 && caption) {
      entry.caption = caption;
      entry.parse_mode = 'HTML';
    }
    return entry;
  });
}
