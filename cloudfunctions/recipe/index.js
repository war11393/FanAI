/**
 * 云函数：recipe —— 菜谱 + 餐饮计划
 * ---------------------------------------------------------------
 * 【对应原后端接口】
 *   GET    /api/recipes?openid=&keyword=    -> action: 'list'
 *   GET    /api/recipes/seed                -> action: 'seed'
 *   POST   /api/recipes                     -> action: 'create'
 *   POST   /api/recipes/from-text           -> action: 'createFromText'
 *   POST   /api/recipes/:id                 -> action: 'update'（原后端用 POST 而非 PUT）
 *   DELETE /api/recipes/:id                 -> action: 'remove'
 *   GET    /api/meal-plans?openid=&status=  -> action: 'listPlans'
 *   POST   /api/meal-plans/save             -> action: 'savePlan'
 *
 * 【可见性规则】★ 关键
 *   公共菜谱：openid 为 null，所有用户可见
 *   私人菜谱：openid 为本人，仅本人可见
 *   查询条件：_.or([{ openid: null }, { openid: <本人> }])
 *   写/删：仅限本人（openid 匹配），防止改到公共菜谱
 */

const { db, _, wrap, ok, requireFields, BizError } = require('./common');
const { COLLECTIONS } = require('./schema');
const { BUILTIN_RECIPES } = require('./builtin-recipes');
const { canonicalName, isBasicSeasoning, canonicalList } = require('./ingredient-names');

const PAGE_SIZE = 100;

const RECIPES = () => db.collection(COLLECTIONS.RECIPES);
const PLANS = () => db.collection(COLLECTIONS.MEAL_PLANS);

/** 菜谱可写字段白名单 */
const RECIPE_FIELDS = [
  'name',
  'category',
  'flavors',
  'ingredients',
  'mainSteps',
  'brief',
  'difficulty',
  'durationMinutes',
];

/** 餐计划可写字段白名单 */
const PLAN_FIELDS = [
  'date',
  'dinersCount',
  'selectedDishes',
  'prepList',
  'cookingSteps',
  'status',
];

/** 可见性条件：公共菜谱 OR 本人菜谱 */
const visibleWhere = (openid, extra = {}) => ({
  ...extra,
  $or: [{ openid: null }, { openid }],
});

/** 取本人拥有的一条菜谱（公共菜谱不可改） */
async function findOwnedRecipe(openid, id) {
  const { data } = await RECIPES().where({ _id: id, openid }).limit(1).get();
  if (!data || data.length === 0) {
    throw new BizError('NOT_FOUND', '菜谱不存在或非本人所有', 404);
  }
  return data[0];
}

/** 关键词匹配：name 或 brief 包含关键词（云数据库用正则） */
function buildKeywordWhere(keyword) {
  if (!keyword) return {};
  const safe = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = db.RegExp({ regexp: safe, options: 'i' });
  return { $or: [{ name: re }, { brief: re }] };
}

/**
 * 菜谱可见性 + 关键词的完整查询条件
 * ★ 云数据库的 $or / $and 嵌套需显式组合，否则会互相覆盖
 */
function buildRecipeQuery(openid, keyword) {
  const visibility = [{ openid: null }, { openid }];
  const kwWhere = buildKeywordWhere(keyword);
  const kwOr = kwWhere.$or;

  if (kwOr) {
    // (公共 OR 本人) AND (name匹配 OR brief匹配)
    return { $and: [{ $or: visibility }, { $or: kwOr }] };
  }
  return { $or: visibility };
}

exports.main = wrap(async (event) => {
  const { getOpenid } = require('./common');
  const openid = getOpenid();
  const action = event.action;

  switch (action) {
    /* ---------------- 菜谱 ---------------- */

    case 'list': {
      const where = buildRecipeQuery(openid, event.keyword);
      const { data } = await RECIPES()
        .where(where)
        .orderBy('updatedAt', 'desc')
        .limit(PAGE_SIZE)
        .get();
      return ok({ list: data || [] });
    }

    case 'seed': {
      // 幂等灌入公共菜谱
      const col = RECIPES();
      let inserted = 0;
      let skipped = 0;
      for (const recipe of BUILTIN_RECIPES) {
        const { data } = await col
          .where({ name: recipe.name, source: 'builtin' })
          .limit(1)
          .get();
        if (data && data.length > 0) {
          skipped++;
          continue;
        }
        await col.add({
          data: {
            openid: null,
            ...recipe,
            source: 'builtin',
            createdAt: db.serverDate(),
            updatedAt: db.serverDate(),
          },
        });
        inserted++;
      }
      return ok({ inserted, skipped, total: BUILTIN_RECIPES.length });
    }

    case 'create': {
      const input = event.recipe || {};
      requireFields(input, ['name']);
      const row = { openid, source: 'user' };
      for (const key of RECIPE_FIELDS) {
        if (input[key] !== undefined) row[key] = input[key];
      }
      if (!row.category) row.category = '家常菜';
      if (!row.flavors) row.flavors = [];
      if (!row.ingredients) row.ingredients = [];
      if (!row.mainSteps) row.mainSteps = [];
      if (!row.difficulty) row.difficulty = '简单';
      if (row.durationMinutes === undefined) row.durationMinutes = 20;

      const res = await RECIPES().add({
        data: { ...row, createdAt: db.serverDate(), updatedAt: db.serverDate() },
      });
      const created = await RECIPES().doc(res._id).get();
      return ok(created.data);
    }

    case 'createFromText': {
      // 前端已通过 ai-text 云函数把自然语言解析成结构化菜谱，这里只负责落库
      const input = event.recipe || {};
      requireFields(input, ['name']);
      const row = { openid, source: 'user' };
      for (const key of RECIPE_FIELDS) {
        if (input[key] !== undefined) row[key] = input[key];
      }
      const res = await RECIPES().add({
        data: { ...row, createdAt: db.serverDate(), updatedAt: db.serverDate() },
      });
      const created = await RECIPES().doc(res._id).get();
      return ok(created.data);
    }

    case 'update': {
      requireFields(event, ['id']);
      const current = await findOwnedRecipe(openid, event.id);
      const patch = event.patch || {};
      const data = {};
      for (const key of RECIPE_FIELDS) {
        if (patch[key] !== undefined) data[key] = patch[key];
      }
      if (Object.keys(data).length === 0) {
        throw new BizError('INVALID_PARAM', '没有可更新的字段');
      }
      data.updatedAt = db.serverDate();
      await RECIPES().doc(current._id).update({ data });
      const updated = await RECIPES().doc(current._id).get();
      return ok(updated.data);
    }

    case 'remove': {
      requireFields(event, ['id']);
      const current = await findOwnedRecipe(openid, event.id);
      await RECIPES().doc(current._id).remove();
      return ok({ id: event.id, removed: true });
    }

    /* ---------------- 餐饮计划 ---------------- */

    case 'listPlans': {
      const where = { openid };
      if (event.status) where.status = event.status;
      const { data } = await PLANS()
        .where(where)
        .orderBy('date', 'desc')
        .limit(PAGE_SIZE)
        .get();
      return ok({ list: data || [] });
    }

    /**
     * ★ 近一周做过的菜（供 recommend prompt 避开重复）
     * 入参：{ action:'recentDishes', days?:7 }
     * 出参：{ dishes: string[] }（去重后的菜名）
     */
    case 'recentDishes': {
      const days = Number(event.days) > 0 ? Number(event.days) : 7;
      const since = new Date(Date.now() - days * 24 * 3600 * 1000).toISOString().slice(0, 10);
      const { data } = await PLANS()
        .where({ openid, date: _.gte(since) })
        .orderBy('date', 'desc')
        .limit(PAGE_SIZE)
        .get();
      const names = new Set();
      for (const plan of data || []) {
        for (const d of plan.selectedDishes || []) {
          const n = d && d.name ? String(d.name).trim() : '';
          if (n) names.add(n);
        }
      }
      return ok({ dishes: Array.from(names), since });
    }

    /**
     * ★ 按现有食材匹配菜谱（供 recommend prompt 给出候选菜名）
     * 入参：{ action:'matchByIngredients', ingredients: string[], limit?:12, minMatches?:1 }
     * 出参：{ list: [{ name, matchCount, totalCount }] }
     *
     * 【为什么在云端做】菜谱库 372 条，全量发给前端再由前端筛是浪费；
     *   这里只回候选菜名，prompt 与网络都只承担必要信息（D1 决策）。
     */
    case 'matchByIngredients': {
      const owned = canonicalList(event.ingredients || []);
      if (owned.length === 0) return ok({ list: [] });
      const ownedSet = new Set(owned);

      // 只取匹配需要的字段，减小传输与内存
      const { data } = await RECIPES()
        .where(visibleWhere(openid))
        .field({ name: true, ingredients: true, category: true })
        .limit(PAGE_SIZE)
        .get();

      const scored = [];
      for (const r of data || []) {
        const need = canonicalList(r.ingredients || []);
        if (need.length === 0) continue;
        const match = need.filter((x) => ownedSet.has(x)).length;
        if (match < (Number(event.minMatches) || 1)) continue;
        scored.push({
          name: r.name,
          category: r.category || '',
          matchCount: match,
          totalCount: need.length,
          // 匹配率：命中数 / 该菜所需食材数，用于优先推荐"最容易做"的
          ratio: match / need.length,
        });
      }

      scored.sort((a, b) => b.matchCount - a.matchCount || b.ratio - a.ratio);
      const limit = Number(event.limit) > 0 ? Number(event.limit) : 12;
      return ok({ list: scored.slice(0, limit), matched: scored.length });
    }

    case 'savePlan': {
      const input = event.plan || {};
      requireFields(input, ['date']);
      const row = { openid };
      for (const key of PLAN_FIELDS) {
        if (input[key] !== undefined) row[key] = input[key];
      }
      if (!row.selectedDishes) row.selectedDishes = [];
      if (!row.prepList) row.prepList = [];
      if (!row.cookingSteps) row.cookingSteps = [];
      if (row.dinersCount === undefined) row.dinersCount = 2;
      if (!row.status) row.status = 'pending';

      // 同一用户同一天只保留一条计划：存在则覆盖更新
      const { data: existing } = await PLANS()
        .where({ openid, date: row.date })
        .limit(1)
        .get();

      if (existing && existing.length > 0) {
        await PLANS().doc(existing[0]._id).update({
          data: { ...row, updatedAt: db.serverDate() },
        });
        const updated = await PLANS().doc(existing[0]._id).get();
        return ok(updated.data);
      }

      const res = await PLANS().add({
        data: { ...row, createdAt: db.serverDate(), updatedAt: db.serverDate() },
      });
      const created = await PLANS().doc(res._id).get();
      return ok(created.data);
    }

    default:
      throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
  }
});
