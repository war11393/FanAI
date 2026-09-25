/**
 * 食材名称归一化（共享模块）
 * ---------------------------------------------------------------
 * ★ 用户要求（D1）："食材的命名要有一定的适应性"。
 *   同一食材在不同来源写作不同名字（西红柿/番茄、土豆/马铃薯），
 *   归一化后才能在「菜谱匹配 / 库存合并 / 缺料计算」三处一致比对。
 *
 * 【设计】集中在此，由 sync-shared.js 分发到各云函数目录。
 *   改同义词只需改本文件的 SYNONYMS 表，逻辑无需变动。
 */

/**
 * 同义词表：别名 → 主名
 * ★ 主名选取原则：用大众最常用的写法（西红柿 而非 番茄）。
 *   新增词条时只需追加一行，不影响已有逻辑。
 */
const SYNONYMS = {
  // 茄果类
  番茄: '西红柿',
  圣女果: '小番茄',
  樱桃番茄: '小番茄',
  // 根茎类
  马铃薯: '土豆',
  洋芋: '土豆',
  土豆仔: '土豆',
  红萝卜: '胡萝卜',
  萝卜: '白萝卜',
  // 叶菜类
  洋白菜: '卷心菜',
  圆白菜: '卷心菜',
  包菜: '卷心菜',
  大白菜: '白菜',
  // 椒类
  青椒: '柿子椒',
  尖椒: '辣椒',
  红椒: '辣椒',
  小米椒: '小米辣',
  // 肉蛋类
  鸡子: '鸡蛋',
  猪五花: '五花肉',
  五花: '五花肉',
  鸡胸: '鸡胸肉',
  // 菌豆制品
  香菇: '香菇',
  冬菇: '香菇',
  豆付: '豆腐',
};

/** 基础调味料：缺料建议与补货时排除（用户家里通常都有，不该提示去买） */
const BASIC_SEASONINGS = new Set([
  '盐', '糖', '白糖', '冰糖', '红糖',
  '油', '食用油', '植物油', '花生油', '橄榄油', '香油', '芝麻油', '辣椒油',
  '酱油', '生抽', '老抽', '醋', '香醋', '陈醋', '白醋', '料酒', '黄酒', '蚝油',
  '味精', '鸡精', '胡椒粉', '白胡椒粉', '黑胡椒', '花椒', '淀粉', '生粉',
  '水', '清水', '豆瓣酱', '甜面酱', '番茄酱', '芝麻',
]);

/** 归一化：去括号补充说明（如「酱油（生抽）」）、去空格 */
function normalizeName(s) {
  return String(s || '')
    .replace(/[（(].*?[)）]/g, '')
    .replace(/\s+/g, '')
    .trim();
}

/** 取归一名（用于跨来源比对与合并） */
function canonicalName(s) {
  const n = normalizeName(s);
  if (!n) return '';
  return SYNONYMS[n] || n;
}

/** 是否为基础调味料（归一后判定） */
function isBasicSeasoning(s) {
  return BASIC_SEASONINGS.has(canonicalName(s));
}

/**
 * 归一化整个食材数组：归名 + 去重 + 去空
 * 用于菜谱 ingredients 与冰箱库存的比对准备。
 */
function canonicalList(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const c = canonicalName(raw);
    if (!c || seen.has(c)) continue;
    seen.add(c);
    out.push(c);
  }
  return out;
}

module.exports = {
  SYNONYMS,
  BASIC_SEASONINGS,
  normalizeName,
  canonicalName,
  isBasicSeasoning,
  canonicalList,
};
