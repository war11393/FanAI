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
const CLI = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具\\cli.bat';
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

/* 4. 通过开发者工具 CLI 部署云函数 */
console.log(`\n[deploy] 部署云函数 ${FN_NAME} 到环境 ${ENV_ID} …`);
try {
  run(`"${CLI}" cloud functions deploy --env ${ENV_ID} --names ${FN_NAME} --remote-npm-install --project "${ROOT}"`);
} catch (e) {
  console.error('[deploy] CLI 部署失败。常见原因：开发者工具未打开或未开启服务端口。');
  console.error('        可改为手动部署：开发者工具右键 cloudfunctions/recipe-sync → 上传并部署（云端安装依赖）');
  process.exit(1);
}

/* 5. 给出云端测试直达链接（CLI 无 invoke 能力，触发同步的 payload 已备好） */
const event = JSON.stringify({ action: 'sync', mode, prune });
console.log('\n================ 最后一步：触发云端同步 ================');
console.log(`云开发控制台 → 云函数 → ${FN_NAME} → 云端测试，传入：`);
console.log(`  ${event}`);
try {
  execSync(`start "" "https://tcb.cloud.tencent.com/dev?envId=${ENV_ID}#/function/detail?id=${FN_NAME}"`, { stdio: 'ignore', shell: 'cmd.exe' });
  console.log('[deploy] 已尝试在浏览器打开云开发控制台函数页');
} catch { /* 忽略 */ }
