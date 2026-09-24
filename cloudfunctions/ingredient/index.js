/**
 * 云函数：ingredient —— 食材库存 CRUD + 新鲜度状态机
 * ---------------------------------------------------------------
 * 【对应原后端接口】
 *   GET    /api/ingredients?openid=      -> action: 'list'
 *   POST   /api/ingredients              -> action: 'add'
 *   POST   /api/ingredients/batch        -> action: 'batchAdd'
 *   PUT    /api/ingredients/:id          -> action: 'update'
 *   DELETE /api/ingredients/:id          -> action: 'remove'
 *
 * 【状态机】与原 IngredientsService.computeStatus 完全一致：
 *   expire < now                        -> expired
 *   now <= expire <= now + 24h          -> expiring
 *   expire > now + 24h                  -> fresh
 *
 * 【照片处理】前端先用 Taro.cloud.uploadFile() 传到云存储，
 *            把 fileID 传给 ai-text 云函数做视觉识别；本函数不处理图片。
 */

const { db, _, wrap, ok, requireFields, BizError } = require('./common');
const { COLLECTIONS, INGREDIENT_STATUS } = require('./schema');
const { SHELF_LIFE_DICT } = require('./shelf-life-dict');

const COL = () => db.collection(COLLECTIONS.INGREDIENTS);
const ONE_DAY = 24 * 60 * 60 * 1000;
/** 单次返回上限（云开发单次 get 上限 100 条，超出需分页） */
const PAGE_SIZE = 100;

/** 新鲜度规则引擎（与原后端逐字对齐） */
function computeStatus(expireTime) {
  const expire = new Date(expireTime).getTime();
  const now = Date.now();
  if (expire < now) return INGREDIENT_STATUS.EXPIRED;
  if (expire - now <= ONE_DAY) return INGREDIENT_STATUS.EXPIRING;
  return INGREDIENT_STATUS.FRESH;
}

function lookupShelfLife(name) {
  return SHELF_LIFE_DICT[name];
}

/**
 * 计算过期时间：显式传入优先，否则查保质期字典，最后兜底 3 天
 * ★ 与原后端 add() 逻辑一致
 */
function resolveExpireTime(input, addTime) {
  if (input.expireTime) return new Date(input.expireTime);
  const shelfDays = lookupShelfLife(input.name) ?? input.shelfLifeDays ?? 3;
  return new Date(addTime.getTime() + shelfDays * ONE_DAY);
}

/** 规范化一条食材的写入数据 */
function buildRow(openid, input, addTime) {
  const expire = resolveExpireTime(input, addTime);
  return {
    openid,
    name: input.name,
    icon: input.icon || '',
    quantity: input.quantity ?? 1,
    unit: input.unit || '个',
    addTime: addTime.toISOString(),
    expireTime: expire.toISOString(),
    status: computeStatus(expire.toISOString()),
    source: input.source || 'text',
  };
}

/** 刷新该用户所有食材的新鲜度状态，返回更新条数 */
async function refreshStatuses(openid) {
  const col = COL();
  const { data: list } = await col
    .where({ openid })
    .field({ _id: true, expireTime: true, status: true })
    .limit(PAGE_SIZE)
    .get();

  let updated = 0;
  for (const item of list || []) {
    const status = computeStatus(item.expireTime);
    if (status !== item.status) {
      await col.doc(item._id).update({ data: { status } });
      updated++;
    }
  }
  return updated;
}

/** 取该用户的一条食材（显式带 openid，防越权） */
async function findOwned(openid, id) {
  const { data } = await COL().where({ _id: id, openid }).limit(1).get();
  if (!data || data.length === 0) {
    throw new BizError('NOT_FOUND', '食材不存在', 404);
  }
  return data[0];
}

exports.main = wrap(async (event) => {
  const { getOpenid } = require('./common');
  const openid = getOpenid();
  const action = event.action;

  switch (action) {
    case 'list': {
      const col = COL();
      // 先刷新状态再返回，保证前端拿到的 status 是最新的
      const updated = await refreshStatuses(openid);
      const { data } = await col
        .where({ openid })
        .orderBy('expireTime', 'asc')
        .limit(PAGE_SIZE)
        .get();
      return ok({ list: data || [], refreshed: updated });
    }

    case 'add': {
      requireFields(event, ['input']);
      const input = event.input;
      requireFields(input, ['name']);
      const addTime = input.addTime ? new Date(input.addTime) : new Date();
      const row = buildRow(openid, input, addTime);
      const res = await COL().add({ data: { ...row, createdAt: db.serverDate() } });
      const created = await COL().doc(res._id).get();
      return ok(created.data);
    }

    case 'batchAdd': {
      requireFields(event, ['items']);
      const items = event.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new BizError('INVALID_PARAM', 'items 必须是非空数组');
      }
      const results = [];
      for (const it of items) {
        if (!it || !it.name) continue;
        const addTime = it.addTime ? new Date(it.addTime) : new Date();
        const row = buildRow(openid, it, addTime);
        const res = await COL().add({ data: { ...row, createdAt: db.serverDate() } });
        const created = await COL().doc(res._id).get();
        results.push(created.data);
      }
      return ok({ list: results, count: results.length });
    }

    case 'update': {
      requireFields(event, ['id']);
      const current = await findOwned(openid, event.id);
      const patch = event.patch || {};

      const data = {};
      for (const key of ['name', 'icon', 'quantity', 'unit', 'source']) {
        if (patch[key] !== undefined) data[key] = patch[key];
      }

      const name = patch.name ?? current.name;
      if (patch.expireTime) {
        data.expireTime = new Date(patch.expireTime).toISOString();
        data.status = computeStatus(data.expireTime);
      } else if (patch.name || patch.shelfLifeDays) {
        const shelfDays = lookupShelfLife(name) ?? patch.shelfLifeDays ?? 3;
        const base = current.addTime ? new Date(current.addTime) : new Date();
        const expire = new Date(base.getTime() + shelfDays * ONE_DAY).toISOString();
        data.expireTime = expire;
        data.status = computeStatus(expire);
      }

      if (Object.keys(data).length === 0) {
        throw new BizError('INVALID_PARAM', '没有可更新的字段');
      }
      await COL().doc(current._id).update({ data });
      const updated = await COL().doc(current._id).get();
      return ok(updated.data);
    }

    case 'remove': {
      requireFields(event, ['id']);
      const current = await findOwned(openid, event.id);
      await COL().doc(current._id).remove();
      return ok({ id: event.id, removed: true });
    }

    case 'shelfLife': {
      requireFields(event, ['name']);
      return ok({ days: lookupShelfLife(event.name) ?? null });
    }

    default:
      throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
  }
});
