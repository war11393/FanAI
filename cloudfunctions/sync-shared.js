/**
 * 同步 _shared 公共文件到各云函数目录
 * ---------------------------------------------------------------
 * 云函数部署时会打包各自目录，无法引用目录外的文件，
 * 因此 _shared/*.js 必须复制到每个云函数目录下。
 *
 * 用法：node cloudfunctions/sync-shared.js
 * ★ 修改 _shared 下任何文件后，务必重新执行本脚本。
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const SHARED_DIR = path.join(ROOT, '_shared');
/** 需要同步到各云函数的文件（不含 builtin-recipes，仅 db-init/recipe 需要） */
const FILES = [
  'common.js',
  'schema.js',
  'shelf-life-dict.js',
  'builtin-recipes.js',
  'prompts.js',
  'ingredient-names.js',
];

/** 各云函数需要哪些公共文件（按需精简，减小部署体积） */
const TARGETS = {
  'db-init': ['common.js', 'schema.js', 'builtin-recipes.js'],
  user: ['common.js', 'schema.js'],
  ingredient: ['common.js', 'schema.js', 'shelf-life-dict.js', 'ingredient-names.js'],
  recipe: ['common.js', 'schema.js', 'builtin-recipes.js', 'ingredient-names.js'],
  'ai-text': ['common.js', 'prompts.js', 'ingredient-names.js'],
  'ai-image': ['common.js'],
  'recipe-sync': ['common.js', 'schema.js'],
};

let synced = 0;
for (const [fnDir, files] of Object.entries(TARGETS)) {
  const destDir = path.join(ROOT, fnDir);
  if (!fs.existsSync(destDir)) {
    console.warn(`  [skip] 云函数目录不存在: ${fnDir}`);
    continue;
  }
  for (const file of files) {
    if (!FILES.includes(file)) continue;
    const src = path.join(SHARED_DIR, file);
    if (!fs.existsSync(src)) {
      console.error(`  [error] 源文件不存在: _shared/${file}`);
      process.exitCode = 1;
      continue;
    }
    fs.copyFileSync(src, path.join(destDir, file));
    synced++;
  }
  console.log(`  [ok] ${fnDir} <- ${files.join(', ')}`);
}

console.log(`\n同步完成，共复制 ${synced} 个文件。`);
