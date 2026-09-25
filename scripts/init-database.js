#!/usr/bin/env node
/**
 * 云开发数据库初始化（建集合 + 灌入内置菜谱种子）
 * ---------------------------------------------------------------
 * 【为什么需要它】CLI 没有云函数 invoke 命令，db-init 的「云端测试」又是纯
 *   网页操作。本脚本复用 miniprogram-automator：连上开发者工具的自动化端口，
 *   在小程序 service 上下文里真实调用 db-init 云函数。
 *
 * 【用法】
 *   1. 另开一个终端启动自动化端口（IDE 需已登录）：
 *        node scripts/devtools-auto.js
 *      或手工：
 *        "...\cli.bat" auto --project "<项目绝对路径>" --auto-port 9421
 *   2. node scripts/init-database.js            # 建集合，不灌种子
 *      node scripts/init-database.js --seed     # 建集合 + 灌入内置菜谱
 *      node scripts/init-database.js --status   # 只查看当前集合状态
 *
 * 【幂等】db-init 内部对已存在的集合返回 created:false，可反复执行。
 */

const automator = require('miniprogram-automator');

const WS = process.env.AUTO_WS || 'ws://localhost:9421';
const argv = process.argv.slice(2);
const wantStatus = argv.includes('--status');
const seed = argv.includes('--seed');

const payload = wantStatus ? { action: 'status' } : { action: 'init', seed };

(async () => {
  console.log(`[init-db] 连接自动化端口 ${WS} …`);
  let mp;
  try {
    mp = await automator.connect({ wsEndpoint: WS });
  } catch {
    console.error('[init-db] 连接失败。请先启动开发者工具的自动化端口：');
    console.error('          node scripts/devtools-auto.js');
    process.exit(1);
  }
  console.log('[init-db] 已连接小程序上下文');

  const res = await mp.evaluate(
    (data) =>
      wx.cloud
        .callFunction({ name: 'db-init', data })
        .then((r) => r.result)
        .catch((e) => ({ success: false, code: 'CALL_FAILED', message: String((e && e.errMsg) || e) })),
    payload,
  );

  await mp.disconnect();

  console.log(`[init-db] 入参: ${JSON.stringify(payload)}`);
  console.log('[init-db] 返回:', JSON.stringify(res, null, 2));

  if (!res || !res.success) {
    console.error(`[init-db] 失败: ${res && res.message}`);
    process.exit(1);
  }

  if (wantStatus) {
    const cols = res.data.collections || [];
    console.log('\n集合状态：');
    for (const c of cols) console.log(`  ${c.exists ? '✓' : '✗'} ${c.name}`);
    console.log('\n★ 索引与集合权限需在「云开发控制台 → 数据库」手动设置：');
    console.log('   权限：4 个集合均设为「仅管理端可读写」（前端不直连数据库，全部走云函数）');
    console.log('   索引：见 db-init 返回的 suggestedIndexes');
  } else {
    console.log('\n集合初始化完成：');
    for (const c of res.data.collections || []) {
      console.log(`  ${c.created ? '新建' : '已存在'}  ${c.name}`);
    }
    if (res.data.seed) console.log(`  种子菜谱: 新增 ${res.data.seed.inserted} / 跳过 ${res.data.seed.skipped}`);
  }
  process.exit(0);
})().catch((e) => {
  console.error('[init-db] 致命错误:', e.message);
  process.exit(2);
});
