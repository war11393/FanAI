/**
 * 云函数：db-init —— 一次性初始化云开发数据库
 * ---------------------------------------------------------------
 * 【用途】创建 4 个集合（users / ingredients / meal_plans / recipes），
 *        并初始化公共菜谱种子数据。
 *
 * 【部署与调用】
 *   1. 微信开发者工具中右键 cloudfunctions/db-init -> 「上传并部署：云端安装依赖」
 *   2. 在云开发控制台 -> 云函数 -> db-init -> 「云端测试」，传入：
 *        { "action": "init" }            仅建集合
 *        { "action": "init", "seed": true }  建集合 + 灌入公共菜谱
 *        { "action": "status" }          查看当前集合状态
 *
 * 【索引说明】★ 重要
 *   云开发 Node SDK 的 db.createCollection() 只能建集合，**无法建索引**。
 *   索引需要在「云开发控制台 -> 数据库 -> 集合 -> 索引管理」手动创建，
 *   或使用 CloudBase HTTP API。本函数的 status 动作会列出建议索引，
 *   请按提示在控制台补建（数据量小时可暂缓，数据隔离靠 openid 查询条件保证）。
 *
 * 【权限说明】★ 重要
 *   请在控制台把这 4 个集合的权限都设为「仅管理端可读写」。
 *   因为本项目前端不直连数据库，全部经云函数中转；云函数为管理员权限，
 *   不受集合权限限制，同时前端伪造 openid 的路径被彻底堵死。
 */

const { db, wrap, ok } = require('./common');
const { COLLECTIONS, COLLECTION_DEFS } = require('./schema');
const { BUILTIN_RECIPES } = require('./builtin-recipes');

/** 判断集合是否已存在 */
async function collectionExists(name) {
  try {
    await db.collection(name).limit(1).get();
    return true;
  } catch (e) {
    // 集合不存在时云开发抛错，错误码 -502005 / errCode DATABASE_COLLECTION_NOT_EXIST
    if (e && (e.errCode === -502005 || /not exist/i.test(e.errMsg || e.message || ''))) {
      return false;
    }
    throw e;
  }
}

/** 创建集合（幂等） */
async function ensureCollection(name) {
  const exists = await collectionExists(name);
  if (exists) return { name, created: false };
  await db.createCollection(name);
  return { name, created: true };
}

/** 灌入公共菜谱（openid 为 null 表示公开） */
async function seedRecipes() {
  const col = db.collection(COLLECTIONS.RECIPES);
  let inserted = 0;
  let skipped = 0;

  for (const recipe of BUILTIN_RECIPES) {
    const { data } = await col.where({ name: recipe.name, source: 'builtin' }).limit(1).get();
    if (data && data.length > 0) {
      skipped++;
      continue;
    }
    await col.add({
      data: {
        openid: null, // 公开菜谱
        ...recipe,
        source: 'builtin',
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    inserted++;
  }
  return { inserted, skipped, total: BUILTIN_RECIPES.length };
}

exports.main = wrap(async (event) => {
  const action = event.action || 'init';

  if (action === 'status') {
    const status = [];
    for (const def of COLLECTION_DEFS) {
      const exists = await collectionExists(def.name);
      let count = null;
      if (exists) {
        const res = await db.collection(def.name).count();
        count = res.total;
      }
      status.push({
        name: def.name,
        desc: def.desc,
        exists,
        count,
        suggestedIndexes: def.indexes.map((i) => i.name),
      });
    }
    return ok({ collections: status });
  }

  if (action === 'init') {
    const results = [];
    for (const def of COLLECTION_DEFS) {
      results.push(await ensureCollection(def.name));
    }

    let seedResult = null;
    if (event.seed) {
      seedResult = await seedRecipes();
    }

    return ok({
      collections: results,
      seed: seedResult,
      nextSteps: [
        '★ 请在「云开发控制台 -> 数据库」把 4 个集合权限都设为「仅管理端可读写」',
        '★ 请按 suggestedIndexes 在「索引管理」补建索引（数据量小时可暂缓）',
        '★ 请确认云开发控制台已开启 AI 大模型能力（AI+ 概览页）',
      ],
    });
  }

  return ok({ message: `未知 action: ${action}` });
});
