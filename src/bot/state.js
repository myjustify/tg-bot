// ============================================================
// 状态机 — 用户交互逻辑
// ============================================================

import { STATE, MAX_MEDIA, CB } from '../utils/constants.js';
import { getSession, saveSession, deleteSession, getReplyContext, deleteReplyContext } from '../storage/kv.js';
import { sendMessage, answerCallbackQuery, extractMedia } from '../utils/telegram.js';
import { forward } from './forwarder.js';

// ============================================================
// 消息处理
// ============================================================

/**
 * 处理用户普通消息（非 callback）
 * @param {object} msg - TG Message 对象
 * @param {object} env
 */
export async function processMessage(msg, env) {
  const chatId = msg.chat.id;
  const text = msg.text || msg.caption || '';

  // /start 指令
  if (text.startsWith('/start')) {
    await handleStart(chatId, env);
    return;
  }

  // /cancel 指令（兼容旧版）
  if (text.startsWith('/cancel')) {
    await handleCancel(chatId, env);
    return;
  }

  // /stop 指令
  if (text.startsWith('/stop')) {
    await handleCancel(chatId, env);
    return;
  }

  // 检查是否有活跃的回复上下文（评论回复功能）
  // 仅纯文本消息走回复逻辑，带媒体（photo/video）的消息跳过，走正常投稿
  const hasMedia = !!(msg.photo || msg.video);
  const replyCtx = await getReplyContext(chatId, env);
  if (replyCtx && text && !hasMedia) {
    await handleReplyMessage(chatId, text, replyCtx, env);
    return;
  }

  // 检查是否有活跃会话
  const session = await getSession(chatId, env);

  if (session && session.state === STATE.AWAITING_CAPTION) {
    // 用户正在补充文案阶段
    await handleCaptionInput(chatId, text, session, env);
    return;
  }

  if (session && (session.state === STATE.AWAITING_TYPE || session.state === STATE.AWAITING_CONFIRM)) {
    // 已有会话，追加素材（确认阶段也可追加）
    await handleAdditionalMedia(chatId, msg, session, env);
    return;
  }

  if (session && session.state === STATE.READY) {
    // 用户已就绪，创建新投稿会话
    await createNewSession(chatId, msg, env);
    return;
  }

  // 没有活跃会话 → 静默忽略（需先发送 /start）
}

// ============================================================
// 回调处理（按钮点击）
// ============================================================

/**
 * 处理 Inline Keyboard 回调
 * @param {object} query - CallbackQuery 对象
 * @param {object} env
 */
export async function processCallback(query, env) {
  const chatId = query.message.chat.id;
  const data = query.data;

  // 立即响应（移除 loading 状态）
  await answerCallbackQuery(query.id, null, env);

  // CB.REPLY 不依赖投稿会话，独立处理
  if (data === CB.REPLY) {
    const replyCtx = await getReplyContext(chatId, env);
    if (!replyCtx) {
      await sendMessage(chatId, '⚠️ 回复上下文已过期，无法回复。', undefined, env);
      return;
    }
    await sendMessage(chatId, '💬 请输入你的回复内容（文字消息）：', undefined, env);
    return;
  }

  const session = await getSession(chatId, env);
  if (!session) {
    await sendMessage(chatId, '⚠️ 会话已过期，请重新发送素材。', undefined, env);
    return;
  }

  switch (data) {
    case CB.ANON_YES:
      session.isAnonymous = true;
      await saveSession(chatId, session, env);
      // 纯文字投稿跳过文案询问，直接转发
      if (session.text && session.media.length === 0) {
        await forward(chatId, env);
      } else {
        await showCaptionButtons(chatId, env);
      }
      break;

    case CB.ANON_NO:
      session.isAnonymous = false;
      await saveSession(chatId, session, env);
      // 纯文字投稿跳过文案询问，直接转发
      if (session.text && session.media.length === 0) {
        await forward(chatId, env);
      } else {
        await showCaptionButtons(chatId, env);
      }
      break;

    case CB.CAPTION_NO:
      // 多图投稿显示确认预览，单图/纯文字直接转发
      if (session.media.length > 1) {
        await showConfirmButtons(chatId, env);
      } else {
        await forward(chatId, env);
      }
      break;

    case CB.CAPTION_YES:
      // 等待补充文案
      session.state = STATE.AWAITING_CAPTION;
      await saveSession(chatId, session, env);
      await sendMessage(
        chatId,
        '📝 请直接发送你的投稿文案（文字消息即可）：',
        {
          inline_keyboard: [[
            { text: '❌ 取消投稿', callback_data: CB.CANCEL },
          ]],
        },
        env
      );
      break;

    case CB.CONFIRM_SEND:
      await forward(chatId, env);
      break;

    case CB.CANCEL:
      await handleCancel(chatId, env);
      break;

    default:
      break;
  }
}

// ============================================================
// 具体处理函数
// ============================================================

/**
 * /start 指令处理
 */
async function handleStart(chatId, env) {
  // 清理可能存在的回复上下文（用户通过 /start 退出回复状态）
  await deleteReplyContext(chatId, env);

  // 创建就绪会话（必须先 /start 才能投稿）
  await saveSession(chatId, {
    state: STATE.READY,
    lastActivity: Date.now(),
  }, env);

  const text = '👋 你好！欢迎使用匿名投稿机器人。\n\n'
    + '请直接发送你想要投稿的素材（图片/视频），单次最多 <b>9</b> 个。\n'
    + '也支持纯文字投稿，直接发送文字即可。\n\n'
    + '发送 /stop 可取消当前投稿。';

  const keyboard = {
    inline_keyboard: [[
      { text: '📝 开始投稿', callback_data: 'start_submit' },
    ]],
  };
  await sendMessage(chatId, text, keyboard, env);
}

/**
 * 创建新会话（首次素材）
 */
async function createNewSession(chatId, msg, env) {
  const mediaItems = extractMedia(msg);
  const text = msg.text || msg.caption || '';

  const username = (msg.from && msg.from.username) ? msg.from.username : null;
  const firstName = (msg.from && msg.from.first_name) ? msg.from.first_name : '';
  const lastName = (msg.from && msg.from.last_name) ? msg.from.last_name : '';

  // 纯文本消息
  if (mediaItems.length === 0 && text) {
    const session = {
      state: STATE.AWAITING_TYPE,
      media: [],
      text: text,        // 纯文本内容
      isAnonymous: null,
      username: username,
      firstName: firstName,
      lastName: lastName,
      lastActivity: Date.now(),
      messageIds: [],
    };
    await saveSession(chatId, session, env);
    await showTypeButtons(chatId, env);
    return;
  }

  // 媒体消息
  if (mediaItems.length === 0) {
    // 不支持的消息类型
    await sendMessage(
      chatId,
      '⚠️ 不支持的消息类型，请发送图片、视频或文字。',
      undefined,
      env
    );
    return;
  }

  if (mediaItems.length > MAX_MEDIA) {
    await sendMessage(
      chatId,
      `⚠️ 单次最多发送 <b>${MAX_MEDIA}</b> 个素材，你发送了 ${mediaItems.length} 个。请重新发送。`,
      undefined,
      env
    );
    return;
  }

  const session = {
    state: STATE.AWAITING_TYPE,
    media: mediaItems,
    text: '',
    isAnonymous: null,
    username: username,
    firstName: firstName,
    lastName: lastName,
    lastActivity: Date.now(),
    messageIds: [msg.message_id],
  };
  await saveSession(chatId, session, env);
  await showTypeButtons(chatId, env);
}

/**
 * 追加更多素材
 */
async function handleAdditionalMedia(chatId, msg, session, env) {
  const newMedia = extractMedia(msg);
  const text = msg.text || msg.caption || '';

  // 纯文本追加（视为补充文案）
  if (newMedia.length === 0 && text) {
    if (session.text) {
      session.text += '\n' + text;
    } else {
      session.text = text;
    }
    session.lastActivity = Date.now();
    session.messageIds.push(msg.message_id);
    await saveSession(chatId, session, env);

    // 如果用户已选择实名/匿名，说明正在等待补充文案，直接转发
    if (session.isAnonymous !== null) {
      await forward(chatId, env);
      return;
    }

    await sendMessage(
      chatId,
      '📝 文案已追加。你可以继续发送素材，或点击下方按钮选择操作：',
      buildTypeKeyboard(),
      env
    );
    return;
  }

  // 素材数量检查
  if (session.media.length + newMedia.length > MAX_MEDIA) {
    await sendMessage(
      chatId,
      `⚠️ 素材总数不能超过 <b>${MAX_MEDIA}</b> 个。当前已有 ${session.media.length} 个，无法追加 ${newMedia.length} 个。`,
      undefined,
      env
    );
    return;
  }

  // 合并
  session.media.push(...newMedia);
  session.lastActivity = Date.now();
  session.messageIds.push(msg.message_id);
  await saveSession(chatId, session, env);

  await sendMessage(
    chatId,
    `📎 已追加 ${newMedia.length} 个素材（共 ${session.media.length} 个）。`
    + '\n你可以继续发送素材，或点击下方按钮选择操作：',
    buildTypeKeyboard(),
    env
  );
}

/**
 * 处理补充文案输入
 */
async function handleCaptionInput(chatId, text, session, env) {
  if (!text) {
    await sendMessage(chatId, '⚠️ 请发送文字作为投稿文案：', undefined, env);
    return;
  }

  // 追加文案
  if (session.text) {
    session.text += '\n' + text;
  } else {
    session.text = text;
  }
  session.lastActivity = Date.now();

  // 直接转发（补充文案后不再问"无需文案"）
  await saveSession(chatId, session, env);
  await forward(chatId, env);
}

// ============================================================
// 按钮显示
// ============================================================

/**
 * 显示"匿名投稿 / 实名投稿"按钮
 */
async function showTypeButtons(chatId, env) {
  const text = '请选择投稿方式：';
  const sent = await sendMessage(chatId, text, buildTypeKeyboard(), env);
  // 更新 session 中的 messageIds（用于后续清理）
  const session = await getSession(chatId, env);
  if (session && sent.result) {
    session.messageIds.push(sent.result.message_id);
    await saveSession(chatId, session, env);
  }
}

/**
 * 显示"无需文案 / 补充文案"按钮
 */
async function showCaptionButtons(chatId, env) {
  const sent = await sendMessage(chatId, '是否需要补充文案？', buildCaptionKeyboard(), env);
  const session = await getSession(chatId, env);
  if (session && sent.result) {
    session.messageIds.push(sent.result.message_id);
    await saveSession(chatId, session, env);
  }
}

/**
 * 显示"确认发送 / 取消"按钮（多图投稿预览确认）
 */
async function showConfirmButtons(chatId, env) {
  const session = await getSession(chatId, env);
  if (!session) return;

  const anonLabel = session.isAnonymous ? '🙈 匿名' : '👤 实名';
  const mediaCount = session.media.length;
  const captionPreview = session.text
    ? (session.text.length > 100 ? session.text.slice(0, 100) + '...' : session.text)
    : '（无）';

  const previewText = `<b>📋 投稿预览</b>\n\n`
    + `类型：${anonLabel}\n`
    + `素材：${mediaCount} 个\n`
    + `文案：${captionPreview}\n\n`
    + '确认发送到频道？';

  session.state = STATE.AWAITING_CONFIRM;
  await saveSession(chatId, session, env);

  const sent = await sendMessage(chatId, previewText, buildConfirmKeyboard(), env);
  if (session && sent.result) {
    session.messageIds.push(sent.result.message_id);
    await saveSession(chatId, session, env);
  }
}

// ============================================================
// Inline Keyboard 构建
// ============================================================

function buildTypeKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🙈 匿名投稿', callback_data: CB.ANON_YES },
        { text: '👤 实名投稿', callback_data: CB.ANON_NO },
      ],
      [
        { text: '❌ 取消投稿', callback_data: CB.CANCEL },
      ],
    ],
  };
}

function buildCaptionKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ 无需文案', callback_data: CB.CAPTION_NO },
        { text: '✏️ 补充文案', callback_data: CB.CAPTION_YES },
      ],
      [
        { text: '❌ 取消投稿', callback_data: CB.CANCEL },
      ],
    ],
  };
}

function buildConfirmKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '✅ 确认发送', callback_data: CB.CONFIRM_SEND },
        { text: '❌ 取消', callback_data: CB.CANCEL },
      ],
    ],
  };
}

/**
 * 取消投稿 — 清理会话并通知用户
 */
async function handleCancel(chatId, env) {
  await deleteSession(chatId, env);
  await sendMessage(chatId, '🚫 投稿已取消。发送 /start 重新开始。', undefined, env);
}

/**
 * 处理投稿者通过回复按钮发送的回复
 * @param {number} chatId
 * @param {string} text - 回复文本
 * @param {object} replyCtx - { channelMsgId, commentMsgId, replyChatId? }
 * @param {object} env
 */
async function handleReplyMessage(chatId, text, replyCtx, env) {
  // 发送回复到评论所在的 chat（讨论组或频道），引用评论消息
  const targetChatId = replyCtx.replyChatId || env.CHANNEL_ID;
  await sendMessage(targetChatId, text, undefined, env, replyCtx.commentMsgId);

  // 清理回复上下文
  await deleteReplyContext(chatId, env);

  // 通知投稿者
  await sendMessage(chatId, '✅ 回复已发送到频道。', undefined, env);
}

// [EXTENSION] 白名单检查:
// async function checkWhitelist(userId, env) { ... }

// [EXTENSION] 关键词过滤:
// async function filterKeywords(text, env) { ... }

// [EXTENSION] 人工审核:
// async function submitForReview(post, env) { ... }
