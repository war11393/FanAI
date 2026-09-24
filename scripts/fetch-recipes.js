#!/usr/bin/env node
/**
 * 菜谱数据拉取脚本：从 GitHub 开源仓库 HowToCook 同步菜谱到本地结构化数据
 * ---------------------------------------------------------------
 * 【数据源】https://github.com/Anduin2017/HowToCook
 *   - 许可证：Unlicense（公有领域，可自由商用，见 README「数据来源」节）
 *   - 菜谱正文：dishes/<分类>/ 目录下的 .md 文件（分类目录为英文，展示时映射中文）
 *
 * 【产出】
 *   data/recipes/howtocook.json         全量结构化菜谱（入库、可提交 git）
 *   data/recipes/howtocook.changed.json 相对上次拉取的新增/变更子集（增量同步用）
 *   data/recipes/manifest.json          来源 commit、时间、统计、增删摘要
 *   cloudfunctions/recipe-sync/data/    部署副本（★必须入库：微信云函数打包遵循 gitignore）
 *
 * 【用法】
 *   node scripts/fetch-recipes.js            完整流程：克隆/更新仓库 → 解析 → 写数据
 *   node scripts/fetch-recipes.js --no-pull  跳过 git 更新，用本地已有克隆重新解析
 *
 * ★ 复用流程：仓库有新菜谱合并后，重跑本脚本即可自动做增量 diff；
 *   然后 node scripts/deploy-recipes.js 部署并触发云同步（见 README）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const REPO_DIR = path.join(ROOT, 'data', 'howtocook');
const REPO_URL = 'https://github.com/Anduin2017/HowToCook.git';
const REPO_BRANCH = 'master';
const OUT_DIR = path.join(ROOT, 'data', 'recipes');
const FN_DIR = path.join(ROOT, 'cloudfunctions', 'recipe-sync');
/**
 * ★ 部署副本必须放函数根目录、不能放子目录：
 *   微信开发者工具 CLI 在 Windows 打包云函数时，子目录会以反斜杠写进 zip
 *   （`data\x.json`），云端 Linux 解出来是带字面 `\` 的平铺文件名，
 *   `data/` 子目录根本不存在（真实故障：云端报「缺少数据文件」）。
 */
const FN_FILES = {
  'howtocook.json': 'recipe-data.full.json',
  'howtocook.changed.json': 'recipe-data.changed.json',
  'manifest.json': 'recipe-data.manifest.json',
};
const DATA_FILE = path.join(OUT_DIR, 'howtocook.json');
const CHANGED_FILE = path.join(OUT_DIR, 'howtocook.changed.json');
const MANIFEST_FILE = path.join(OUT_DIR, 'manifest.json');
const SOURCE = 'howtocook';

/** 英文分类目录 → 中文展示名（与 builtin 菜谱的 category 语义对齐） */
const CATEGORY_MAP = {
  aquatic: '海鲜水产',
  breakfast: '早餐',
  condiment: '酱料调料',
  dessert: '甜点',
  drink: '饮品',
  meat_dish: '荤菜',
  'semi-finished': '速食半成品',
  soup: '汤羹',
  staple: '主食',
  vegetable_dish: '素菜',
};

/* ============ 一、仓库同步（克隆 / 增量 fetch） ============ */

function sh(cmd, opts = {}) {
  return execSync(cmd, { encoding: 'utf8', cwd: opts.cwd || ROOT, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function syncRepo() {
  const noPull = process.argv.includes('--no-pull');
  if (!fs.existsSync(path.join(REPO_DIR, '.git'))) {
    console.log('[fetch] 克隆 HowToCook（depth 1）…');
    fs.mkdirSync(path.dirname(REPO_DIR), { recursive: true });
    sh(`git clone --depth 1 --branch ${REPO_BRANCH} ${REPO_URL} "${REPO_DIR}"`, { stdio: 'inherit' });
  } else if (!noPull) {
    console.log('[fetch] 更新已有克隆（fetch + reset）…');
    sh(`git fetch --depth 1 origin ${REPO_BRANCH}`, { cwd: REPO_DIR });
    sh(`git reset --hard origin/${REPO_BRANCH}`, { cwd: REPO_DIR });
  } else {
    console.log('[fetch] --no-pull：使用本地已有克隆');
  }
  const commit = sh('git rev-parse HEAD', { cwd: REPO_DIR });
  const date = sh('git log -1 --format=%cI', { cwd: REPO_DIR });
  return { commit, commitDate: date };
}

/* ============ 二、Markdown 解析 ============ */

/** 内容指纹：对参与结构化的关键字段取 hash，用于增量 diff */
function contentHash(recipe) {
  const basis = JSON.stringify([
    recipe.name, recipe.category, recipe.brief, recipe.ingredients,
    recipe.mainSteps, recipe.difficulty, recipe.calories, recipe.durationMinutes,
  ]);
  return crypto.createHash('sha1').update(basis).digest('hex');
}

/** 去掉行内反引号并压缩空白 */
function clean(s) {
  return s.replace(/`/g, '').replace(/\s+/g, ' ').trim();
}

/** 去掉尾部括注：`鸡蛋（可选）` → `鸡蛋`；保留中部括号说明 */
function stripTrailingNote(s) {
  return s.replace(/[（(][^（()）]*[)）]\s*$/u, '').trim();
}

/** 从简介/食材推断口味标签（best-effort，规则轻量，匹配不上返回空数组） */
function inferFlavors(text) {
  const hits = [];
  const rules = [
    ['辣', /辣椒|麻辣|香辣|辣子|微辣|重辣|泡椒|剁椒/],
    ['酸甜', /糖醋|酸甜|咕噜|锅包肉/],
    ['咸鲜', /咸鲜|酱香|生抽|蚝油/],
    ['清淡', /清蒸|白灼|水煮|清炒|清淡/],
    ['浓郁', /红烧|焖|炖|卤|酱/],
    ['香甜', /牛奶|椰|糖|蜂蜜|红豆|草莓|芒果/],
    ['酸', /酸汤|酸菜|醋/],
    ['香辛', /咖喱|黑椒|五香|孜然|八角/],
  ];
  for (const [tag, re] of rules) if (re.test(text)) hits.push(tag);
  return hits.slice(0, 3);
}

/** 从简介提取预计耗时（分钟）："大约需要 1.5 小时" / "全程大约需要 25 分钟" */
function inferDuration(intro) {
  const h = intro.match(/(\d+(?:\.\d+)?)\s*(?:个)?小时/);
  const m = intro.match(/(\d+)\s*分钟/);
  if (h) return Math.round(parseFloat(h[1]) * 60);
  if (m) return parseInt(m[1], 10);
  return null;
}

/**
 * 解析单个菜谱 markdown 文件
 * @returns {object|null} 结构化菜谱；无法识别时返回 null（调用方记入失败清单）
 */
function parseRecipe(absFile, relPosix) {
  const raw = fs.readFileSync(absFile, 'utf8').replace(/\r\n/g, '\n');
  const lines = raw.split('\n');

  // H1 标题：`# 红烧肉的做法` → name = 红烧肉
  let h1 = null;
  const h1Idx = lines.findIndex((l) => /^#\s+\S/.test(l));
  if (h1Idx >= 0) h1 = clean(lines[h1Idx].replace(/^#\s+/, ''));
  const fileBase = path.basename(relPosix, '.md');
  const name = h1 ? h1.replace(/的做法$/, '') : fileBase;
  if (!name) return null;

  // 按 `## 标题` 切段
  const sections = {}; // 标题文本 -> 行数组
  let cur = null;
  const introLines = [];
  for (let i = 0; i < lines.length; i++) {
    if (i === h1Idx) continue;
    const m = lines[i].match(/^##\s+(.+)$/);
    if (m) {
      cur = clean(m[1]);
      sections[cur] = [];
      continue;
    }
    if (cur === null) introLines.push(lines[i]);
    else (sections[cur] = sections[cur] || []).push(lines[i]);
  }

  // 简介：H1 与第一个 ## 之间的正文（剔除图片/难度/卡路里行）
  const brief = introLines
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('![') && !/^预估烹饪难度|^预估卡路里/.test(l))
    .join('');

  // 难度：★ 数量映射到 简单/普通/复杂
  const starLine = introLines.concat(sections['附加内容'] || []).find((l) => /预估烹饪难度/.test(l))
    || raw.match(/预估烹饪难度[：:]\s*([★☆]+)/)?.[0] || '';
  const stars = (starLine.match(/★/g) || []).length;
  const difficulty = stars >= 4 ? '复杂' : stars === 3 ? '普通' : stars >= 1 ? '简单' : null;

  // 卡路里
  const calMatch = raw.match(/预估卡路里[：:]\s*(\d+)/);
  const calories = calMatch ? parseInt(calMatch[1], 10) : null;

  // 食材：`## 必备原料和工具` 下的列表项
  const ingredients = [];
  const pushIngredient = (text) => {
    let t = clean(text);
    t = t.replace(/^(主料|辅料|调料|食材)[：:]/, '');
    if (!t || /^注[：:]/.test(t) || /[（(]\s*可选/.test(t) && t.length > 20) {
      // 「注：…」类整行丢弃；过长的备选说明也丢弃
      if (/^注[：:]/.test(t)) return;
    }
    if (/\]\(/.test(t)) return; // 链接引用行（指向其它菜谱）不算食材
    t = t.replace(/[：:]$/, '');
    if (!t || t.length > 40) return;
    // 顿号/逗号分隔的多食材（如 `大肉`、`鸡蛋`；`花椒，香叶，…`）
    // ★ 先保护括号内的分隔符，避免 `甜椒（可以不用，加上配色）` 被拆坏
    const protectedT = t.replace(/[（(][^（()）]*[)）]/gu, (m) => m.replace(/[、，]/g, '\u0001'));
    const parts = /、|，/.test(protectedT) ? protectedT.split(/[、，]/) : [protectedT];
    for (let p of parts) {
      p = p.replace(/\u0001/g, '，');
      const one = stripTrailingNote(p).replace(/[。；;]$/, '').trim();
      if (one && one.length <= 16 && !/^(总量|每人|一份|按照|每次)/.test(one)) ingredients.push(one);
    }
  };
  for (const line of sections['必备原料和工具'] || []) {
    const m = line.match(/^\s*[-*+]\s+(.+)$/);
    if (m) pushIngredient(m[1]);
  }

  // 步骤：`## 操作` 下的有序列表；缩进续行/子列表并入当前步骤
  const steps = [];
  let stepBuf = null;
  const flushStep = () => {
    if (stepBuf) {
      steps.push(clean(stepBuf));
      stepBuf = null;
    }
  };
  for (const line of sections['操作'] || []) {
    const num = line.match(/^\s*(\d+)[.、]\s+(.+)$/);
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    if (num) {
      flushStep();
      stepBuf = num[2];
    } else if (stepBuf && bullet && /^\s{2,}/.test(line)) {
      stepBuf += '，' + bullet[1]; // 子列表并入上一步
    } else if (stepBuf && /^\s{2,}\S/.test(line) && !line.startsWith('#')) {
      stepBuf += ' ' + line.trim(); // 续行并入上一步
    }
  }
  flushStep();
  const mainSteps = steps.map((s) => clean(s)).filter((s) => s.length > 1);
  if (mainSteps.length === 0) return null; // 无步骤视为解析失败

  // 分类：路径 dishes/<en_dir>/... 映射中文
  const segs = relPosix.split('/');
  const enCat = segs[1] || '';
  const category = CATEGORY_MAP[enCat] || '家常菜';

  const recipe = {
    slug: `${SOURCE}/${segs.slice(1).join('/')}.md`.replace(/\.md\.md$/, '.md'), // 稳定唯一 ID = 仓库相对路径
    name,
    category,
    flavors: inferFlavors(brief + ' ' + ingredients.join(' ')),
    ingredients: [...new Set(ingredients)],
    mainSteps,
    brief: brief.slice(0, 200),
    difficulty: difficulty || '普通',
    durationMinutes: inferDuration(brief) || 30,
    calories,
    source: SOURCE,
    sourceUrl: `https://github.com/Anduin2017/HowToCook/blob/${segs.length ? '__COMMIT__' : ''}/${relPosix}`,
  };
  recipe.contentHash = contentHash(recipe);
  return recipe;
}

function listMdFiles(dirAbs, dirRel) {
  const out = [];
  for (const ent of fs.readdirSync(dirAbs, { withFileTypes: true })) {
    const abs = path.join(dirAbs, ent.name);
    const rel = `${dirRel}/${ent.name}`;
    if (ent.isDirectory()) out.push(...listMdFiles(abs, rel));
    else if (ent.name.endsWith('.md') && !rel.includes('/template/')) out.push({ abs, rel });
  }
  return out;
}

/* ============ 三、主流程 ============ */

function main() {
  const { commit, commitDate } = syncRepo();
  const dishesDir = path.join(REPO_DIR, 'dishes');
  if (!fs.existsSync(dishesDir)) {
    console.error('[fetch] 未找到 dishes 目录，仓库结构可能已变化：%s', dishesDir);
    process.exit(1);
  }

  console.log(`[fetch] HEAD=${commit.slice(0, 8)} (${commitDate})`);

  const files = listMdFiles(dishesDir, 'dishes').sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const recipes = [];
  const failures = [];
  for (const f of files) {
    try {
      const r = parseRecipe(f.abs, f.rel);
      if (r) {
        r.sourceUrl = r.sourceUrl.replace('__COMMIT__', commit);
        recipes.push(r);
      } else failures.push(f.rel);
    } catch (e) {
      failures.push(`${f.rel} (${e.message})`);
    }
  }

  // 增量 diff：与上一版数据按 slug + contentHash 对比
  let prev = [];
  if (fs.existsSync(DATA_FILE)) {
    try { prev = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch { prev = []; }
  }
  const prevBySlug = new Map(prev.map((p) => [p.slug, p]));
  const newAdded = [];
  const newUpdated = [];
  const removed = [];
  let unchanged = 0;
  for (const r of recipes) {
    const old = prevBySlug.get(r.slug);
    if (!old) newAdded.push(r);
    else if (old.contentHash !== r.contentHash) newUpdated.push(r);
    else unchanged++;
  }
  const curSlugs = new Set(recipes.map((r) => r.slug));
  for (const p of prev) if (!curSlugs.has(p.slug)) removed.push(p.slug);

  // 写产出
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(recipes, null, 2));
  const changedList = [...newAdded, ...newUpdated];
  fs.writeFileSync(CHANGED_FILE, JSON.stringify(changedList, null, 2));

  const byCategory = {};
  for (const r of recipes) byCategory[r.category] = (byCategory[r.category] || 0) + 1;
  const manifest = {
    source: SOURCE,
    repo: 'https://github.com/Anduin2017/HowToCook',
    license: 'Unlicense (public domain)',
    repoVersion: (() => { try { return JSON.parse(fs.readFileSync(path.join(REPO_DIR, 'package.json'), 'utf8')).version; } catch { return null; } })(),
    commit,
    commitDate,
    fetchedAt: new Date().toISOString(),
    total: recipes.length,
    parseFailures: failures,
    stats: {
      byCategory,
      withCalories: recipes.filter((r) => r.calories != null).length,
      avgIngredients: +(recipes.reduce((s, r) => s + r.ingredients.length, 0) / recipes.length).toFixed(1),
      added: newAdded.length,
      updated: newUpdated.length,
      unchanged,
      removed: removed.length,
    },
    removedSlugs: removed,
  };
  fs.writeFileSync(MANIFEST_FILE, JSON.stringify(manifest, null, 2));

  // 同步到云函数部署目录（★平铺在函数根目录：CLI 在 Windows 打包子目录会写出
  // `data\x.json` 这种反斜杠 zip 条目，云端 Linux 解不出子目录——真实故障）
  for (const [src, dst] of Object.entries(FN_FILES)) {
    fs.copyFileSync(path.join(OUT_DIR, src), path.join(FN_DIR, dst));
  }

  console.log(`[fetch] 解析成功 ${recipes.length} / ${files.length}（失败 ${failures.length}）`);
  if (failures.length) console.log('[fetch] 失败清单：\n  ' + failures.join('\n  '));
  console.log(`[fetch] 增量：新增 ${newAdded.length}，变更 ${newUpdated.length}，未变 ${unchanged}，移除 ${removed.length}`);
  console.log('[fetch] 分类统计：', JSON.stringify(byCategory));
  console.log(`[fetch] 产出：${path.relative(ROOT, DATA_FILE)} / ${path.relative(ROOT, CHANGED_FILE)} / ${path.relative(ROOT, MANIFEST_FILE)}`);
  console.log('[fetch] 已平铺复制部署副本到 cloudfunctions/recipe-sync/recipe-data.*.json');
}

main();
