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

/**
 * 单位白名单 + 归一化（★ 用户要求：单位可选，但入库时归一化）
 * ---------------------------------------------------------------
 * 前端下拉可选，但用户也可能传来任意值（旧数据/接口直调），
 * 故入库统一走这里：kg→g、L→ml、未知→按品类推断兜底。
 */
const ALLOWED_UNITS = ['g', 'kg', '斤', '个', 'ml', 'L', '份', '把', '棵', '包', '盒'];

const UNIT_HINTS = [
  { re: /肉|排骨|鱼|虾|鸡|鸭|牛|羊|豆腐|蛤|蟹/, unit: 'g' },
  { re: /蛋/, unit: '个' },
  { re: /奶|酱|醋|酒|汁/, unit: 'ml' },
  { re: /米|面|粉|糖|盐|豆|花生|干|木耳|香菇|枣/, unit: 'g' },
  { re: /菜|葱|姜|蒜|椒|瓜|茄|萝卜|薯|笋|菇|苗|叶|芦|芹|韭/, unit: '斤' },
  { re: /果|橙|苹果|梨|桃|香蕉|葡萄|莓/, unit: '个' },
];

function guessUnitByName(name) {
  const n = String(name || '');
  for (const h of UNIT_HINTS) if (h.re.test(n)) return h.unit;
  return '份';
}

/** 归一化单位：非法值按食材名推断；kg→g、L→ml 统一量纲 */
function normalizeUnit(unit, name) {
  const u = String(unit || '').trim();
  if (!ALLOWED_UNITS.includes(u)) return guessUnitByName(name);
  if (u === 'kg') return 'g';
  if (u === 'L') return 'ml';
  return u;
}

/** 归一化数量：配合单位换算（kg→g 时数量 ×1000） */
function normalizeQuantity(quantity, unit) {
  const q = Number(quantity);
  const n = Number.isFinite(q) && q > 0 ? q : 1;
  if (String(unit || '').trim() === 'kg') return n * 1000;
  if (String(unit || '').trim() === 'L') return n * 1000;
  return n;
}

/**
 * 把数量从一个单位换算到另一个单位
 * ★ 只在"同类量纲"之间换算（g↔斤），跨量纲（g↔个）无法换算则**放弃累加**
 *   返回 0 —— 宁可只保留新值也不要把 500g 加到 3 个上。
 */
function convertUnit(qty, from, to, name) {
  if (from === to) return qty;
  const WEIGHT = { g: 1, 斤: 500 };
  const VOLUME = { ml: 1 };
  if (WEIGHT[from] && WEIGHT[to]) return (qty * WEIGHT[from]) / WEIGHT[to];
  if (VOLUME[from] && VOLUME[to]) return (qty * VOLUME[from]) / VOLUME[to];
  // 跨量纲（如 个 ↔ g）无法换算：记录 warn，返回 0 由调用方决定策略
  console.warn(`[ingredient] 单位跨量纲无法换算 ${from}->${to}（${name}），本次不累加`);
  return 0;
}

/** 数量取整：整数保持整数，小数保留两位，避免 0.6666666 */
function roundQty(n) {
  const v = Number(n) || 0;
  return Number.isInteger(v) ? v : Math.round(v * 100) / 100;
}

/** 规范化一条食材的写入数据 */
function buildRow(openid, input, addTime) {
  const expire = resolveExpireTime(input, addTime);
  return {
    openid,
    name: input.name,
    icon: input.icon || '',
    quantity: normalizeQuantity(input.quantity ?? 1, input.unit),
    unit: normalizeUnit(input.unit, input.name),
    addTime: addTime.toISOString(),
    expireTime: expire.toISOString(),
    status: computeStatus(expire.toISOString()),
    source: input.source || 'text',
  };
}

/* ============================================================
 * ★ 同类项合并（用户反馈："西红柿"和"番茄"应合并，不应出现两条）
 * ------------------------------------------------------------
 * 规则：写入前先按「归一名」查该用户是否已有该食材，有则**累加数量**
 * 并合并 source，而不是新增一条。
 * ★ 同义词/归一逻辑见共享模块 ingredient-names.js（与 recipe、ai-text 同源）
 * ============================================================ */

/** 归一化：去括号补充、去空格 */
const { canonicalName: canonicalNameShared } = require('./ingredient-names');

function normalizeName(s) {
  return String(s || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 归一名（用于判重与合并展示；委托共享模块，避免各处漂移） */
function canonicalName(s) {
  return canonicalNameShared(s);
}

/** 归一 source：把两条记录用过的录入途径合并成可展示文案 */
function mergeSource(a, b) {
  const s1 = a || 'text';
  const s2 = b || 'text';
  const set = new Set([...String(s1).split('+'), ...String(s2).split('+')]);
  // 固定顺序输出，便于展示与判重
  const order = ['text', 'photo', 'voice'];
  const ordered = order.filter((x) => set.has(x));
  return ordered.length ? ordered.join('+') : 'text';
}

/**
 * 写入一条食材（★ 同类项合并）
 * @returns {{ row: object, merged: boolean }}
 *   merged=true 表示命中了已有食材并累加，而非新建
 */
async function upsertIngredient(openid, input, addTime) {
  const canonical = canonicalName(input.name);
  if (!canonical) return { row: null, merged: false };

  // 查该用户全部食材（量级小，单次上限内），按归一名匹配
  const { data: existing } = await COL()
    .where({ openid })
    .field({ _id: true, name: true, quantity: true, unit: true, source: true, expireTime: true })
    .limit(PAGE_SIZE)
    .get();

  const hit = (existing || []).find((it) => canonicalName(it.name) === canonical);

  if (hit) {
    // ★ 合并：累加数量、合并 source、按较晚的过期时间取（新买的更新鲜）
    const newExpire = resolveExpireTime(input, addTime).toISOString();
    const expireTime =
      hit.expireTime && new Date(hit.expireTime) > new Date(newExpire) ? hit.expireTime : newExpire;

    // ★ 单位归一后再相加：把新值的单位换算到已有记录的单位上，
    //   否则 "1 斤" + "500 g" 会被算成 501。
    const incomingUnit = normalizeUnit(input.unit, input.name);
    const incomingQty = normalizeQuantity(input.quantity ?? 1, input.unit);
    const sameUnit = incomingUnit === hit.unit;
    const addQty = sameUnit
      ? incomingQty
      : convertUnit(incomingQty, incomingUnit, hit.unit, input.name);

    const patch = {
      quantity: roundQty((Number(hit.quantity) || 0) + addQty),
      source: mergeSource(hit.source, input.source),
      expireTime,
      status: computeStatus(expireTime),
      updatedAt: db.serverDate(),
    };
    await COL().doc(hit._id).update({ data: patch });
    const merged = await COL().doc(hit._id).get();
    return { row: merged.data, merged: true };
  }

  const row = buildRow(openid, input, addTime);
  const res = await COL().add({ data: { ...row, createdAt: db.serverDate() } });
  const created = await COL().doc(res._id).get();
  return { row: created.data, merged: false };
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
      // ★ 同类项合并：同名（含同义词）已存在则累加，不新增
      const { row, merged } = await upsertIngredient(openid, input, addTime);
      return ok({ ...row, merged: !!merged });
    }

    case 'batchAdd': {
      requireFields(event, ['items']);
      const items = event.items;
      if (!Array.isArray(items) || items.length === 0) {
        throw new BizError('INVALID_PARAM', 'items 必须是非空数组');
      }
      const results = [];
      let mergedCount = 0;
      for (const it of items) {
        if (!it || !it.name) continue;
        const addTime = it.addTime ? new Date(it.addTime) : new Date();
        // ★ 同类项合并（批内多条同名也会逐条累加，因为每条都重新查库）
        const { row, merged } = await upsertIngredient(openid, it, addTime);
        if (merged) mergedCount++;
        results.push({ ...row, merged: !!merged });
      }
      return ok({ list: results, count: results.length, merged: mergedCount });
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
