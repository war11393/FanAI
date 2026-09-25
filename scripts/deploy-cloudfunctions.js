#!/usr/bin/env node
/**
 * 云函数部署脚本（微信云开发）
 * ---------------------------------------------------------------
 * 【为什么需要它】
 *   1. 微信开发者工具 CLI 的 `--names` 只接受单个函数名，传逗号分隔会报
 *      "cloudfunction path not found"；本脚本逐个部署并处理重试。
 *   2. CLI 无 `invoke` 能力，db-init 这类一次性初始化需要明确的手工步骤。
 *   3. 部署后自动「下载回云端代码 + 逐字 diff + 校验依赖」，
 *      避免出现「verify 说源码一致、云端实际跑的是旧代码」的假阳性。
 *
 * 【用法】
 *   node scripts/deploy-cloudfunctions.js                 # 部署全部云函数
 *   node scripts/deploy-cloudfunctions.js user ingredient # 只部署指定函数
 *   node scripts/deploy-cloudfunctions.js --verify-only   # 只核对云端现状，不部署
 *
 * 【前置条件】微信开发者工具已安装且「设置-安全设置」开启了服务端口。
 *
 * 【部署后必做】首次部署后需要在云开发控制台调用一次 db-init 建集合：
 *   云函数 → db-init → 云端测试，传入 {"action":"init","seed":true}
 *   （更推荐直接跑 node scripts/init-database.js，自动经自动化端口调用）
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const os = require('os');

const ROOT = path.resolve(__dirname, '..');
const CF_DIR = path.join(ROOT, 'cloudfunctions');
const DEVTOOLS = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具';
const ELECTRON = path.join(DEVTOOLS, '微信开发者工具.exe');
const CLI_JS = 'resources/app.asar.unpacked/js/common/cli/index.js';
const ENV_ID = 'war11393-d3ghsd3zcc6dd0426';

/** 需要部署的云函数（ai-service 是「方案 B」备用骨架，前端不调用，故排除） */
const FUNCTIONS = ['user', 'ingredient', 'recipe', 'ai-text', 'ai-image', 'db-init', 'recipe-sync'];

const argv = process.argv.slice(2);
const VERIFY_ONLY = argv.includes('--verify-only');
const targets = argv.filter((a) => !a.startsWith('--'));
const list = targets.length > 0 ? targets : FUNCTIONS;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 调 CLI（cli.bat 在非交互 shell 下不可用，直接起 electron 跑 CLI 的 index.js） */
function cli(args) {
  return execFileSync(ELECTRON, [CLI_JS, ...args], {
    cwd: DEVTOOLS,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const strip = (s) => s.replace(/DeprecationWarning[\s\S]*?\n/g, '').replace(/trace-deprecation[^\n]*\n/g, '');

/* ============================ 部署 ============================ */

/** 部署单个函数，Creating 冲突时退避重试 */
async function deployOne(name) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    let out;
    try {
      out = strip(
        cli([
          'cloud', 'functions', 'deploy',
          '--env', ENV_ID, '--names', name,
          '--remote-npm-install', '--project', ROOT,
        ]),
      );
    } catch (e) {
      out = strip(String(e.stdout || '') + String(e.stderr || ''));
    }
    // CLI 结果表格用全角边框 │，成功行形如 "│ user │ true │"
    const okRow = new RegExp(`│\\s*${name}\\s*│\\s*true`).test(out);
    if (okRow) return { ok: true, attempt };

    const creating = /Creating\s*状态|UpdateFunctionCode/.test(out);
    if (attempt < 5) {
      console.log(`    [retry ${attempt}] ${creating ? '函数处于 Creating，' : ''}20s 后重试…`);
      await sleep(20000);
    }
  }
  return { ok: false };
}

/* ============================ 核对 ============================ */

/**
 * 下载云端函数代码，与本地逐字比对（忽略 CRLF），并校验依赖已安装。
 * ★ 这一步是「部署成功」的**唯一可信判据**——CLI 返回 success 只代表请求被接受。
 */
async function verifyOne(name, baseDir) {
  const dest = path.join(baseDir, name);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });

  try {
    cli(['cloud', 'functions', 'download', '--env', ENV_ID, '--name', name, '--path', dest, '--project', ROOT]);
  } catch {
    /* 下载失败按下面判定处理 */
  }

  const localDir = path.join(CF_DIR, name);
  if (!fs.existsSync(path.join(dest, 'index.js'))) {
    return { ok: false, reason: '云端未下载到 index.js' };
  }

  // 本地有、云端也应有
  const problems = [];
  const localJs = fs.readdirSync(localDir).filter((f) => f.endsWith('.js'));
  for (const f of localJs) {
    const remotePath = path.join(dest, f);
    if (!fs.existsSync(remotePath)) {
      problems.push(`缺 ${f}`);
      continue;
    }
    const norm = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
    if (norm(path.join(localDir, f)) !== norm(remotePath)) problems.push(`差异 ${f}`);
  }

  // 数据文件（recipe-sync 依赖）
  for (const f of fs.readdirSync(localDir).filter((f) => f.endsWith('.json'))) {
    if (!fs.existsSync(path.join(dest, f))) problems.push(`缺 ${f}`);
  }

  // 依赖
  const pkgPath = path.join(localDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    const deps = Object.keys(JSON.parse(fs.readFileSync(pkgPath, 'utf8')).dependencies || {});
    for (const d of deps) {
      if (!fs.existsSync(path.join(dest, 'node_modules', d))) problems.push(`缺依赖 ${d}`);
    }
  }

  return { ok: problems.length === 0, reason: problems.join('; ') };
}

/* ============================ 主流程 ============================ */

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`[deploy] 未找到微信开发者工具：${ELECTRON}`);
    process.exit(1);
  }

  // 分发 _shared 公共代码（云函数无法引用目录外文件，必须复制进去）
  if (!VERIFY_ONLY) {
    console.log('[deploy] 分发 _shared 公共代码…');
    execFileSync(process.execPath, [path.join(CF_DIR, 'sync-shared.js')], { stdio: 'inherit' });
    console.log('');

    for (const name of list) {
      if (!fs.existsSync(path.join(CF_DIR, name))) {
        console.log(`[deploy] ${name} —— 跳过（目录不存在）`);
        continue;
      }
      process.stdout.write(`[deploy] ${name} … `);
      const r = await deployOne(name);
      console.log(r.ok ? `✓ 成功（第 ${r.attempt} 次尝试）` : '✗ 失败');
    }
    console.log('');
  }

  // 部署后核对：下载云端代码对比
  console.log('[verify] 下载云端代码核对部署结果（源码逐字 + 依赖）…');
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfverify-'));
  let failed = [];
  for (const name of list) {
    const r = await verifyOne(name, baseDir);
    console.log(`  ${r.ok ? '✓' : '✗'} ${name}${r.ok ? '' : ' -> ' + r.reason}`);
    if (!r.ok) failed.push(name);
  }
  fs.rmSync(baseDir, { recursive: true, force: true });

  console.log('');
  if (failed.length > 0) {
    console.error(`[verify] 以下函数未通过核对：${failed.join(', ')}`);
    process.exit(1);
  }
  console.log('[verify] 全部通过：云端源码与本地逐字一致，依赖齐备。');
  console.log('');
  console.log('【别忘了】首次部署后需初始化数据库集合，执行：');
  console.log('  node scripts/init-database.js           # 建集合 + 灌入内置菜谱种子');
})().catch((e) => {
  console.error('[deploy] 致命错误:', e.message);
  process.exit(1);
});
