/**
 * 云函数公共层：统一初始化、响应信封、错误处理、openid 获取
 * ---------------------------------------------------------------
 * 所有云函数共用本文件（需复制到各云函数目录，或用软链接）。
 * ★ 信封约定：{ success, code, message, data }
 *   前端 src/cloud/ 的 callCloud() 依赖此结构解包。
 */

const cloud = require('wx-server-sdk');

cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV,
  // AI 生成耗时较长（生图 10~30s，开 thinking 最多 +60s）
  timeout: 900000,
});

/** 云开发数据库实例（云函数端为管理员权限，不受集合权限模式限制） */
const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

/**
 * 获取调用方真实 openid（微信认证，前端无法伪造）
 * ★ 这是相对旧 `dev_` 随机数方案的核心安全提升
 */
function getOpenid() {
  const ctx = cloud.getWXContext();
  const openid = ctx.OPENID;
  if (!openid) {
    throw new BizError('UNAUTHORIZED', '无法获取 openid，请在微信小程序环境内调用', 401);
  }
  return openid;
}

/** 业务异常：会被 wrap 统一转成失败信封 */
class BizError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'BizError';
    this.code = code;
    this.status = status;
    // ★ 用 Symbol.hasInstance 免疫多实例问题：
    //   common.js 被 sync-shared 复制到各云函数目录后，模块实例不唯一，
    //   跨目录抛出的 BizError 用 `instanceof` 判断会失败。
    //   这里改为鸭子类型判断，确保 wrap() 始终能正确识别业务异常。
    this.__isBizError = true;
  }

  /** 让 instanceof 对本类及所有"同构"实例都成立 */
  static [Symbol.hasInstance](obj) {
    return !!(obj && obj.__isBizError === true);
  }
}

/**
 * 成功信封
 * ★ 必须带 __isResponse 标记：wrap() 靠它识别「handler 已自行返回信封」，
 *   否则会被 wrap() 再包一层，前端拿到的 data 会是信封而非业务数据。
 */
const ok = (data = null, message = 'ok') => ({
  __isResponse: true,
  success: true,
  code: 200,
  message,
  data,
});

/** 失败信封（同样需要 __isResponse 标记） */
const fail = (code, message, data = null) => ({
  __isResponse: true,
  success: false,
  code,
  message,
  data,
});

/**
 * 云函数入口包装器：统一 try/catch + 信封
 * @param {(event: object, context: object) => Promise<any>} handler
 */
function wrap(handler) {
  return async (event, context) => {
    try {
      const result = await handler(event || {}, context);
      // handler 已返回信封则直接透出（避免双重包装）
      if (result && typeof result === 'object' && '__isResponse' in result) {
        return result;
      }
      return { __isResponse: true, ...ok(result) };
    } catch (err) {
      const isBiz = err instanceof BizError;
      console.error('[cloudfn] error:', err && err.message, err && err.stack);
      return {
        __isResponse: true,
        ...fail(
          isBiz ? err.code : 'INTERNAL_ERROR',
          isBiz ? err.message : (err && err.message) || '服务异常',
        ),
      };
    }
  };
}

/** 断言：必填参数 */
function requireFields(obj, fields) {
  for (const f of fields) {
    const v = obj?.[f];
    if (v === undefined || v === null || v === '') {
      throw new BizError('INVALID_PARAM', `缺少必填参数: ${f}`);
    }
  }
}

module.exports = {
  cloud,
  db,
  _,
  $,
  getOpenid,
  BizError,
  ok,
  fail,
  wrap,
  requireFields,
};
