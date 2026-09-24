/**
 * 云开发配置
 */

/**
 * 云开发环境 ID
 * ★ 从微信开发者工具「云开发」控制台获取
 * ★ 该 ID 不是密钥，可安全提交（真正的权限由云函数与集合权限控制）
 */
export const CLOUD_ENV_ID = 'war11393-d3ghsd3zcc6dd0426';

/** 云函数名常量（避免各处手写字符串拼错） */
export const CLOUD_FN = {
  USER: 'user',
  INGREDIENT: 'ingredient',
  RECIPE: 'recipe',
  RECIPE_SYNC: 'recipe-sync',
  AI_TEXT: 'ai-text',
  AI_IMAGE: 'ai-image',
  DB_INIT: 'db-init',
} as const;

/** 云函数业务错误码 */
export const CLOUD_CODE = {
  UNAUTHORIZED: 'UNAUTHORIZED',
  INVALID_PARAM: 'INVALID_PARAM',
  INVALID_ACTION: 'INVALID_ACTION',
  NOT_FOUND: 'NOT_FOUND',
  CLOUD_UNAVAILABLE: 'CLOUD_UNAVAILABLE',
  NETWORK_ERROR: 'NETWORK_ERROR',
  BAD_RESPONSE: 'BAD_RESPONSE',
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  AI_NOT_CONFIGURED: 'AI_NOT_CONFIGURED',
  IMAGE_GEN_FAILED: 'IMAGE_GEN_FAILED',
} as const;
