// ============================================================
// 认证模块 — 密码验证 + Cookie HMAC 签发/校验
// ============================================================

import { AUTH_TTL } from '../utils/constants.js';

/**
 * 验证前端提交的密码
 * @param {string} submitted - 用户提交的密码
 * @param {object} env - Worker 环境变量
 * @returns {boolean}
 */
export function verifyPassword(submitted, env) {
  return submitted === env.ACCESS_PASSWORD;
}

/**
 * 将 ArrayBuffer 转为 hex 字符串
 * @param {ArrayBuffer} buffer
 * @returns {string}
 */
function bufferToHex(buffer) {
  return Array.from(new Uint8Array(buffer))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * 生成认证 Token
 * 格式：HMAC-SHA256(timestamp, WEBHOOK_SECRET).timestamp
 * @param {object} env
 * @returns {Promise<string>}
 */
export async function generateAuthToken(env) {
  const timestamp = Math.floor(Date.now() / 1000);
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(String(timestamp))
  );
  return `${bufferToHex(signature)}.${timestamp}`;
}

/**
 * 验证认证 Token
 * @param {string} token - 格式 "hmacHex.timestamp"
 * @param {object} env
 * @returns {Promise<boolean>}
 */
export async function verifyAuthToken(token, env) {
  if (!token || !token.includes('.')) return false;

  const [sigHex, timestampStr] = token.split('.');
  const timestamp = parseInt(timestampStr, 10);
  if (isNaN(timestamp)) return false;

  // 检查是否过期（24h）
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > AUTH_TTL) return false;

  // 重新计算 HMAC 比对
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(env.WEBHOOK_SECRET),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signature = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(timestampStr)
  );
  const expectedHex = bufferToHex(signature);

  // 常数时间比对（防时序攻击）
  if (sigHex.length !== expectedHex.length) return false;
  let diff = 0;
  for (let i = 0; i < sigHex.length; i++) {
    diff |= sigHex.charCodeAt(i) ^ expectedHex.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * 从请求 Cookie 中提取指定值
 * @param {Request} request
 * @param {string} name
 * @returns {string|null}
 */
export function extractCookie(request, name) {
  const cookieHeader = request.headers.get('Cookie') || '';
  const cookies = cookieHeader.split(';');
  for (const c of cookies) {
    const [key, ...rest] = c.trim().split('=');
    if (key === name) {
      return rest.join('='); // value 中可能含 =
    }
  }
  return null;
}

/**
 * 设置认证 Cookie（返回 Set-Cookie header 值）
 * @param {string} token
 * @returns {string}
 */
export function setAuthCookie(token) {
  const maxAge = `Max-Age=${AUTH_TTL}`;
  return `auth=${token}; ${maxAge}; HttpOnly; Secure; SameSite=Strict; Path=/`;
}
