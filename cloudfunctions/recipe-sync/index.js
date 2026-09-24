/**
 * 云函数：recipe-sync —— 从开源菜谱库（HowToCook）同步公共菜谱到云数据库
 * ---------------------------------------------------------------
 * 【数据来源】https://github.com/Anduin2017/HowToCook（Unlicense 公有领域）
 *   数据由本地脚本 scripts/fetch-recipes.js 拉取、解析并随本函数打包
 *   （recipe-data.full.json 全量 / recipe-data.changed.json 增量，平铺根目录）。
 *   引用出处已写入每条菜谱的 sourceUrl，并在 README「数据来源」注明。
 *
 * 【动作】
 *   { "action": "status" }                      查看集合与各来源菜谱计数
 *   { "action": "sync", "mode": "changed" }     仅同步上次拉取的增量（默认）
 *   { "action": "sync", "mode": "full" }        全量 upsert（首次入库 / 对账）
 *   { "action": "sync", "prune": true }         同步后移除仓库已删除的菜谱
 *   { "action": "sync", "offset": 100 }         分批续传（响应含 remaining/nextOffset）
 *
 * 【幂等性】按 slug（如 howtocook/meat_dish/红烧肉/简易红烧肉.md）定位文档，
 *   批量写入（云开发默认函数超时 3s，逐条 upsert 必超时）：
 *   contentHash 相同 -> 跳过；不同或新增 -> 按批 remove+add 重建。可反复执行。
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

const { db, _, wrap, ok, BizError } = require('./common');
const { COLLECTIONS } = require('./schema');

// ★ 数据文件平铺在函数根目录（Windows CLI 打包子目录会产出云端无法解析的
//   `data\x.json` zip 条目，属真实踩坑）；文件名与 fetch 脚本的 FN_FILES 对应。
const FILES = {
  full: 'recipe-data.full.json',
  changed: 'recipe-data.changed.json',
  manifest: 'recipe-data.manifest.json',
};

/** 读取打包进云函数的菜谱数据 */
function loadDataset(kind) {
  const name = FILES[kind];
  const file = path.join(__dirname, name);
  if (!fs.existsSync(file)) {
    throw new BizError('NOT_FOUND', `缺少数据文件 ${name}，请先运行 node scripts/fetch-recipes.js 再部署`);
  }
  try {
    const list = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(list) ? list : [];
  } catch (e) {
    throw new BizError('BAD_RESPONSE', `数据文件 ${name} 解析失败: ${e.message}`);
  }
}

function loadManifest() {
  const file = path.join(__dirname, FILES.manifest);
  if (!fs.existsSync(file)) return null;
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * 批量入库（幂等，remove-then-batch-add）
 * ---------------------------------------------------------------
 * ★ 为什么不用逐条 upsert：云开发默认函数超时仅 3s，逐条查+写 ~100 次
 *   必然超时。这里每批只 2 次数据库调用：
 *     1) where(slug in batch).remove()  删掉本批已存在的旧文档
 *     2) add({ data: [...] })           一次批量插入（≤100 条/次）
 *   代价：重建文档会刷新 _id 与 createdAt——公共菜谱无用户外键引用，可接受。
 *   contentHash 相同的文档跳过重建（先查出本批现存 hash，过滤后只重写有变化的）。
 * @returns {inserted, updated, skipped, failed}
 */
async function upsertBatch(col, batch) {
  const slugs = batch.map((r) => r.slug);
  const { data: existing } = await col.where({ slug: _.in(slugs) }).get();
  const existingBySlug = new Map((existing || []).map((d) => [d.slug, d]));

  const toWrite = [];
  let skipped = 0;
  for (const r of batch) {
    const old = existingBySlug.get(r.slug);
    if (old && old.contentHash === r.contentHash) { skipped++; continue; }
    toWrite.push({
      openid: null, // 公共菜谱：所有人可见
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
      createdAt: old ? old.createdAt : db.serverDate(),
      updatedAt: db.serverDate(),
    });
  }
  const inserted = toWrite.filter((d) => !existingBySlug.get(d.slug)).length;
  const updated = toWrite.length - inserted;

  if (toWrite.length > 0) {
    // 删除本批将重写的旧 slug（幂等关键；不存在则删 0 条）
    const rewriteSlugs = toWrite.map((d) => d.slug);
    await col.where({ slug: _.in(rewriteSlugs) }).remove();
    await col.add({ data: toWrite });
  }
  return { inserted, updated, skipped, failed: 0 };
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
    // 诊断信息：运行目录与数据文件可见性（排查「云端报缺数据文件」用）
    let diag = null;
    try {
      const entries = fs.readdirSync(__dirname);
      diag = {
        dirname: __dirname,
        hasFull: entries.includes(FILES.full),
        hasChanged: entries.includes(FILES.changed),
      };
    } catch (e) {
      diag = { error: String(e.message || e) };
    }
    return ok({
      recipesTotal: total.total,
      bySource,
      manifest: loadManifest(),
      diag,
    });
  }

  if (action === 'sync') {
    const mode = event.mode || 'changed';
    const list = loadDataset(mode === 'full' ? 'full' : 'changed');
    const manifest = loadManifest();

    // ★ 分批：云开发批量 add 单次 ≤100 条，函数默认超时 3s（批量法每批仅 ~3 次
    //   DB 调用，100 条/批约 1-2s）。响应带 remaining/nextOffset，>0 时续传至 done。
    const offset = Math.max(0, parseInt(event.offset, 10) || 0);
    const limit = Math.min(100, Math.max(1, parseInt(event.limit, 10) || 100));
    const batch = list.slice(offset, offset + limit);

    let stat;
    try {
      stat = await upsertBatch(col, batch);
    } catch (e) {
      stat = { inserted: 0, updated: 0, skipped: 0, failed: batch.length, failures: [{ error: String(e.message || e).slice(0, 200) }] };
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
      datasetFile: FILES[mode === 'full' ? 'full' : 'changed'],
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
