#!/usr/bin/env node
/**
 * 启动微信开发者工具的自动化端口（automator 连接用）
 * ---------------------------------------------------------------
 * CLI 的 `auto` 命令在非交互 shell 下会把参数透传给 cli.bat，而 cli.bat 在
 * MSYS/git-bash 里无法直接调用（路径含空格与中文）。本脚本绕开 .bat，
 * 直接以 ELECTRON_RUN_AS_NODE 启动开发者工具自带的 CLI 入口。
 *
 * 【用法】node scripts/devtools-auto.js [--port 9421]
 *   启动后保持该终端不关，另开终端跑 scripts/init-database.js 等调用脚本。
 */

const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DEVTOOLS = 'C:\\Program Files (x86)\\Tencent\\微信web开发者工具';
const ELECTRON = path.join(DEVTOOLS, '微信开发者工具.exe');
const CLI_JS = 'resources/app.asar.unpacked/js/common/cli/index.js';

const argv = process.argv.slice(2);
const pi = argv.indexOf('--port');
const PORT = pi >= 0 ? argv[pi + 1] : '9421';

console.log(`[auto] 启动开发者工具自动化端口 ${PORT} …`);
console.log('[auto] 项目:', ROOT);
console.log('[auto] 保持本进程运行；就绪后另开终端执行 node scripts/init-database.js\n');

const child = spawn(
  ELECTRON,
  [CLI_JS, 'auto', '--project', ROOT, '--auto-port', String(PORT)],
  { cwd: DEVTOOLS, env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: 'inherit' },
);

child.on('exit', (code) => process.exit(code ?? 0));
process.on('SIGINT', () => child.kill());
