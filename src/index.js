// ============================================================
// TG Bot Worker — 入口 + 路由分发
// ============================================================

import { handleWebhook } from './bot/handler.js';
import { forward } from './bot/forwarder.js';
import { renderPage, renderPasswordError } from './frontend/render.js';
import { handleApiPosts } from './api/posts.js';
import { verifyPassword, generateAuthToken, setAuthCookie, extractCookie, verifyAuthToken } from './auth/auth.js';
import { listExpiredSessions, deletePost, getPost } from './storage/kv.js';
import { getFile, deleteMessage } from './utils/telegram.js';


export default {
  /**
   * Worker fetch 入口（HTTP 请求）
   */
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;

    // ---- 路由分发 ----
    try {
      // POST /webhook — TG Bot
      if (method === 'POST' && path === '/webhook') {
        return await handleWebhook(request, env);
      }

      // GET /api/posts — 数据 API（Cookie 鉴权）
      if (method === 'GET' && path === '/api/posts') {
        return await handleApiPosts(request, env);
      }

      // GET /api/image — 图片代理（Cookie 鉴权）
      if (method === 'GET' && path === '/api/image') {
        return await handleImageProxy(request, env);
      }

      // POST /api/delete — 删除投稿（Cookie 鉴权）
      if (method === 'POST' && path === '/api/delete') {
        return await handleDelete(request, env);
      }

      // POST / — 密码验证
      if (method === 'POST' && path === '/') {
        return await handleLogin(request, env);
      }

      // GET / — 前端页面
      if (method === 'GET' && path === '/') {
        return await renderPage(request, env);
      }

      // 其他 — 404
      return new Response('Not Found', { status: 404 });
    } catch (err) {
      console.error('Unhandled error:', err);
      return new Response('Internal Server Error', { status: 500 });
    }
  },

  /**
   * Cron 定时任务（每 5 分钟处理超时会话）
   */
  async scheduled(event, env, ctx) {
    try {
      const expired = await listExpiredSessions(env);
      if (expired.length > 0) {
        // 并发处理超时会话
        await Promise.all(expired.map(({ chatId }) => forward(chatId, env, true)));
        console.log(`[Cron] Processed ${expired.length} expired sessions`);
      }
    } catch (e) {
      console.error('[Cron] Error:', e);
      throw e;
    }
  },
};

/**
 * 处理密码登录 POST
 * @param {Request} request
 * @param {object} env
 */
async function handleLogin(request, env) {
  let password;
  try {
    const formData = await request.formData();
    password = formData.get('password') || '';
  } catch {
    password = '';
  }

  if (!verifyPassword(password, env)) {
    return renderPasswordError('密码错误，请重试');
  }

  // 密码正确 → 签发 Token → 302 重定向到 /
  const token = await generateAuthToken(env);
  const cookieHeader = setAuthCookie(token);

  return new Response(null, {
    status: 302,
    headers: {
      'Location': '/',
      'Set-Cookie': cookieHeader,
    },
  });
}

/**
 * 图片代理 — 通过 Worker 端代理 TG 图片，避免 bot token 泄露
 * GET /api/image?file_id=xxx
 */
async function handleImageProxy(request, env) {
  // Cookie 鉴权
  const token = extractCookie(request, 'auth');
  if (!token || !(await verifyAuthToken(token, env))) {
    return new Response('Unauthorized', { status: 401 });
  }

  const url = new URL(request.url);
  const fileId = url.searchParams.get('file_id');
  if (!fileId) {
    return new Response('Missing file_id', { status: 400 });
  }

  try {
    // 调用 getFile 获取 file_path
    const fileRes = await getFile(fileId, env);
    if (!fileRes.ok || !fileRes.result || !fileRes.result.file_path) {
      console.error('getFile failed:', fileRes);
      return new Response('File not found', { status: 404 });
    }

    // 从 TG 下载文件
    const fileUrl = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${fileRes.result.file_path}`;
    const imageRes = await fetch(fileUrl);
    if (!imageRes.ok) {
      return new Response('Failed to fetch file', { status: 502 });
    }

    // 返回图片（带缓存）
    const headers = new Headers();
    const contentType = imageRes.headers.get('Content-Type') || 'image/jpeg';
    headers.set('Content-Type', contentType);
    headers.set('Content-Disposition', 'inline');
    headers.set('Cache-Control', 'public, max-age=3600');

    return new Response(imageRes.body, {
      status: 200,
      headers,
    });
  } catch (e) {
    console.error('handleImageProxy error:', e);
    return new Response('Internal Server Error', { status: 500 });
  }
}

/**
 * 删除投稿
 * POST /api/delete  body: { key: "post:xxx_xxx" }
 */
async function handleDelete(request, env) {
  // Cookie 鉴权
  const token = extractCookie(request, 'auth');
  if (!token || !(await verifyAuthToken(token, env))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const key = body.key;
  if (!key || typeof key !== 'string' || !key.startsWith('post:')) {
    return new Response(JSON.stringify({ error: 'Invalid key' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // 先读取 post 记录，尝试同步删除频道消息
  const post = await getPost(key, env);
  if (post && post.channelMsgId) {
    try {
      await deleteMessage(env.CHANNEL_ID, post.channelMsgId, env);
      // 删除附属消息（如匿名投稿标注）
      if (post.extraMsgIds && post.extraMsgIds.length > 0) {
        for (const msgId of post.extraMsgIds) {
          await deleteMessage(env.CHANNEL_ID, msgId, env);
        }
      }
    } catch (e) {
      console.error('deleteMessage failed:', e);
      // 频道删除失败不阻塞 KV 删除
    }
  }

  // 同步清理 msgmap 映射（防止孤立的频道消息→用户映射）
  if (post && post.channelMsgId) {
    try {
      await env.KV.delete('msgmap:' + post.channelMsgId);
    } catch (e) {
      console.error('handleDelete: failed to delete msgmap', e);
    }
  }

  await deletePost(key, env);

  return new Response(JSON.stringify({ ok: true }), {
    headers: { 'Content-Type': 'application/json' },
  });
}
