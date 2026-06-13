// ============================================================
// 转发器 — 将素材/文字发送到频道并通知用户
// ============================================================

import { getSession, deleteSession, saveSession, savePost, saveMsgMapping } from '../storage/kv.js';
import { sendMessage, copyMessage, sendMediaGroup, buildMediaGroup } from '../utils/telegram.js';
import { STATE } from '../utils/constants.js';

/**
 * 执行转发投稿
 * @param {number} chatId - 投稿人 chat_id
 * @param {object} env
 * @param {boolean} [isTimedOut=false] - 是否因超时自动触发
 */
export async function forward(chatId, env, isTimedOut = false) {
  const session = await getSession(chatId, env);
  if (!session) {
    // 超时场景下会话已被清理则静默跳过
    if (!isTimedOut) {
      await sendMessage(chatId, '⚠️ 会话已过期，请重新发送素材。', undefined, env);
    }
    return;
  }

  // 空会话保护（无素材无文字）
  if (session.media.length === 0 && !session.text) {
    await deleteSession(chatId, env);
    return;
  }

  // 超时自动匿名
  const isAnonymous = isTimedOut ? true : session.isAnonymous;
  const channelId = env.CHANNEL_ID;
  const username = isAnonymous ? null : (session.username || null);

  try {
    // 构造投稿人标注
    const attribution = buildAttribution(isAnonymous, username, session.firstName);

    // 场景 1：纯文字
    if (session.media.length === 0 && session.text) {
      const caption = session.text + attribution;
      const sent = await sendMessage(channelId, caption, undefined, env);
      if (!sent.ok) {
        await sendMessage(chatId, `❌ 投稿失败：${sent.description || '未知错误'}`, undefined, env);
        await deleteSession(chatId, env);
        return;
      }
      if (sent.result) {
        await saveRecordAndNotify(chatId, sent.result, session, isAnonymous, username, channelId, env, isTimedOut);
      }
    }
    // 场景 2：单媒体
    else if (session.media.length === 1) {
      // copyMessage 无法加 caption，所以用 sendMediaGroup（单元素）或 copyMessage + 编辑
      if (session.text) {
        // 有文案：用 sendMediaGroup 发单媒体 + caption
        const media = buildMediaGroup(session.media, session.text + attribution);
        const sent = await sendMediaGroup(channelId, media, env);
        if (!sent.ok) {
          await sendMessage(chatId, `❌ 投稿失败：${sent.description || '未知错误'}`, undefined, env);
          await deleteSession(chatId, env);
          return;
        }
        if (sent.result && sent.result.length > 0) {
          await saveRecordAndNotify(chatId, sent.result[0], session, isAnonymous, username, channelId, env, isTimedOut);
        }
      } else {
        // 无文案：直接 copyMessage 到频道
        const srcChatId = chatId;
        const srcMsgId = session.messageIds[0];
        const sent = await copyMessage(channelId, srcChatId, srcMsgId, env);
        if (!sent.ok) {
          await sendMessage(chatId, `❌ 投稿失败：${sent.description || '未知错误'}`, undefined, env);
          await deleteSession(chatId, env);
          return;
        }
        if (sent.result) {
          // 附加投稿人标注
          const attrMsg = await sendMessage(channelId, attribution.trim(), undefined, env);
          const extraMsgId = attrMsg.result ? attrMsg.result.message_id : null;
          await saveRecordAndNotify(chatId, sent.result, session, isAnonymous, username, channelId, env, isTimedOut, extraMsgId);
        }
      }
    }
    // 场景 3：多媒体
    else {
      const caption = session.text ? session.text + attribution : attribution;
      const media = buildMediaGroup(session.media, caption);
      const sent = await sendMediaGroup(channelId, media, env);
      if (!sent.ok) {
        await sendMessage(chatId, `❌ 投稿失败：${sent.description || '未知错误'}`, undefined, env);
        await deleteSession(chatId, env);
        return;
      }
      if (sent.result && sent.result.length > 0) {
        await saveRecordAndNotify(chatId, sent.result[0], session, isAnonymous, username, channelId, env, isTimedOut);
      }
    }
  } catch (e) {
    console.error('forward error:', e);
    await sendMessage(chatId, '❌ 投稿失败，请稍后重试。', undefined, env);
  }

  // 清理临时会话并自动创建新会话（无需重新 /start）
  await deleteSession(chatId, env);
  await saveSession(chatId, {
    state: STATE.READY,
    lastActivity: Date.now(),
  }, env);
}

// ============================================================
// 辅助函数
// ============================================================

/**
 * 保存投稿记录 + msgmap + 私聊通知用户
 */
async function saveRecordAndNotify(
  chatId,
  sentMsg,
  session,
  isAnonymous,
  username,
  channelId,
  env,
  isTimedOut,
  extraMsgId = null
) {
  // 保存永久记录
  await savePost(
    {
      userId: chatId,
      username: username || '',
      firstName: session.firstName || '',
      lastName: session.lastName || '',
      isAnonymous,
      caption: session.text,
      media: session.media.map((m) => ({ type: m.type, file_id: m.file_id })),
      mediaCount: session.media.length || (session.text ? 1 : 0),
      channelMsgId: sentMsg.message_id || null,
      extraMsgIds: extraMsgId ? [extraMsgId] : [],
    },
    env
  );

  // 保存消息映射（管理员回复用）
  // sendMediaGroup 返回的是数组；单条消息返回的是 message_id
  const channelMsgId = sentMsg.message_id;
  if (channelMsgId) {
    await saveMsgMapping(channelMsgId, chatId, username || '', env);
  }

  // 私聊通知用户
  let notifyText;
  if (isTimedOut) {
    notifyText = '⏰ 你的投稿因 15 分钟无操作已自动以<b>匿名</b>方式发送到频道。';
  } else if (isAnonymous) {
    notifyText = '✅ 你的投稿已匿名发送到频道！';
  } else {
    notifyText = `✅ 你的投稿已实名发送到频道！\n📮 署名：@${username}`;
  }
  notifyText += '\n💡 你可以继续发送素材进行下一次投稿。';
  await sendMessage(chatId, notifyText, undefined, env);
}

/**
 * 构造投稿人标注文本
 */
function buildAttribution(isAnonymous, username, firstName) {
  if (isAnonymous) {
    return '\n\n📮 <i>匿名投稿</i>';
  }
  if (username) {
    // TG HTML parse_mode 会自动将 @username 转为可点击链接
    return `\n\n📮 来自 @${username}`;
  }
  if (firstName) {
    return `\n\n📮 来自 ${firstName}`;
  }
  return '\n\n📮 <i>实名投稿</i>';
}

