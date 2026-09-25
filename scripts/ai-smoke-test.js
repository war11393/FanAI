#!/usr/bin/env node
/**
 * hy3 大模型冒烟测试
 * ---------------------------------------------------------------
 * 【用途】一次性验证：云函数是否真的调通了 hy3，以及各 prompt 能否返回
 *   可解析的 JSON。每条用例都会打印耗时与关键结果，便于在控制台/终端对照。
 *
 * 【为什么需要它】
 *   超时被设成 3 秒时，`callFunction` 只会抛 -504003，看不出"到底哪一步坏了"。
 *   本脚本把「函数被调用 / provider 正确 / 模型返回 / JSON 可解析 / 字段齐全」
 *   拆成逐条判据，失败时能直接定位到环节。
 *
 * 【用法】
 *   1. 一个终端：node scripts/devtools-auto.js        （起自动化端口，保持运行）
 *   2. 另一个终端：node scripts/ai-smoke-test.js       （跑全部用例）
 *      node scripts/ai-smoke-test.js --only health     只跑单个用例
 *
 * 【前置条件】
 *   - 云函数 ai-text 已部署且**超时时间 ≥ 30 秒**（控制台：云函数→ai-text→配置）
 *   - 云开发控制台已开启 AI 大模型能力
 *   - 开发者工具的项目窗口与模拟器已就绪（automator 需要，见技能文档）
 */

const automator = require('miniprogram-automator');

const WS = process.env.AUTO_WS || 'ws://localhost:9421';
const argv = process.argv.slice(2);
const only = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ============================ 用例定义 ============================ */

/** 每条用例：name 展示名 | data 云函数入参 | check(res) 返回 {ok, detail} */
const CASES = [
  {
    name: 'health（确认 provider/模型/prompt 版本）',
    data: { action: 'health' },
    check: (d) => ({
      ok: d?.provider === 'cloudbase',
      detail: `provider=${d?.provider} model=${d?.textModel} prompts=${JSON.stringify(d?.promptVersions)}${d?.provider !== 'cloudbase' ? ' ← 期望 cloudbase（hy3）' : ''}`,
    }),
  },
  {
    name: 'recommend（冰箱为空：应出 3 道家常菜）',
    data: {
      action: 'recommend',
      dinersCount: 2,
      ingredients: [],
      stoves: [{ type: '燃气灶', count: 2 }],
      allergies: [],
      taboos: [],
      flavors: ['偏辣'],
      recentDishes: [],
    },
    check: (d) => {
      const n = d?.dishes?.length ?? 0;
      const names = (d?.dishes ?? []).map((x) => x.name).join('、');
      const fieldsOk = (d?.dishes ?? []).every((x) => typeof x.name === 'string' && x.name);
      return {
        ok: d?.aiOffline === false && n >= 1 && fieldsOk,
        detail: `aiOffline=${d?.aiOffline} 道数=${n} [${names}]${d?.aiOffline ? ' ← 走了本地兜底，说明大模型没通' : ''}`,
      };
    },
  },
  {
    name: 'recommend（有食材：应变出 missing_ingredients）',
    data: {
      action: 'recommend',
      dinersCount: 3,
      ingredients: ['西红柿', '鸡蛋', '土豆'],
      stoves: [{ type: '燃气灶', count: 2 }],
      allergies: [],
      taboos: [],
      flavors: [],
      recipeHints: ['西红柿炒鸡蛋', '醋溜土豆丝'],
    },
    check: (d) => {
      const dishes = d?.dishes ?? [];
      const n = dishes.length;
      const withMissing = dishes.filter((x) => (x.missing_ingredients ?? []).length > 0);
      const missingNames = withMissing.map((x) => `${x.name}缺[${x.missing_ingredients.join(',')}]`).join(' ');
      return {
        ok: d?.aiOffline === false && n >= 1 && Array.isArray(dishes[0]?.missing_ingredients),
        detail: `aiOffline=${d?.aiOffline} 道数=${n} 含缺料建议的菜=${withMissing.length} ${missingNames}`,
      };
    },
  },
  {
    name: 'cookingPlan（备菜+步骤合并返回）',
    data: {
      action: 'cookingPlan',
      dinersCount: 2,
      dishes: [
        { name: '西红柿炒鸡蛋', ingredients: ['西红柿', '鸡蛋'], main_steps: ['炒蛋', '炒番茄', '合炒'] },
        { name: '醋溜土豆丝', ingredients: ['土豆', '醋'], main_steps: ['切丝', '爆炒', '点醋'] },
      ],
      stoves: [{ type: '燃气灶', count: 2 }],
      ingredients: ['西红柿', '鸡蛋', '土豆'],
    },
    check: (d) => {
      const prep = d?.prep_list?.length ?? 0;
      const steps = d?.steps?.length ?? 0;
      return {
        ok: d?.aiOffline === false && prep >= 1 && steps >= 1,
        detail: `aiOffline=${d?.aiOffline} 备菜=${prep}项 步骤=${steps}条 tips=${(d?.cooking_tips ?? []).length}条`,
      };
    },
  },
  {
    name: 'parse（口语文本 → 结构化食材）',
    data: { action: 'parse', text: '买了两个西红柿和半斤五花肉，还有一把青菜' },
    check: (d) => {
      const n = d?.items?.length ?? 0;
      const names = (d?.items ?? []).map((x) => `${x.name}x${x.quantity}${x.unit}`).join('、');
      return {
        ok: d?.aiOffline === false && n >= 2,
        detail: `aiOffline=${d?.aiOffline} 条数=${n} [${names}]`,
      };
    },
  },
];

/** ★ 菜谱云函数的用例（D1/D2 新增能力，单独一组） */
const RECIPE_CASES = [
  {
    name: 'recipe.recentDishes（近一周记录）',
    fn: 'recipe',
    data: { action: 'recentDishes', days: 7 },
    check: (d) => ({
      ok: Array.isArray(d?.dishes),
      detail: `since=${d?.since} 条数=${(d?.dishes ?? []).length} [${(d?.dishes ?? []).join('、')}]`,
    }),
  },
  {
    name: 'recipe.matchByIngredients（食材匹配菜谱库）',
    fn: 'recipe',
    data: { action: 'matchByIngredients', ingredients: ['西红柿', '番茄', '鸡蛋', '土豆'], limit: 8 },
    check: (d) => {
      const list = d?.list ?? [];
      const names = list.map((x) => `${x.name}(${x.matchCount}/${x.totalCount})`).join('、');
      return {
        // 用「番茄」与「西红柿」同时入参：若同义词未归一，会重复计匹配
        ok: list.length > 0 && list.every((x) => x.matchCount >= 1),
        detail: `候选=${list.length} 命中总数=${d?.matched} [${names}]`,
      };
    },
  },
];

/* ============================ 执行 ============================ */

(async () => {
  const all = [...CASES, ...RECIPE_CASES];
  const list = only ? all.filter((c) => c.name.includes(only)) : all;
  if (list.length === 0) {
    console.error(`[smoke] 没有匹配 --only ${only} 的用例`);
    process.exit(1);
  }

  console.log(`[smoke] 连接自动化端口 ${WS} …`);
  let mp;
  try {
    mp = await automator.connect({ wsEndpoint: WS });
  } catch {
    console.error('[smoke] 连接失败。请先启动开发者工具自动化端口：');
    console.error('        node scripts/devtools-auto.js');
    console.error('        并确认开发者工具的项目窗口 + 模拟器已就绪。');
    process.exit(2);
  }
  console.log(`[smoke] 已连接，开始跑 ${list.length} 条用例\n`);

  let pass = 0;
  let fail = 0;

  for (const c of list) {
    const t0 = Date.now();
    // ★ 用例可指定函数名（默认 ai-text；菜谱相关走 recipe）
    const fnName = c.fn || 'ai-text';
    const res = await mp.evaluate(
      (fn, data) =>
        wx.cloud
          .callFunction({ name: fn, data })
          .then((r) => ({ ok: true, result: r.result }))
          .catch((e) => ({ ok: false, err: String((e && e.errMsg) || e) })),
      fnName,
      c.data,
    );
    const ms = Date.now() - t0;

    if (!res.ok) {
      console.log(`  ✗ ${c.name}  (${ms}ms)\n      调用失败: ${res.err}`);
      fail++;
      await sleep(400);
      continue;
    }
    if (!res.result?.success) {
      console.log(
        `  ✗ ${c.name}  (${ms}ms)\n      信封失败: code=${res.result?.code} msg=${res.result?.message}`,
      );
      fail++;
      await sleep(400);
      continue;
    }

    const v = c.check(res.result.data);
    if (v.ok) {
      console.log(`  ✓ ${c.name}  (${ms}ms)\n      ${v.detail}`);
      pass++;
    } else {
      console.log(`  ✗ ${c.name}  (${ms}ms)\n      ${v.detail}`);
      fail++;
    }
    await sleep(400);
  }

  console.log(`\n[smoke] 通过 ${pass}，失败 ${fail}`);
  if (fail > 0) {
    console.log('\n排查提示：');
    console.log('  · 报 -504003 超时 → 云函数 ai-text 的超时时间还没调大（控制台→云函数→ai-text→配置）');
    console.log('  · 全部 aiOffline=true → 大模型没通，看云函数日志里 [ai-text][xxx] ✗ 调用失败 的 err');
    console.log('  · parsed=NULL → 模型返回的不是合法 JSON，看日志里打印的原始返回文本');
    console.log('  · health 里 provider≠cloudbase → 云函数环境变量 AI_PROVIDER 被设成了别的值');
  }
  await mp.disconnect();
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error('[smoke] 致命错误:', e.message);
  process.exit(2);
});
