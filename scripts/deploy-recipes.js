#!/usr/bin/env node
/**
 * 菜谱同步部署脚本：拉取开源菜谱 → 部署 recipe-sync 云函数 → 触发云端同步
 * ---------------------------------------------------------------
 * 【完整复用流程】开源仓库新增菜谱后，只需：
 *
 *   node scripts/deploy-recipes.js            # 增量（仅推送新增/变更菜谱）
 *   node scripts/deploy-recipes.js --full     # 全量对账（首次入库 / 担心漂移时用）
 *   node scripts/deploy-recipes.js --prune    # 同步后清理仓库已删除的菜谱
 *
 * 三步自动完成：
 *   1. fetch-recipes  —— 克隆/更新 HowToCook 并重新解析为结构化 JSON
 *   2. sync-shared    —— 分发云函数公共代码
 *   3. cli deploy     —— 通过微信开发者工具 CLI 部署 recipe-sync 云函数
 *   4. 触发同步       —— 打开云开发控制台直达函数测试页（CLI 无 invoke 命令，
 *                         最后一步在控制台点「云端测试」：{"action":"sync","mode":"changed"}）
 *
 * 【前置条件】微信开发者工具已安装且「设置-安全设置」开启了服务端口；
 *   若 CLI 报 "IDE service not available"，请先打开开发者工具并登录。
 */

const path = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
// 与 src/cloud/config.ts 的 CLOUD_ENV_ID 保持一致
const ENV_ID = 'war11393-d3ghsd3zcc6dd0426';
const FN_NAME = 'recipe-sync';

const mode = process.argv.includes('--full') ? 'full' : 'changed';
const prune = process.argv.includes('--prune');

function run(cmd, opts = {}) {
  console.log(`\n$ ${cmd}`);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

/* 1. 拉取并解析开源菜谱（数据自动复制到 cloudfunctions/recipe-sync/data/） */
run(`node scripts/fetch-recipes.js${process.argv.includes('--no-pull') ? ' --no-pull' : ''}`);

/* 2. 分发公共代码 */
run('node cloudfunctions/sync-shared.js');

/* 3. 离线自检：确保 recipe-sync 逻辑没坏再部署 */
try {
  run('node cloudfunctions/test-offline.js', { stdio: 'pipe' });
} catch {
  console.error('[deploy] 离线自检失败，中止部署（详见上方输出）');
  process.exit(1);
}

/* 4. 通过开发者工具 CLI 部署云函数（复用 scripts/deploy-cloudfunctions.js 的部署+核对逻辑） */
console.log(`\n[deploy] 部署云函数 ${FN_NAME} 到环境 ${ENV_ID} …`);
// 该脚本内部已处理：逐个部署、Creating 状态退避重试、部署后下载云端代码逐字核对。
// ★ 只跑部署+核对，不再重复 fetch/sync-shared/离线自检（上面已做过）。
try {
  run(`node scripts/deploy-cloudfunctions.js ${FN_NAME}`);
} catch {
  console.error('[deploy] 云函数部署或核对失败，详见上方输出。');
  console.error(`        可改为手动部署：开发者工具右键 cloudfunctions/${FN_NAME} → 上传并部署（云端安装依赖）`);
  process.exit(1);
}

/* 5. 给出云端测试直达链接（CLI 无 invoke 能力，触发同步的 payload 已备好） */
// 首次入库建议 full；日常增量用 changed。单批上限 100（云开发批量 add 上限 +
// 函数 3s 超时），按响应 nextOffset 续传至 done。推荐直接跑：
//   node scripts/invoke-recipes-sync.js（经 cli auto 自动分批循环，免手工）
const event = JSON.stringify({ action: 'sync', mode, prune, limit: 80 });
console.log('\n================ 最后一步：触发云端同步 ================');
console.log(`云开发控制台 → 云函数 → ${FN_NAME} → 云端测试，传入：`);
console.log(`  ${event}`);
console.log('（或开发者工具调试器 Console 粘贴：');
console.log(`  wx.cloud.callFunction({name:'${FN_NAME}',data:${event}}).then(r=>console.log(r.result))`);
console.log(' ）');
try {
  execSync(`start "" "https://tcb.cloud.tencent.com/dev?envId=${ENV_ID}#/function/detail?id=${FN_NAME}"`, { stdio: 'ignore', shell: 'cmd.exe' });
  console.log('[deploy] 已尝试在浏览器打开云开发控制台函数页');
} catch { /* 忽略 */ }
