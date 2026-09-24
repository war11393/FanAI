/**
 * 云函数：user —— 用户档案读写
 * ---------------------------------------------------------------
 * 【安全模型】openid 一律从 cloud.getWXContext() 获取，**绝不信任前端传入**。
 *            前端即使伪造 event.openid 也无效。
 *
 * 【对应原后端接口】
 *   GET  /api/users/:openid              -> action: 'get'
 *   POST /api/users/upsert               -> action: 'upsert'
 */

const { db, wrap, ok, requireFields, BizError } = require('./common');
const { COLLECTIONS, DEFAULT_PROFILE } = require('./schema');

const USERS = () => db.collection(COLLECTIONS.USERS);

/** 取用户档案，不存在则按默认值创建 */
async function getOrCreate(openid) {
  const { data } = await USERS().where({ openid }).limit(1).get();
  if (data && data.length > 0) return data[0];

  const row = DEFAULT_PROFILE(openid);
  const res = await USERS().add({
    data: { ...row, createdAt: db.serverDate(), updatedAt: db.serverDate() },
  });
  const created = await USERS().doc(res._id).get();
  return created.data;
}

/** 允许前端更新的字段白名单（防止越权改 openid / _id） */
const UPDATABLE_FIELDS = [
  'familyId',
  'regularMembers',
  'stoves',
  'pots',
  'allergies',
  'taboos',
  'flavors',
  'voiceControlOn',
];

exports.main = wrap(async (event) => {
  const action = event && event.action;
  const openid = requireOpenid();

  if (action === 'get') {
    const user = await getOrCreate(openid);
    return ok(user);
  }

  if (action === 'upsert') {
    const profile = event.profile || {};
    const existing = await getOrCreate(openid);

    const patch = {};
    for (const key of UPDATABLE_FIELDS) {
      if (profile[key] !== undefined) patch[key] = profile[key];
    }
    if (Object.keys(patch).length === 0) {
      throw new BizError('INVALID_PARAM', '没有可更新的字段');
    }
    patch.updatedAt = db.serverDate();

    await USERS().doc(existing._id).update({ data: patch });
    const updated = await USERS().doc(existing._id).get();
    return ok(updated.data);
  }

  throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
});

/** 单独抽出来，保证每次调用都做 openid 校验 */
function requireOpenid() {
  // 延迟 require 避免循环依赖问题，同时保持 common.getOpenid 单一实现
  const { getOpenid } = require('./common');
  return getOpenid();
}
