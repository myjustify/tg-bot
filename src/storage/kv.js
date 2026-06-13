// ============================================================
// KV 存储封装 — 统一管理 temp / post / msgmap 读写
// ============================================================

import { KV_PREFIX, SESSION_TTL, POST_DAYS } from '../utils/constants.js';

// -----------------------------------------------------------
// 临时会话（temp:）
// -----------------------------------------------------------

/**
 * 读取用户会话
 * @param {number} chatId
 * @param {object} env - Worker env（含 KV binding）
 * @returns {Promise<object|null>} 会话数据或 null
 */
export async function getSession(chatId, env) {
  try {
    const raw = await env.KV.get(KV_PREFIX.TEMP + chatId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('getSession error:', e);
    return null;
  }
}

/**
 * 保存用户会话
 * @param {number} chatId
 * @param {object} data
 * @param {object} env
 */
export async function saveSession(chatId, data, env) {
  try {
    // 不含 TTL — 超时由 Cron 定时任务管理
    await env.KV.put(KV_PREFIX.TEMP + chatId, JSON.stringify(data));
  } catch (e) {
    console.error('saveSession error:', e);
  }
}

/**
 * 删除用户会话
 * @param {number} chatId
 * @param {object} env
 */
export async function deleteSession(chatId, env) {
  try {
    await env.KV.delete(KV_PREFIX.TEMP + chatId);
  } catch (e) {
    console.error('deleteSession error:', e);
  }
}

// -----------------------------------------------------------
// 永久投稿（post:）
// -----------------------------------------------------------

/**
 * 保存投稿记录
 * @param {object} record - { userId, username, isAnonymous, caption, media[], mediaCount, timestamp }
 * @param {object} env
 */
export async function savePost(record, env) {
  try {
    const now = Date.now();
    const key = `${KV_PREFIX.POST}${now}_${record.userId}`;
    record.timestamp = now;
    await env.KV.put(key, JSON.stringify(record));
  } catch (e) {
    console.error('savePost error:', e);
  }
}

/**
 * 列出近 N 天投稿（倒序）
 * @param {number} days - 天数
 * @param {object} env
 * @returns {Promise<Array<object>>}
 */
export async function listPosts(days, env) {
  try {
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const posts = [];
    let cursor;

    do {
      const list = await env.KV.list({ prefix: KV_PREFIX.POST, cursor });
      for (const key of list.keys) {
        try {
          const raw = await env.KV.get(key.name);
          if (!raw) continue;
          const post = JSON.parse(raw);
          if (post.timestamp >= cutoff) {
            post._key = key.name; // 附加 KV key 便于前端删除操作
            posts.push(post);
          }
        } catch (parseErr) {
          console.error('listPosts: corrupted entry', key.name, parseErr);
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    // 按时间戳倒序排列
    posts.sort((a, b) => b.timestamp - a.timestamp);
    return posts;
  } catch (e) {
    console.error('listPosts error:', e);
    return [];
  }
}

// -----------------------------------------------------------
// 消息映射（msgmap:）— 管理员回复用
// -----------------------------------------------------------

/**
 * 保存频道消息 → 投稿人映射
 * @param {number} channelMsgId - 频道中的 message_id
 * @param {number} userId - 投稿人 chat_id
 * @param {string} username - 投稿人用户名
 * @param {object} env
 */
export async function saveMsgMapping(channelMsgId, userId, username, env) {
  try {
    const data = JSON.stringify({ userId, username, timestamp: Date.now() });
    // 保留 90 天，足够覆盖管理员回复窗口
    await env.KV.put(KV_PREFIX.MSGMAP + channelMsgId, data, {
      expirationTtl: 90 * 24 * 3600,
    });
  } catch (e) {
    console.error('saveMsgMapping error:', e);
  }
}

/**
 * 根据频道消息 ID 查找投稿人
 * @param {number} channelMsgId
 * @param {object} env
 * @returns {Promise<object|null>} { userId, username }
 */
export async function getMsgMapping(channelMsgId, env) {
  try {
    const raw = await env.KV.get(KV_PREFIX.MSGMAP + channelMsgId);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (e) {
    console.error('getMsgMapping error:', e);
    return null;
  }
}

// -----------------------------------------------------------
// 单条查询
// -----------------------------------------------------------

/**
 * 读取单条投稿记录
 * @param {string} key - KV key
 * @param {object} env
 * @returns {Promise<object|null>}
 */
export async function getPost(key, env) {
  try {
    const raw = await env.KV.get(key);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('getPost error:', e);
    return null;
  }
}

// -----------------------------------------------------------
// 删除操作
// -----------------------------------------------------------

/**
 * 删除投稿记录
 * @param {string} key - KV key（如 post:1234567890_123456）
 * @param {object} env
 */
export async function deletePost(key, env) {
  try {
    await env.KV.delete(key);
  } catch (e) {
    console.error('deletePost error:', e);
  }
}

// -----------------------------------------------------------
// 回复上下文（reply:）— 评论转发后供投稿者回复用
// -----------------------------------------------------------

/**
 * 保存回复上下文
 * @param {number} chatId - 投稿者 chat_id
 * @param {object} data - { channelMsgId, commentMsgId }
 * @param {object} env
 */
export async function saveReplyContext(chatId, data, env) {
  try {
    await env.KV.put(KV_PREFIX.REPLY + chatId, JSON.stringify({
      ...data,
      timestamp: Date.now(),
    }));
  } catch (e) {
    console.error('saveReplyContext error:', e);
  }
}

/**
 * 读取回复上下文
 * @param {number} chatId
 * @param {object} env
 * @returns {Promise<object|null>}
 */
export async function getReplyContext(chatId, env) {
  try {
    const raw = await env.KV.get(KV_PREFIX.REPLY + chatId);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    console.error('getReplyContext error:', e);
    return null;
  }
}

/**
 * 删除回复上下文
 * @param {number} chatId
 * @param {object} env
 */
export async function deleteReplyContext(chatId, env) {
  try {
    await env.KV.delete(KV_PREFIX.REPLY + chatId);
  } catch (e) {
    console.error('deleteReplyContext error:', e);
  }
}

// -----------------------------------------------------------
// 超时会话查询（Cron 用）
// -----------------------------------------------------------

/**
 * 列出所有已过期的会话
 * @param {object} env
 * @returns {Promise<Array<{chatId: number, session: object}>>}
 */
export async function listExpiredSessions(env) {
  try {
    const now = Date.now();
    const expired = [];
    let cursor;

    do {
      const list = await env.KV.list({ prefix: KV_PREFIX.TEMP, cursor });
      for (const key of list.keys) {
        try {
          const raw = await env.KV.get(key.name);
          if (!raw) continue;
          const session = JSON.parse(raw);
          const elapsed = now - (session.lastActivity || 0);
          if (elapsed > SESSION_TTL * 1000) {
            // 从 key 名提取 chatId（temp:123456 → 123456）
            const chatId = parseInt(key.name.slice(KV_PREFIX.TEMP.length), 10);
            if (!isNaN(chatId)) {
              expired.push({ chatId, session });
            }
          }
        } catch (parseErr) {
          console.error('listExpiredSessions: corrupted entry', key.name, parseErr);
        }
      }
      cursor = list.list_complete ? undefined : list.cursor;
    } while (cursor);

    return expired;
  } catch (e) {
    console.error('listExpiredSessions error:', e);
    return [];
  }
}
