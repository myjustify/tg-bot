// ============================================================
// 数据 API — GET /api/posts
// ============================================================

import { extractCookie, verifyAuthToken } from '../auth/auth.js';
import { listPosts } from '../storage/kv.js';
import { POST_DAYS } from '../utils/constants.js';

/**
 * 处理 API 请求，返回 JSON
 * @param {Request} request
 * @param {object} env
 * @returns {Promise<Response>}
 */
export async function handleApiPosts(request, env) {
  // Cookie 鉴权
  const token = extractCookie(request, 'auth');
  if (!token || !(await verifyAuthToken(token, env))) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const posts = await listPosts(POST_DAYS, env);

  // 返回字段（含 key 用于删除，media 用于图片预览）
  const result = posts.map((p) => ({
    key: p._key || '',
    timestamp: p.timestamp,
    username: p.username || '',
    firstName: p.firstName || '',
    lastName: p.lastName || '',
    isAnonymous: p.isAnonymous,
    caption: p.caption || '',
    mediaCount: p.mediaCount || 0,
    media: p.media || [],
  }));

  return new Response(JSON.stringify(result), {
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    },
  });
}
