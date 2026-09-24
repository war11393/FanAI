/**
 * 云函数：recipe-sync —— 从开源菜谱库（HowToCook）同步公共菜谱到云数据库
 * ---------------------------------------------------------------
 * 【数据来源】https://github.com/Anduin2017/HowToCook（Unlicense 公有领域）
 *   数据由本地脚本 scripts/fetch-recipes.js 拉取、解析并随本函数打包
 *   （data/howtocook.json 为全量，data/howtocook.changed.json 为增量子集）。
 *   引用出处已写入每条菜谱的 sourceUrl，并在 README「数据来源」注明。
 *
 * 【动作】
 *   { "action": "status" }                      查看集合与各来源菜谱计数
 *   { "action": "sync", "mode": "changed" }     仅同步上次拉取的增量（默认）
 *   { "action": "sync", "mode": "full" }        全量 upsert（首次入库 / 对账）
 *   { "action": "sync", "prune": true }         同步后移除仓库已删除的菜谱
 *   { "action": "sync", "offset": 150 }         分批续传（响应含 remaining/nextOffset）
 *
 * 【幂等性】按 slug（如 howtocook/meat_dish/红烧肉/简易红烧肉.md）定位文档：
 *   不存在 -> add；contentHash 变化 -> update；相同 -> skip。可反复执行。
 *
 * 【调用方式】本函数无小程序前端调用方，仅供开发者同步数据：
 *   方式 A（推荐）：node scripts/deploy-recipes.js（自动部署 + 打开云控制台触发）
 *   方式 B：微信开发者工具 -> 云开发控制台 -> 云函数 -> recipe-sync -> 云端测试
 *
 * 【限额说明】云函数单次响应约 20s；本函数逐条查询+写入，每批 100 条以内
 *   均可在时限内完成（增量模式通常远小于该值）。
 */

const fs = require('fs');
const path = require('path');

const { db, wrap, ok, BizError } = require('./common');
const { COLLECTIONS } = require('./schema');

const DATA_DIR = path.join(__dirname, 'data');

/** 读取打包进云函数的菜谱数据（带来源元信息） */
function loadDataset(filename) {
  const file = path.join(DATA_DIR, filename);
  if (!fs.existsSync(file)) {
    throw new BizError('NOT_FOUND', `缺少数据文件 data/${filename}，请先运行 node scripts/fetch-recipes.js 再部署`);
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    throw new BizError('BAD_RESPONSE', `数据文件 data/${filename} 解析失败: ${e.message}`);
  }
}

function loadManifest() {
  const file = path.join(DATA_DIR, 'manifest.json');
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 单条菜谱入库（幂等 upsert by slug）
 * @returns 'inserted' | 'updated' | 'skipped'
 */
async function upsertRecipe(col, r) {
  const { data } = await col.where({ slug: r.slug }).limit(1).get();
  const fields = {
    slug: r.slug,
    name: r.name,
    category: r.category,
    flavors: r.flavors || [],
    ingredients: r.ingredients || [],
    mainSteps: r.mainSteps || [],
    brief: r.brief || '',
    difficulty: r.difficulty || '普通',
    durationMinutes: r.durationMinutes || 30,
    calories: r.calories ?? null,
    source: r.source,
    sourceUrl: r.sourceUrl,
    contentHash: r.contentHash,
  };
  if (!data || data.length === 0) {
    await col.add({
      data: {
        openid: null, // 公共菜谱：所有人可见
        ...fields,
        createdAt: db.serverDate(),
        updatedAt: db.serverDate(),
      },
    });
    return 'inserted';
  }
  if (data[0].contentHash === r.contentHash) return 'skipped';
  await col.doc(data[0]._id).update({ data: { ...fields, updatedAt: db.serverDate() } });
  return 'updated';
}

exports.main = wrap(async (event) => {
  const action = event.action || 'status';
  const col = db.collection(COLLECTIONS.RECIPES);

  if (action === 'status') {
    const total = await col.count();
    const bySource = {};
    for (const src of ['howtocook', 'builtin', 'user']) {
      const c = await col.where({ source: src }).count();
      bySource[src] = c.total;
    }
    return ok({
      recipesTotal: total.total,
      bySource,
      manifest: loadManifest(),
    });
  }

  if (action === 'sync') {
    const mode = event.mode || 'changed';
    const file = mode === 'full' ? 'howtocook.json' : 'howtocook.changed.json';
    const list = loadDataset(file);
    const manifest = loadManifest();

    // ★ 分批：云函数单次执行有超时限制（逐条查询+写入约 80ms/条），
    //   默认每批 150 条；响应带 remaining，>0 时以 nextOffset 再调一次，循环至完成。
    const offset = Math.max(0, parseInt(event.offset, 10) || 0);
    const limit = Math.min(200, Math.max(1, parseInt(event.limit, 10) || 150));
    const batch = list.slice(offset, offset + limit);

    const stat = { inserted: 0, updated: 0, skipped: 0, failed: 0, failures: [] };
    for (const r of batch) {
      try {
        const res = await upsertRecipe(col, r);
        stat[res]++;
      } catch (e) {
        stat.failed++;
        if (stat.failures.length < 20) stat.failures.push({ slug: r.slug, error: String(e.message || e).slice(0, 150) });
      }
    }

    const remaining = list.length - (offset + batch.length);
    let pruned = null;
    if (event.prune && manifest && Array.isArray(manifest.removedSlugs)) {
      pruned = 0;
      for (const slug of manifest.removedSlugs) {
        const { data } = await col.where({ slug }).limit(1).get();
        for (const d of data || []) {
          await col.doc(d._id).remove();
          pruned++;
        }
      }
    }

    return ok({
      mode,
      datasetFile: `data/${file}`,
      datasetCount: list.length,
      offset,
      processed: batch.length,
      remaining,
      nextOffset: remaining > 0 ? offset + batch.length : null,
      done: remaining === 0,
      ...stat,
      pruned,
      manifest: manifest
        ? { commit: manifest.commit, commitDate: manifest.commitDate, fetchedAt: manifest.fetchedAt, total: manifest.total }
        : null,
      hint: remaining > 0
        ? `本批完成，还剩 ${remaining} 条：再以 {"action":"sync","mode":"${mode}","offset":${offset + batch.length}} 调用一次`
        : '同步完成。再次运行：node scripts/deploy-recipes.js（默认增量）；全量对账传 mode=full',
    });
  }

  throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
});
