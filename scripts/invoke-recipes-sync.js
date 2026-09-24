#!/usr/bin/env node
/**
 * 通过微信开发者工具自动化端口，在小程序上下文里真实调用 recipe-sync 云函数
 * ---------------------------------------------------------------
 * 【为什么需要它】开发者工具 CLI 没有云函数 invoke 命令，云开发控制台的
 *   「云端测试」又是纯网页操作。本脚本用 miniprogram-automator 连上
 *   `cli auto --auto-port` 开的端口，在小程序 service 上下文里
 *   wx.cloud.callFunction → 打通"部署后自动触发同步"的最后一公里。
 *
 * 【分批策略】每批一次独立的 evaluate（automator 单调用超时约 10s，
 *   云端单条 upsert ~100ms，150 条/批 ≈ 超时线附近，故云端 limit 压到 80/批，
 *   本地 while 循环推进 offset 直到 done）。★ 不要把多批塞进一个 evaluate。
 *
 * 【用法】
 *   1. 开自动化端口（IDE 需已登录）：
 *      "...\cli.bat" auto --project "C:\Users\war11\Documents\wechat_aixf" --auto-port 9421
 *   2. node scripts/invoke-recipes-sync.js [--mode changed|full] [--prune] [--limit 80]
 */

const automator = require('miniprogram-automator');

const WS = process.env.AUTO_WS || 'ws://localhost:9421';
const argv = process.argv.slice(2);
const val = (flag, dft) => {
  const i = argv.indexOf(flag);
  return i >= 0 ? argv[i + 1] : dft;
};
const mode = val('--mode', 'full');
const prune = argv.includes('--prune');
const limit = parseInt(val('--limit', '80'), 10);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  console.log(`[invoke] 连接自动化端口 ${WS} … (mode=${mode} limit=${limit})`);
  const mp = await automator.connect({ wsEndpoint: WS });
  console.log('[invoke] 已连接小程序上下文');

  // 状态预检（顺带验证数据文件在云端可读）
  const st0 = await mp.evaluate(() =>
    wx.cloud.callFunction({ name: 'recipe-sync', data: { action: 'status' } }).then((r) => r.result),
  );
  if (!st0.success) throw new Error(`status 失败: ${st0.message}`);
  if (!st0.data.diag || !st0.data.diag.hasFull) {
    throw new Error(`云端缺少数据文件（diag=${JSON.stringify(st0.data.diag)}）——重新 pnpm recipes:deploy`);
  }

  let offset = 0;
  let batchNo = 0;
  const total = { inserted: 0, updated: 0, skipped: 0, failed: 0 };
  let done = false;
  let datasetCount = null;
  while (!done) {
    batchNo++;
    const env = await mp.evaluate(
      (m, o, lim, p) =>
        wx.cloud
          .callFunction({ name: 'recipe-sync', data: { action: 'sync', mode: m, offset: o, limit: lim, prune: p } })
          .then((r) => r.result),
      mode, offset, limit, prune,
    );
    if (!env.success) throw new Error(`批次失败: ${JSON.stringify(env).slice(0, 300)}`);
    const d = env.data;
    datasetCount = d.datasetCount;
    total.inserted += d.inserted; total.updated += d.updated; total.skipped += d.skipped; total.failed += d.failed;
    console.log(`  批${batchNo}: offset=${d.offset} 处理=${d.processed} 插入=${d.inserted} 更新=${d.updated} 跳过=${d.skipped} 失败=${d.failed} 剩余=${d.remaining}`);
    if (d.failures && d.failures.length) console.log('   failures:', JSON.stringify(d.failures));
    if (d.pruned != null && d.pruned > 0) console.log(`   prune 删除: ${d.pruned}`);
    if (d.done) done = true;
    else { offset = d.nextOffset; await sleep(300); }
    if (batchNo > 50) throw new Error('批次过多，疑似不收敛，中止');
  }

  console.log(`[invoke] 全量完成：数据集 ${datasetCount} 条 → 插入 ${total.inserted} 更新 ${total.updated} 跳过 ${total.skipped} 失败 ${total.failed}`);

  const st = await mp.evaluate(() =>
    wx.cloud.callFunction({ name: 'recipe-sync', data: { action: 'status' } }).then((r) => r.result.data),
  );
  console.log('[invoke] 云端 status:', JSON.stringify(st.bySource), 'recipesTotal=', st.recipesTotal);

  await mp.disconnect();
  console.log('[invoke] 完成 ✓');
})().catch((e) => {
  console.error('[invoke] 失败:', e.message || e);
  console.error('  检查：① cli auto 端口是否已开 ② 开发者工具是否登录 ③ dist/ 是否为最新构建 ④ 云函数是否刚部署（Creating 状态需等 ~30s）');
  process.exit(1);
});
