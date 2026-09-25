/**
 * 食材单位常量与工具
 * ---------------------------------------------------------------
 * ★ 用户要求：单位做成「可选」，但入库时归一化（后端 ingredient 云函数负责）。
 *   这里只提供前端可选项与默认值推断，保证与后端白名单一致。
 */

/** 可选单位（与 cloudfunctions/ingredient/index.js 的 ALLOWED_UNITS 保持一致） */
export const UNIT_OPTIONS = ['g', 'kg', '斤', '个', 'ml', 'L', '份', '把', '棵', '包', '盒'] as const;

export type UnitOption = (typeof UNIT_OPTIONS)[number];

/**
 * 按食材名推断默认单位（与后端 guessUnitByName 同源逻辑，仅用于初值）
 * ★ 保持前后端一致的**推断结果**，用户不改也能得到合理值。
 */
const UNIT_HINTS: Array<{ re: RegExp; unit: UnitOption }> = [
  { re: /肉|排骨|鱼|虾|鸡|鸭|牛|羊|豆腐|蛤|蟹/, unit: 'g' },
  { re: /蛋/, unit: '个' },
  { re: /奶|酱|醋|酒|汁/, unit: 'ml' },
  { re: /米|面|粉|糖|盐|豆|花生|干|木耳|香菇|枣/, unit: 'g' },
  { re: /菜|葱|姜|蒜|椒|瓜|茄|萝卜|薯|笋|菇|苗|叶|芦|芹|韭/, unit: '斤' },
  { re: /果|橙|苹果|梨|桃|香蕉|葡萄|莓/, unit: '个' },
];

export function guessUnit(name: string): UnitOption {
  const n = String(name || '');
  for (const h of UNIT_HINTS) if (h.re.test(n)) return h.unit;
  return '份';
}

/** 按食材名推断默认数量（肉类按克、蔬菜按份/斤、蛋按个） */
export function guessQuantity(name: string, unit: UnitOption): number {
  void name;
  if (unit === 'g') return 500;
  if (unit === '斤') return 1;
  if (unit === 'ml') return 500;
  return 1;
}
