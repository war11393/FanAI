/**
 * 大模型 Prompt 集中维护
 * ---------------------------------------------------------------
 * ★ 所有与本项目交互大模型的 prompt 都收敛在这里，便于统一调优。
 * ★ 本文件位于 `_shared/`，由 `node cloudfunctions/sync-shared.js` 分发到各
 *   云函数目录（云函数无法 require 上级目录）。改完**必须重新分发并部署**。
 *
 * 【文件结构约定】
 *   每个 prompt 导出为一个对象：
 *     {
 *       version: 'v1',              // 改动时递增，便于对照日志定位是哪一版在跑
 *       system:  '...',             // system message
 *       build(input) => 'user 文本', // 由入参拼 user message（可能是函数）
 *       schema:  '...JSON 结构说明', // 期望的结构（供 build 引用 + 文档作用）
 *       example: {...},             // few-shot 示例（B3 稳定性关键）
 *     }
 *
 * 【稳定性三件套】（B3 决策）
 *   1. JSON_INSTRUCT —— 统一的"只输出 JSON"硬约束
 *   2. schema        —— 逐字段说明
 *   3. example       —— 真实可解析的示例（few-shot，显著降低解析失败率）
 *
 * 【日志约定】
 *   每个 prompt 的 version 会打进云函数日志（见 index.js 的 logPrompt），
 *   排查时可用它确认"云端跑的是哪一版 prompt"。
 */

/** ★ 所有 prompt 共用的 JSON 输出硬约束 */
const JSON_INSTRUCT =
  '【输出格式硬约束】只输出一个合法的 JSON 对象，不要输出任何解释、前言、客套话或 markdown 代码围栏（不要 ```json）。' +
  '所有字符串值不可包含未转义的换行符。字段名必须与下述结构完全一致，不要增删字段。';

/** 拼装完整的 system 文本（system 描述 + JSON 约束 + 结构说明 + 示例） */
function composeSystem({ system, schema, example }) {
  const parts = [system, JSON_INSTRUCT];
  if (schema) parts.push(`【输出结构】${schema}`);
  if (example) {
    parts.push(`【输出示例】\n${JSON.stringify(example)}`);
  }
  return parts.join('\n\n');
}

/* ============================================================
 * 一、AI 菜谱推荐（首页「让 AI 帮我决定」）
 * ============================================================ */

/**
 * 输入契约（由 handleRecommend 组装）：
 *   dinersCount  就餐总人数
 *   ingredients  现有食材名称数组
 *   stoves       灶具 [{type, count}]
 *   allergies    过敏史 string[]
 *   taboos       饮食禁忌 string[]
 *   flavors      口味偏好 string[]
 *   recentDishes 近一周做过的菜名 string[]（避免重复，D2）
 *   recipeHints  菜谱库匹配到的候选菜名 string[]（D1：只给关键信息，不给做法）
 */
const RECOMMEND = {
  version: 'v2',
  system:
    '你是一位资深家常菜大厨，擅长根据现有食材和厨房条件安排一桌好菜。' +
    '推荐时需综合考虑：就餐人数（份量）、现有食材（尽量用掉）、灶具数量（决定能同时做几道）、' +
    '过敏史与饮食禁忌（绝对不可违反）、口味偏好，以及近一周吃过的菜（尽量换花样）。',
  schema: `{
  "dishes": [
    {
      "name": "菜名",
      "duration_minutes": 30,
      "difficulty": "简单|中等|较难",
      "ingredients": ["所需食材名"],
      "missing_ingredients": ["现有食材里没有、需要补充的"],
      "brief": "一句话简介",
      "main_steps": ["2-4条主要做法"]
    }
  ]
}`,
  example: {
    dishes: [
      {
        name: '西红柿炒鸡蛋',
        duration_minutes: 15,
        difficulty: '简单',
        ingredients: ['西红柿', '鸡蛋', '葱'],
        missing_ingredients: ['葱'],
        brief: '酸甜下饭的国民家常菜',
        main_steps: ['鸡蛋打散炒至定型盛出', '西红柿切块炒出汁', '回锅合炒调味'],
      },
    ],
  },
  build(input) {
    const {
      dinersCount = 2,
      ingredients = [],
      stoves = [],
      allergies = [],
      taboos = [],
      flavors = [],
      recentDishes = [],
      recipeHints = [],
    } = input || {};

    const hasIngredients = ingredients.filter(Boolean).length > 0;
    const lines = [
      `总就餐人数：${dinersCount} 人`,
      `现有食材：${hasIngredients ? ingredients.filter(Boolean).join('、') : '（冰箱为空）'}`,
      `灶具情况：${
        stoves.length ? stoves.map((s) => `${s.type}x${s.count}`).join('、') : '（未知，按燃气灶x2估算）'
      }`,
      `过敏史：${allergies.length ? allergies.join('、') : '无'}`,
      `饮食禁忌：${taboos.length ? taboos.join('、') : '无'}`,
      `口味偏好：${flavors.length ? flavors.join('、') : '无特别偏好'}`,
      `近一周已吃过（尽量避开）：${recentDishes.length ? recentDishes.join('、') : '（无记录）'}`,
    ];
    if (recipeHints.length) {
      lines.push(
        `菜谱库中与你食材匹配的候选（优先从中挑选，找不到合适的再用其他家常菜）：${recipeHints.join('、')}`,
      );
    }

    lines.push(
      '',
      hasIngredients
        ? '请推荐 3 道菜，优先用光现有食材。'
        : '冰箱为空，请推荐 3 道适合该人数的经典家常菜，所需食材全部列入 ingredients。',
      '份量要匹配就餐人数。',
      // ★ missing_ingredients 的判定口径（实测教训：不写清楚会把盐油糖都算进来）
      '【missing_ingredients 判定口径】只列「主要食材」，即用户需要专门去买的菜肉蛋奶豆及葱姜蒜辣椒等配菜。' +
        '严禁列入基础调味料（盐、糖、油、酱油、醋、料酒、味精、鸡精、胡椒粉、淀粉、水等），除非用户明确表示没有。' +
        '若一道菜只缺基础调味料，则 missing_ingredients 返回空数组 []。',
    );

    return lines.join('\n');
  },
};

/* ============================================================
 * 二、备菜 + 做菜流程（E2 合并为一次调用）
 * ============================================================ */

/**
 * 输入契约：
 *   dinersCount  就餐人数
 *   dishes       选中菜品（含 name/ingredients/main_steps）
 *   stoves       灶具 [{type, count}]
 *   ingredients  现有食材（用于标记缺料）
 */
const COOKING_PLAN = {
  version: 'v1',
  system:
    '你是家庭厨房的备菜与统筹导演。给定几道菜、现有食材、灶具数量和就餐人数，' +
    '你要同时完成两件事：① 生成去重后的备菜清单（每项是「动词+食材」，标注属于哪道菜、预估耗时）；' +
    '② 结合灶具数量，把多道菜的做菜步骤排成可执行的串行流程，并标出可以同时进行的并行步骤。' +
    '排序原则：耗时长的（炖/煮/蒸）先开始，快炒类后做，避免等锅。',
  schema: `{
  "prep_list": [
    { "task": "切土豆丝", "dish": "醋溜土豆丝", "minutes": 5, "done": false }
  ],
  "cooking_tips": ["1-2条统筹建议"],
  "steps": [
    {
      "seq": 1,
      "dish": "醋溜土豆丝",
      "instruction": "一句话当前动作",
      "tips": "可选小贴士",
      "can_parallel": false
    }
  ],
  "final_message": "出餐祝贺语"
}`,
  example: {
    prep_list: [
      { task: '土豆去皮切丝', dish: '醋溜土豆丝', minutes: 6, done: false },
      { task: '西红柿切块、鸡蛋打散', dish: '西红柿炒鸡蛋', minutes: 3, done: false },
    ],
    cooking_tips: ['先起锅炖煮类，炒菜最后做更热乎', '两道快炒可轮流起锅，减少空灶等待'],
    steps: [
      { seq: 1, dish: '醋溜土豆丝', instruction: '热油下花椒爆香后捞出', tips: '油温别太高', can_parallel: false },
      { seq: 2, dish: '西红柿炒鸡蛋', instruction: '另起一灶炒鸡蛋', tips: '', can_parallel: true },
    ],
    final_message: '咔哒！满屋飘香，开饭啦 🍳',
  },
  build(input) {
    const { dinersCount = 2, dishes = [], stoves = [], ingredients = [] } = input || {};
    const stoveText = stoves.length
      ? stoves.map((s) => `${s.type}x${s.count}`).join('、')
      : '（未知，按燃气灶x2估算）';

    // 菜品详情：只给关键信息（菜名 + 所需食材 + 主要步骤），不塞完整长文（D1 精神）
    const dishText = dishes
      .map((d) => {
        const ig = Array.isArray(d.ingredients) && d.ingredients.length ? d.ingredients.join('、') : '未标注';
        const steps =
          Array.isArray(d.main_steps) && d.main_steps.length ? d.main_steps.join(' → ') : '未标注';
        return `- ${d.name}｜所需食材：${ig}｜主要步骤：${steps}`;
      })
      .join('\n');

    return [
      `就餐人数：${dinersCount} 人`,
      `灶具：${stoveText}`,
      `现有食材：${ingredients.filter(Boolean).length ? ingredients.filter(Boolean).join('、') : '（冰箱为空）'}`,
      '',
      '本次要做的菜：',
      dishText,
      '',
      `请为这 ${dishes.length} 道菜生成备菜清单与做菜流程（份量按 ${dinersCount} 人）。`,
      '备菜清单要去重：同一种食材的多道菜切配可合并成一项。',
    ].join('\n');
  },
};

/* ============================================================
 * 三、拍照识别食材（图生文）
 * ============================================================ */

/**
 * 输入契约：imageUrl（base64 data URL 或可访问 URL）
 * ★ F2 决策：图片不落云存储，直接 base64 传给模型，调用后即销毁
 */
const RECOGNIZE = {
  version: 'v1',
  system:
    '你是冰箱/厨房食材识别助手。看图识别出其中的食材，给出标准中文名、可估算的数量与单位、' +
    '以及常温或冷藏条件下的保质期天数（合理估算）。只识别能吃的食材，忽略包装盒、餐具、背景杂物。',
  schema: `{
  "items": [
    { "name": "土豆", "quantity": 3, "unit": "个", "shelfLifeDays": 30 }
  ]
}`,
  example: {
    items: [
      { name: '西红柿', quantity: 4, unit: '个', shelfLifeDays: 7 },
      { name: '五花肉', quantity: 500, unit: 'g', shelfLifeDays: 3 },
    ],
  },
  build() {
    return '请识别这张照片中的所有食材，最多返回 8 项。按数量从多到少排列。';
  },
};

/* ============================================================
 * 四、口语文本解析食材
 * ============================================================ */

const PARSE_TEXT = {
  version: 'v1',
  system:
    '你是结构化的中文食材解析器。从用户口语化描述中提取食材（名词），推断数量与单位。' +
    '只提取食材，忽略「买了/还有一些/顺便」这类无意义词。',
  schema: `{
  "items": [
    { "name": "西红柿", "quantity": 2, "unit": "个" }
  ]
}`,
  example: {
    items: [
      { name: '西红柿', quantity: 2, unit: '个' },
      { name: '五花肉', quantity: 250, unit: 'g' },
    ],
  },
  build(input) {
    const text = (input && input.text) || '';
    return `例如「买了两个西红柿和半斤五花肉」→ {"items":[{"name":"西红柿","quantity":2,"unit":"个"},{"name":"五花肉","quantity":250,"unit":"g"}]}。\n\n文本内容：${text}`;
  },
};

/** 全部 prompt 的注册表（便于遍历与日志） */
const PROMPTS = {
  recommend: RECOMMEND,
  cookingPlan: COOKING_PLAN,
  recognize: RECOGNIZE,
  parseText: PARSE_TEXT,
};

module.exports = {
  JSON_INSTRUCT,
  composeSystem,
  PROMPTS,
  RECOMMEND,
  COOKING_PLAN,
  RECOGNIZE,
  PARSE_TEXT,
};
