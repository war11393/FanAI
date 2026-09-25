/**
 * 云函数：ai-text —— 文本/视觉 AI 能力（腾讯混元 hy3）
 * ---------------------------------------------------------------
 * 【模型】hy3（腾讯混元 3），通过 wx-server-sdk 的 cloud.ai() 调用。
 *         需 wx-server-sdk >= 3.0.5-beta.1，且云开发控制台已开启 AI 能力。
 *
 * 【Provider 分支】★ 按用户要求保留外部 OpenAI 兼容接口的转发能力：
 *   AI_PROVIDER = 'cloudbase'（默认）-> cloud.ai() 调 hy3
 *   AI_PROVIDER = 'http'             -> 转发到外部 OpenAI 兼容接口
 *   切换方式：云函数「配置 -> 环境变量」中设置 AI_PROVIDER
 *   外部接口需配置 AI_HTTP_BASE_URL / AI_HTTP_API_KEY / AI_HTTP_MODEL
 *
 * 【对应原后端接口】
 *   POST /api/ai/recognize   -> action: 'recognize'   拍照识别食材（视觉）
 *   POST /api/ai/parse       -> action: 'parse'       口语文本解析
 *   POST /api/ai/recommend   -> action: 'recommend'   菜谱推荐
 *   POST /api/ai/prep        -> action: 'prep'        备菜清单
 *   POST /api/ai/cooking     -> action: 'cooking'     做菜流程
 *   GET  /api/ai/health      -> action: 'health'
 *
 * 【兜底】AI 不可用时返回本地规则兜底数据，aiOffline=true，保证功能可用。
 *         兜底逻辑与原后端 AiController 逐字对齐。
 */

const { cloud, wrap, ok, requireFields, BizError } = require('./common');
const {
  composeSystem,
  RECOMMEND,
  COOKING_PLAN,
  RECOGNIZE,
  PARSE_TEXT,
} = require('./prompts');
// ★ 食材名称归一化（同义词/基础调料判定）统一走共享模块，
//   避免与 recipe / ingredient 云函数各写一份而漂移（D1 要求）
const {
  canonicalName,
  isBasicSeasoning,
  normalizeName,
} = require('./ingredient-names');

/* ============================================================
 * 一、Provider 层：统一封装「文本生成」与「视觉识别」
 * ============================================================ */

function currentProvider() {
  const p = (process.env.AI_PROVIDER || 'cloudbase').toLowerCase();
  return p === 'http' ? 'http' : 'cloudbase';
}

/** 剥离 markdown 围栏并解析 JSON（与原后端 safeParseJson 对齐） */
function safeParseJson(text) {
  if (!text) return null;
  const trimmed = String(text).trim();
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = fenceMatch ? fenceMatch[1].trim() : trimmed;
  try {
    return JSON.parse(candidate);
  } catch {
    const start = candidate.indexOf('{');
    const end = candidate.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try {
        return JSON.parse(candidate.slice(start, end + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

/** Provider 1：云开发内置 hy3 */
async function cloudbaseChat(systemPrompt, userContent, kind, opts = {}) {
  const ai = cloud.ai();
  const model = ai.createModel('cloudbase');
  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  messages.push({ role: 'user', content: userContent });

  const res = await model.generateText({
    model: process.env.AI_TEXT_MODEL || 'hy3',
    messages,
    // 视觉识别时传入图片 fileID / URL
    ...(kind === 'image' && opts.imageUrl ? { imageUrls: [opts.imageUrl] } : {}),
  });
  return res && res.text ? res.text : '';
}

/** Provider 2：外部 OpenAI 兼容接口（保留，额度用尽后可切） */
async function httpChat(systemPrompt, userContent, kind, opts = {}) {
  const baseUrl = (process.env.AI_HTTP_BASE_URL || '').replace(/\/$/, '');
  const apiKey = process.env.AI_HTTP_API_KEY || '';
  if (!baseUrl || !apiKey) {
    throw new BizError('AI_NOT_CONFIGURED', 'AI_HTTP_BASE_URL / AI_HTTP_API_KEY 未配置');
  }
  const model =
    opts.model ||
    (kind === 'image' ? process.env.AI_HTTP_VISION_MODEL : undefined) ||
    process.env.AI_HTTP_MODEL ||
    'gpt-4o-mini';

  const messages = [];
  if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
  if (kind === 'image' && opts.imageUrl) {
    messages.push({
      role: 'user',
      content: [
        { type: 'text', text: userContent },
        // 云存储 fileID 需转成可访问 URL 才能给外部模型
        { type: 'image_url', image_url: { url: opts.imageUrl } },
      ],
    });
  } else {
    messages.push({ role: 'user', content: userContent });
  }

  const resp = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      messages,
      temperature: opts.temperature ?? 0.6,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) {
    throw new Error(`HTTP provider status ${resp.status}: ${await resp.text()}`);
  }
  const json = await resp.json();
  return json?.choices?.[0]?.message?.content ?? '';
}

/**
 * 统一调用入口：文本生成，强制返回 JSON
 * 失败返回 null，由调用方走兜底
 */
async function generateJson(systemPrompt, userPrompt, opts = {}) {
  const tag = opts.tag || 'generateJson';
  const t0 = Date.now();
  try {
    const provider = currentProvider();
    // ★ 详细日志（A3）：便于在控制台定位是哪一版 prompt、什么入参、耗时多久
    console.log(
      `[ai-text][${tag}] → 请求 provider=${provider} model=${currentModelName('text', opts)} promptVersion=${opts.promptVersion || '-'} promptChars=${(systemPrompt || '').length}+${(userPrompt || '').length} keys=${JSON.stringify(opts.inputKeys || [])}`,
    );
    if (opts.logPromptBody) {
      console.log(`[ai-text][${tag}] system=${JSON.stringify(systemPrompt)}`);
      console.log(`[ai-text][${tag}] user=${JSON.stringify(userPrompt)}`);
    }
    const text =
      provider === 'http'
        ? await httpChat(systemPrompt, userPrompt, 'text', opts)
        : await cloudbaseChat(systemPrompt, userPrompt, 'text', opts);
    const ms = Date.now() - t0;
    const parsed = safeParseJson(text);
    console.log(
      `[ai-text][${tag}] ← 返回 ${ms}ms textLen=${(text || '').length} parsed=${parsed ? 'OK' : 'NULL'}`,
    );
    if (!parsed) {
      // 解析失败时把原始文本打出来（截断），这是排查 JSON 结构问题最关键的证据
      console.error(`[ai-text][${tag}] JSON 解析失败，原始返回（前 800 字）：${String(text).slice(0, 800)}`);
    }
    return parsed;
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`[ai-text][${tag}] ✗ 调用失败 ${ms}ms provider=${currentProvider()} err=${e && e.message}`);
    return null;
  }
}

/** 当前使用的模型名（仅用于日志） */
function currentModelName(kind, opts = {}) {
  if (currentProvider() === 'http') {
    return (
      opts.model ||
      (kind === 'image' ? process.env.AI_HTTP_VISION_MODEL : undefined) ||
      process.env.AI_HTTP_MODEL ||
      'gpt-4o-mini'
    );
  }
  return process.env.AI_TEXT_MODEL || 'hy3';
}

/** 视觉识别：传入云存储 fileID、公网 URL 或 base64 data URL */
async function analyzeImage(imageUrl, userPrompt, opts = {}) {
  const tag = opts.tag || 'analyzeImage';
  const t0 = Date.now();
  try {
    const provider = currentProvider();
    const urlStr = String(imageUrl || '');
    const isDataUrl = /^data:/.test(urlStr);

    // ★ base64 体积保护：data URL 超过约 4MB 时模型侧多半也会拒，
    //   这里提前给出可读错误，而不是让请求跑到超时（用户拍的原图常有 3-8MB）
    const MAX_DATA_URL = 4 * 1024 * 1024;
    if (isDataUrl && urlStr.length > MAX_DATA_URL) {
      console.error(
        `[ai-text][${tag}] ✗ 图片过大 ${(urlStr.length / 1024 / 1024).toFixed(1)}MB（上限 ${MAX_DATA_URL / 1024 / 1024}MB），建议压缩后重试`,
      );
      return null;
    }

    console.log(
      `[ai-text][${tag}] → 视觉请求 provider=${provider} model=${currentModelName('image', opts)} imageKind=${isDataUrl ? 'base64' : 'url'} imageLen=${urlStr.length} promptVersion=${opts.promptVersion || '-'}`,
    );
    const text =
      provider === 'http'
        ? await httpChat(opts.systemPrompt || '', userPrompt, 'image', { imageUrl })
        : await cloudbaseChat(opts.systemPrompt || '', userPrompt, 'image', { imageUrl });
    const ms = Date.now() - t0;
    const parsed = safeParseJson(text);
    console.log(
      `[ai-text][${tag}] ← 返回 ${ms}ms textLen=${(text || '').length} parsed=${parsed ? 'OK' : 'NULL'}`,
    );
    if (!parsed) {
      console.error(`[ai-text][${tag}] JSON 解析失败，原始返回（前 800 字）：${String(text).slice(0, 800)}`);
    }
    return parsed;
  } catch (e) {
    const ms = Date.now() - t0;
    console.error(`[ai-text][${tag}] ✗ 视觉调用失败 ${ms}ms provider=${currentProvider()} err=${e && e.message}`);
    return null;
  }
}

/* ============================================================
 * 二、兜底逻辑（与原后端 AiController 逐字对齐）
 * ============================================================ */

/**
 * 文本兜底解析：从口语化文本中提取数字+单位+食材名
 * ★ 修复了原后端的三个缺陷（原实现会丢食材、数量恒为 1）：
 *   1. 原正则 `([0-9一-九十两]+)` 的中文数字类会把量词「个」一起吃掉，
 *      导致 "两个西红柿" 被解析为 num="两个"、unit=""、name="西红柿和半斤五花"，
 *      第二个食材「五花肉」整个丢失。
 *      修复：把量词从数字类中剥离，改为「数词 + 可选量词」两段式。
 *   2. 原实现用 cn[qRaw] 查中文数字，但 qRaw 可能含量词（"两个"），永远查不中。
 *      修复：先剥离量词再解析数字。
 *   3. 原实现要求食材必须命中硬编码的 20 个名称白名单，未命中的食材被静默丢弃。
 *      修复：保留白名单用于兜底匹配，但额外支持「量词后紧跟的 2~4 字中文」作为候选名。
 */
function fallbackParseText(text) {
  const items = [];

  // 中文数字表（含常用口语说法）
  const CN_NUM = {
    一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 半: 0.5,
  };
  const UNIT_CHARS = '斤两公斤克个颗多盒包袋把瓶根块片棵条只瓣头份';
  const UNIT_MAP = {
    斤: '斤', 两: '两', 公斤: '公斤', 克: 'g', 个: '个', 颗: '个', 盒: '盒',
    包: '袋', 袋: '袋', 把: '把', 瓶: '瓶', 根: '根', 块: '块', 片: '片',
    棵: '棵', 条: '条', 只: '只', 瓣: '瓣', 头: '个', 份: '份', 多: '个',
  };

  /**
   * 解析数量字符串，支持：
   *   "2" / "两个" / "半斤" / "十" / "十二" / "一半" / "500"
   */
  function parseQuantity(numStr) {
    if (!numStr) return null;
    const s = String(numStr).trim();

    // 纯数字（含小数）
    if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
    // "一半" -> 0.5
    if (s === '一半') return 0.5;
    // 单个中文数字（"两" / "半" / "三"）
    if (s.length === 1 && CN_NUM[s] != null) return CN_NUM[s];
    // 复合中文数字："十二" / "二十" / "二十三"
    const m = s.match(/^([一二三四五六七八九])?十([一二三四五六七八九])?$/);
    if (m) {
      const tens = m[1] ? CN_NUM[m[1]] * 10 : 10;
      const ones = m[2] ? CN_NUM[m[2]] : 0;
      return tens + ones;
    }
    return null;
  }

  // 数词段（阿拉伯数字 / 中文数字 / 一半） + 可选量词 + 食材名（2~6 汉字）
  const NUM_PAT = '(?:[0-9]+(?:\\.[0-9]+)?|一半|[一二三四五六七八九十两半]+)';
  const UNIT_PAT = `[${UNIT_CHARS}]`;
  const segRe = new RegExp(
    `(${NUM_PAT})\\s*(${UNIT_PAT})?\\s*([\\u4e00-\\u9fa5]{2,6})`,
    'g',
  );

  // 已知食材白名单（用于把候选名收敛到标准名）
  const KNOWN = [
    '西红柿', '番茄', '土豆', '黄瓜', '胡萝卜', '鸡蛋', '牛奶', '五花肉', '猪肉',
    '牛肉', '鸡肉', '豆腐', '青菜', '白菜', '洋葱', '大蒜', '生姜', '玉米',
    '青椒', '苹果', '香蕉', '紫菜', '油菜', '芹菜', '茄子', '菠菜', '冬瓜',
  ];
  /** 连接词/语气词，出现在候选名里要截断（"西红柿和半斤五花" -> "西红柿"） */
  const STOP_CHARS = '和与及跟、，,。的了还有另外再加以及';

  let m;
  const seen = new Set();
  while ((m = segRe.exec(text))) {
    const numStr = m[1];
    const unitChar = m[2] || '';
    let rawName = m[3] || '';

    // 截断到第一个连接词，避免 "西红柿和半斤五花" 这种粘连
    for (const ch of STOP_CHARS) {
      const idx = rawName.indexOf(ch);
      if (idx > 0) rawName = rawName.slice(0, idx);
    }
    if (!rawName) continue;

    // 候选名收敛：优先精确命中白名单，其次找白名单里的子串，最后用截断后的原名
    let name = KNOWN.find((n) => n === rawName)
      || KNOWN.find((n) => rawName.includes(n))
      || rawName;

    // 名称至少 2 字，且不能只是个量词
    if (name.length < 2 || UNIT_CHARS.includes(name)) continue;
    // 同一食材只记一次
    if (seen.has(name)) continue;
    seen.add(name);

    const parsed = parseQuantity(numStr);
    const quantity = parsed != null && parsed > 0 ? parsed : 1;
    const unit = UNIT_MAP[unitChar] || (unitChar ? unitChar : '个');

    items.push({ name, quantity, unit });
  }
  return items;
}


function fallbackRecommend(diners, ingredients) {
  const base = [
    {
      name: '西红柿炒鸡蛋', duration_minutes: 15, difficulty: '简单',
      ingredients: ['西红柿', '鸡蛋'], brief: '国民下饭菜，酸甜开胃',
      main_steps: ['鸡蛋打散炒熟盛出', '西红柿下锅炒出汁', '倒回鸡蛋翻匀调味'],
    },
    {
      name: '青椒土豆丝', duration_minutes: 20, difficulty: '简单',
      ingredients: ['土豆', '青椒'], brief: '爽脆清口，百搭下饭',
      main_steps: ['土豆切丝泡水去淀粉', '青椒切丝', '大火快炒加醋调味'],
    },
    {
      name: '紫菜蛋花汤', duration_minutes: 10, difficulty: '简单',
      ingredients: ['紫菜', '鸡蛋'], brief: '暖心热汤，收尾必备',
      main_steps: ['水烧开', '淋入蛋液成蛋花', '加紫菜和盐调味'],
    },
  ];
  if (ingredients && ingredients.length) {
    const has = (k) => ingredients.some((i) => i.includes(k));
    const filtered = base.filter((d) => d.ingredients.some((ig) => has(ig)));
    return filtered.length ? filtered : base;
  }
  return base;
}

function fallbackPrep(dishes) {
  const set = new Set();
  const out = [];
  const rule = {
    西红柿: '切块', 鸡蛋: '打散备用', 土豆: '切丝泡水', 青椒: '切丝',
    白菜: '洗净切段', 五花肉: '切片', 豆腐: '切块', 葱: '切葱花',
    大蒜: '拍碎剁末', 生姜: '切丝', 紫菜: '泡发', 油菜: '洗净',
  };
  for (const dish of dishes) {
    const name = dish.name;
    const matched = Object.keys(rule).filter((k) => name.includes(k));
    for (const k of matched) {
      const task = `${rule[k]}${k}`;
      if (set.has(k)) continue;
      set.add(k);
      out.push({ task, dish: name, minutes: 5, done: false });
    }
    if (matched.length === 0) {
      out.push({ task: `备好${name}所需食材`, dish: name, minutes: 3, done: false });
    }
  }
  if (out.length === 0) {
    out.push({ task: '洗净并备好今天要用的蔬菜', dish: '通用', minutes: 5, done: false });
  }
  return out.slice(0, 8);
}

function fallbackCooking(dishes) {
  const steps = [];
  dishes.forEach((d, i) => {
    steps.push({
      seq: i + 1, dish: d.name,
      instruction: `起锅烧油，开始制作${d.name}`,
      tips: '中小火更稳', can_parallel: i % 2 === 1,
    });
  });
  if (steps.length === 0) {
    steps.push({
      seq: 1, dish: '家常菜',
      instruction: '起锅烧油，下入备好的食材翻炒至熟，调味出锅',
      tips: '大火快炒更香', can_parallel: false,
    });
  }
  return { steps, final_message: '咔哒！满屋飘香，恭喜出餐，今天也要好好吃饭呀 🍳' };
}

/* ============================================================
 * 三、各 action 实现
 * ============================================================ */

/** 拍照识别食材：AI 失败时返回空并标记 aiOffline */
async function handleRecognize(event) {
  requireFields(event, ['imageUrl']);
  const system = composeSystem(RECOGNIZE);
  const user = RECOGNIZE.build(event);

  const result = await analyzeImage(event.imageUrl, user, {
    systemPrompt: system,
    tag: 'recognize',
    promptVersion: RECOGNIZE.version,
  });
  const list = Array.isArray(result?.items) ? result.items : [];
  const items = list
    .filter((it) => it && it.name)
    .map((it) => ({
      name: String(it.name),
      quantity: Number(it.quantity) || 1,
      unit: String(it.unit || '个'),
      shelfLifeDays: Number(it.shelfLifeDays) || 3,
      confidence: Number(it.confidence) ?? 1,
    }));
  console.log(`[ai-text][recognize] 解析出 ${items.length} 项食材`);
  return ok({ items, aiOffline: items.length === 0 });
}

/** 语音/文本解析：AI 失败时使用本地规则兜底 */
async function handleParse(event) {
  requireFields(event, ['text']);
  const text = event.text;
  const system = composeSystem(PARSE_TEXT);
  const user = PARSE_TEXT.build({ text });

  const result = await generateJson(system, user, {
    temperature: 0.2,
    tag: 'parseText',
    promptVersion: PARSE_TEXT.version,
  });
  const list = Array.isArray(result?.items) ? result.items : [];
  let items = list
    .filter((it) => it && it.name)
    .map((it) => ({
      name: String(it.name),
      quantity: Number(it.quantity) || 1,
      unit: String(it.unit || '个'),
    }));

  let aiOffline = false;
  if (items.length === 0) {
    aiOffline = true;
    items = fallbackParseText(text);
  }
  return ok({ items, aiOffline });
}

/**
 * 菜谱推荐
 * 情况 A：冰箱有食材 -> 用现有食材推荐 3 道菜（缺料列入 missing_ingredients）
 * 情况 B：无食材 -> 按人数推荐 3 道家常菜
 *
 * ★ D1：可传入 recipeHints（从菜谱库按食材匹配出的候选菜名，只给关键信息）
 * ★ D2：可传入 recentDishes（近一周做过的菜，让模型避开）
 */
async function handleRecommend(event) {
  requireFields(event, ['dinersCount']);
  const input = {
    dinersCount: event.dinersCount,
    ingredients: event.ingredients || [],
    stoves: event.stoves || [],
    allergies: event.allergies || [],
    taboos: event.taboos || [],
    flavors: event.flavors || [],
    recentDishes: event.recentDishes || [],
    recipeHints: event.recipeHints || [],
  };

  const system = composeSystem(RECOMMEND);
  const user = RECOMMEND.build(input);

  const result = await generateJson(system, user, {
    temperature: 0.7,
    tag: 'recommend',
    promptVersion: RECOMMEND.version,
    logPromptBody: true, // ★ 推荐是核心链路，完整打印 prompt 便于调优
    inputKeys: Object.keys(input).filter((k) => input[k] && input[k].length !== 0),
  });
  const dishes = Array.isArray(result?.dishes) ? result.dishes : [];
  let aiOffline = false;
  let final = dishes.filter((d) => d && d.name).map(normalizeDish);
  if (final.length === 0) {
    aiOffline = true;
    final = fallbackRecommend(input.dinersCount, input.ingredients);
  }
  console.log(`[ai-text][recommend] 返回 ${final.length} 道菜 aiOffline=${aiOffline}`);
  return ok({ dishes: final, aiOffline });
}

/**
 * 规整单道菜的结构，保证前端拿到的字段稳定存在
 * ★ missing_ingredients 是本次新增（缺料补充建议），前端据此展示"建议补充"
 */
function normalizeDish(d) {
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : []);
  return {
    name: String(d.name),
    duration_minutes: Number(d.duration_minutes) || 0,
    difficulty: String(d.difficulty || '中等'),
    ingredients: arr(d.ingredients),
    missing_ingredients: arr(d.missing_ingredients),
    brief: String(d.brief || ''),
    main_steps: arr(d.main_steps),
  };
}

/**
 * 备菜 + 做菜流程（★ E2 决策：合并为一次调用）
 * ---------------------------------------------------------------
 * 原先是 prep / cooking 两次独立调用，点"开始做菜"要等两轮大模型。
 * 现合并为一次：一次返回备菜清单 + 烹饪步骤 + 统筹建议。
 *
 * 【入参】dinersCount / dishes（含 name/ingredients/main_steps）/ stoves / ingredients
 * 【出参】{ prep_list, cooking_tips, steps, final_message, aiOffline }
 * ★ 兼容性：接口同时保留 prep_list 与 steps 两套字段，
 *   前端 cook 页可一次性拿到全部数据，无需改调用次数。
 */
async function handleCookingPlan(event) {
  requireFields(event, ['dinersCount']);
  const input = {
    dinersCount: event.dinersCount,
    dishes: event.dishes || [],
    stoves: event.stoves || [],
    ingredients: event.ingredients || [],
  };

  const system = composeSystem(COOKING_PLAN);
  const user = COOKING_PLAN.build(input);

  const result = await generateJson(system, user, {
    temperature: 0.5,
    tag: 'cookingPlan',
    promptVersion: COOKING_PLAN.version,
    logPromptBody: true,
    inputKeys: Object.keys(input).filter((k) => input[k] && input[k].length !== 0),
  });

  const rawPrep = Array.isArray(result?.prep_list) ? result.prep_list : [];
  const prepList = rawPrep.filter((p) => p && p.task);
  const rawSteps = Array.isArray(result?.steps) ? result.steps : [];
  const steps = rawSteps.filter((s) => s && s.instruction);

  // ★ 缺料汇总：只为**本次选中的菜**算，故在此处而非选菜页计算。
  //   现有食材已在入参里，逐道菜比对其 ingredients 即可（不额外调模型，省时省钱）。
  const missingList = computeMissing(input.dishes, input.ingredients);

  // 两者皆空才算 AI 离线（只有一个空时用兜底补齐，不整体降级）
  const aiOffline = prepList.length === 0 && steps.length === 0;

  let finalPrep = prepList;
  let finalSteps = steps;
  let tips = Array.isArray(result?.cooking_tips) ? result.cooking_tips : [];
  let finalMessage = result?.final_message || '咔哒！满屋飘香，恭喜出餐 🍳';

  if (aiOffline) {
    console.log('[ai-text][cookingPlan] 大模型无有效返回，走本地兜底');
    finalPrep = fallbackPrep(input.dishes);
    finalSteps = fallbackCooking(input.dishes).steps;
    tips = ['建议先把耗时长的炖煮类准备好，炒菜类可最后处理', '两样快手菜可轮流起锅，减少等待'];
    finalMessage = fallbackCooking(input.dishes).final_message;
  } else if (finalPrep.length === 0) {
    finalPrep = fallbackPrep(input.dishes);
  } else if (finalSteps.length === 0) {
    finalSteps = fallbackCooking(input.dishes).steps;
  }

  console.log(
    `[ai-text][cookingPlan] 备菜 ${finalPrep.length} 项 / 步骤 ${finalSteps.length} 条 aiOffline=${aiOffline}`,
  );

  return ok({
    prep_list: finalPrep,
    cooking_tips: tips,
    steps: finalSteps,
    final_message: finalMessage,
    // ★ 本次选中菜的缺料（供备菜环节一键补货）
    missing_list: missingList,
    aiOffline,
  });
}

/**
 * 常见食材的默认计量单位（按品类给建议值）
 * ★ 用户反馈：补货弹窗只有数量没有单位，"不明确"。
 *   这里给一个按品类推断的合理默认值，前端允许用户改。
 */
const UNIT_HINTS = [
  { re: /肉|排骨|鱼|虾|鸡|鸭|牛|羊|豆腐|蛤|蟹/, unit: 'g' },
  { re: /蛋/, unit: '个' },
  { re: /奶|油(?!菜)|酱|醋|酒|汁|汁/, unit: 'ml' },
  { re: /米|面|粉|糖|盐|豆|花生|干|木耳|香菇|枣/, unit: 'g' },
  { re: /菜|葱|姜|蒜|椒|瓜|茄|萝卜|薯|笋|菇|苗|叶|芦|芹|韭|瓜/, unit: '斤' },
  { re: /果|橙|苹果|梨|桃|香蕉|葡萄|莓/, unit: '个' },
];

/** 推断默认单位（兜底 '份'） */
function guessUnit(name) {
  const n = String(name || '');
  for (const h of UNIT_HINTS) if (h.re.test(n)) return h.unit;
  return '份';
}

/** 允许的单位白名单（★ 入库时归一化用，与前端选项保持一致） */
const ALLOWED_UNITS = new Set(['g', 'kg', '斤', '个', 'ml', 'L', '份', '把', '棵', '包', '盒']);

/**
 * 单位归一化（★ 入库前统一换算，保证同类食材可比较）
 *   kg → g，L → ml，其余原样
 *   未知单位 → 兜底 '份'
 */
function normalizeUnit(unit, fallbackName) {
  const u = String(unit || '').trim();
  if (!ALLOWED_UNITS.has(u)) return guessUnit(fallbackName);
  if (u === 'kg') return 'g';
  if (u === 'L') return 'ml';
  return u;
}

/** 计算缺料：返回 [{ name, dishes, quantity, unit }] */
function computeMissing(dishes = [], owned = []) {
  const ownedSet = new Set(owned.map(canonicalName).filter(Boolean));
  /** name -> Set(菜名) */
  const acc = new Map();

  for (const d of dishes) {
    const need = Array.isArray(d.ingredients) ? d.ingredients : [];
    for (const raw of need) {
      const key = canonicalName(raw);
      if (!key) continue;
      if (isBasicSeasoning(key)) continue; // 基础调料不算缺
      if (ownedSet.has(key)) continue; // 冰箱里有
      if (!acc.has(key)) acc.set(key, new Set());
      acc.get(key).add(d.name);
    }
  }

  return Array.from(acc.entries()).map(([name, dishSet]) => ({
    name,
    dishes: Array.from(dishSet),
    // ★ 给默认数量与**按品类推断的单位**，前端弹窗直接可编辑
    quantity: /肉|排骨|鱼|虾|米|面/.test(name) ? 500 : 1,
    unit: guessUnit(name),
  }));
}

/* ============================================================
 * 四、入口
 * ============================================================ */

exports.main = wrap(async (event) => {
  const action = event.action;
  const t0 = Date.now();
  // ★ 每个 action 的入口日志（A3：排查时能确认"云函数到底有没有被调用"）
  console.log(`[ai-text] ← 调用 action=${action} keys=${JSON.stringify(Object.keys(event || {}))}`);

  const out = await dispatch(action, event);
  console.log(`[ai-text] → ${action} 完成 ${Date.now() - t0}ms`);
  return out;
});

async function dispatch(action, event) {
  switch (action) {
    case 'recognize':
      return handleRecognize(event);
    case 'parse':
      return handleParse(event);
    case 'recommend':
      return handleRecommend(event);
    // ★ E2：prep / cooking 已合并为 cookingPlan；旧 action 名保留为别名，
    //   返回体包含了旧接口的全部字段，前端可平滑迁移。
    case 'cookingPlan':
    case 'prep':
    case 'cooking':
      return handleCookingPlan(event);
    case 'health':
      return ok({
        status: 'ok',
        provider: currentProvider(),
        textModel: process.env.AI_TEXT_MODEL || 'hy3',
        // ★ 供冒烟测试核对"云端跑的是哪一版 prompt"
        promptVersions: {
          recommend: RECOMMEND.version,
          cookingPlan: COOKING_PLAN.version,
          recognize: RECOGNIZE.version,
          parseText: PARSE_TEXT.version,
        },
      });
    default:
      throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
  }
}
