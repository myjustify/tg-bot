// ============================================================
// 常量定义 — 所有魔法数字和字符串集中管理
// ============================================================

/** KV Key 前缀 */
export const KV_PREFIX = {
  TEMP: 'temp:',
  POST: 'post:',
  MSGMAP: 'msgmap:',
  REPLY: 'reply:',
};

/** 会话状态 */
export const STATE = {
  READY: 'READY',
  AWAITING_TYPE: 'AWAITING_TYPE',
  AWAITING_CAPTION: 'AWAITING_CAPTION',
};

/** 素材数量上限（Telegram media group 限制） */
export const MAX_MEDIA = 9;

/** 会话超时（秒） — 15 分钟 */
export const SESSION_TTL = 900;

/** 登录 Cookie 有效期（秒） — 24 小时 */
export const AUTH_TTL = 86400;

/** 前端展示天数 */
export const POST_DAYS = 7;

/** Callback 数据前缀 */
export const CB = {
  ANON_YES: 'anon_yes',
  ANON_NO: 'anon_no',
  CAPTION_NO: 'caption_no',
  CAPTION_YES: 'caption_yes',
  CANCEL: 'cancel',
  REPLY: 'reply',
};
