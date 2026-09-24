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

const JSON_INSTRUCT =
  '请只输出一个合法的 JSON 对象，不要输出任何解释、前言或 markdown 代码围栏。';

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
  try {
    const provider = currentProvider();
    const text =
      provider === 'http'
        ? await httpChat(systemPrompt, userPrompt, 'text', opts)
        : await cloudbaseChat(systemPrompt, userPrompt, 'text', opts);
    return safeParseJson(text);
  } catch (e) {
    console.error('[ai-text] generateJson error', currentProvider(), e && e.message);
    return null;
  }
}

/** 视觉识别：传入云存储 fileID 或公网 URL */
async function analyzeImage(imageUrl, userPrompt) {
  try {
    const provider = currentProvider();
    const text =
      provider === 'http'
        ? await httpChat('', userPrompt, 'image', { imageUrl })
        : await cloudbaseChat('', userPrompt, 'image', { imageUrl });
    return safeParseJson(text);
  } catch (e) {
    console.error('[ai-text] analyzeImage error', currentProvider(), e && e.message);
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
  const prompt = `你是冰箱食材识别助手。请识别这张照片中的所有食材。
要求：只输出食材名称（标准中文名）、可估算的份量数量、单位（如 g/个/棵）、以及基于常温/冷藏的保质期天数（单位：天，合理估算）。
输出格式：{"items":[{"name":"土豆","quantity":3,"unit":"个","shelfLifeDays":30}]}。最多返回 8 项。
${JSON_INSTRUCT}`;

  const result = await analyzeImage(event.imageUrl, prompt);
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
  return ok({ items, aiOffline: items.length === 0 });
}

/** 语音/文本解析：AI 失败时使用本地规则兜底 */
async function handleParse(event) {
  requireFields(event, ['text']);
  const text = event.text;
  const prompt = `你是食材录入助手。请从下面的口语化文本中提取所有食材（名词），并推断份量。
例如"买了两个西红柿和半斤五花肉" → [{"name":"西红柿","quantity":2,"unit":"个"},{"name":"五花肉","quantity":250,"unit":"g"}]。
只输出食材，输出格式：{"items":[{"name":"","quantity":1,"unit":"个"}]}。
${JSON_INSTRUCT}
文本内容：${text}`;

  const result = await generateJson('你是结构化的中文食材解析器，只输出 JSON。', prompt, {
    temperature: 0.2,
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
 * 情况 A：冰箱有食材 -> 用现有食材推荐 3 道菜
 * 情况 B：无食材 -> 按人数推荐 3 道家常菜
 */
async function handleRecommend(event) {
  requireFields(event, ['dinersCount']);
  const dinersCount = event.dinersCount;
  const ingredients = event.ingredients || [];
  const stoves = event.stoves || [];
  const allergies = event.allergies || [];
  const taboos = event.taboos || [];

  const system =
    '你是一位资深家常菜大厨。推荐菜品时需考虑人数、现有食材、灶具数量、过敏史与饮食禁忌。请只输出 JSON。';
  const user = `总就餐人数：${dinersCount} 人
现有食材：${ingredients.length ? ingredients.filter(Boolean).join('、') : '（无，冰箱空）'}
灶具情况：${stoves.length ? stoves.map((s) => `${s.type}x${s.count}`).join('、') : '（未知）'}
过敏史：${allergies.length ? allergies.join('、') : '无'}
饮食禁忌：${taboos.length ? taboos.join('、') : '无'}

${ingredients.length ? '情况 A：请推荐 3 道能用这些现有食材做出的菜（可少量补充家常调味料）。' : '情况 B：请推荐 3 道适合该人数的经典家常菜。'}
要求每道菜包含：name（菜名）、duration_minutes（预计耗时分钟）、difficulty（简单/中等/较难）、ingredients（所需食材名称数组）、brief（一句话简介）、main_steps（2-4条主要做法步骤）。
输出格式：{"dishes":[{"name":"","duration_minutes":0,"difficulty":"","ingredients":[""],"brief":"","main_steps":[""]}]}`;

  const result = await generateJson(system, user, { temperature: 0.7 });
  const dishes = Array.isArray(result?.dishes) ? result.dishes : [];
  let aiOffline = false;
  let final = dishes.filter((d) => d && d.name);
  if (final.length === 0) {
    aiOffline = true;
    final = fallbackRecommend(dinersCount, ingredients);
  }
  return ok({ dishes: final, aiOffline });
}

/** 备菜清单生成 */
async function handlePrep(event) {
  requireFields(event, ['dinersCount']);
  const { dinersCount, dishes = [] } = event;
  const system =
    '你是家庭厨房备菜助手，请为多道菜生成去重后的备菜清单（动词+食材），并给出每道菜可并行开始的顺序提示。只输出 JSON。';
  const user = `就餐人数：${dinersCount}人。选定菜品：${dishes.map((d) => d.name).join('、')}。
请生成去重后的备菜清单，每项含：task（如"切土豆丝"）、dish（所属菜名）、minutes（预估分钟）、done（false）。
同时给出 cooking_tips（1-2条统筹建议，如先炖后炒）。
输出格式：{"prep_list":[{"task":"","dish":"","minutes":0,"done":false}],"cooking_tips":[""]}`;

  const result = await generateJson(system, user, { temperature: 0.5 });
  const prepList = Array.isArray(result?.prep_list) ? result.prep_list : [];
  let final = prepList.filter((p) => p && p.task);
  let aiOffline = false;
  let tips = result?.cooking_tips ?? [];
  if (final.length === 0) {
    aiOffline = true;
    final = fallbackPrep(dishes);
    tips = ['建议先把耗时长的炖煮类准备好，炒菜类可最后处理', '两样快手菜可轮流起锅，减少等待'];
  }
  return ok({ prep_list: final, cooking_tips: tips, aiOffline });
}

/** 做菜步骤排序：结合灶具情况智能安排 */
async function handleCooking(event) {
  requireFields(event, ['dinersCount']);
  const { dinersCount, dishes = [], stoves = [] } = event;
  const system =
    '你是厨房统筹导演，结合灶具数量把多道菜的做菜步骤排成串行流程，标注每当可同时开火的并行步骤。只输出 JSON。';
  const user = `就餐人数：${dinersCount}人。灶具：${stoves.length ? stoves.map((s) => `${s.type}x${s.count}`).join('、') : '燃气灶x2, 电磁炉x1'}。
菜品详情：${JSON.stringify(dishes)}。
请生成做菜流程：steps 数组，每项含 seq（序号）、dish（菜名）、instruction（一句话当前步骤）、tips（可选小贴士）、can_parallel（是否可与其他步骤并行）。
并给出 final_message（出餐祝贺语）。
输出格式：{"steps":[{"seq":1,"dish":"","instruction":"","tips":"","can_parallel":false}],"final_message":""}`;

  const result = await generateJson(system, user, { temperature: 0.5 });
  const steps = Array.isArray(result?.steps) ? result.steps : [];
  const final = steps.filter((s) => s && s.instruction);
  if (final.length === 0) {
    const built = fallbackCooking(dishes);
    return ok({ steps: built.steps, final_message: built.final_message, aiOffline: true });
  }
  return ok({
    steps: final,
    final_message: result?.final_message ?? '大功告成，开饭啦！',
    aiOffline: false,
  });
}

/* ============================================================
 * 四、入口
 * ============================================================ */

exports.main = wrap(async (event) => {
  const action = event.action;

  switch (action) {
    case 'recognize':
      return handleRecognize(event);
    case 'parse':
      return handleParse(event);
    case 'recommend':
      return handleRecommend(event);
    case 'prep':
      return handlePrep(event);
    case 'cooking':
      return handleCooking(event);
    case 'health':
      return ok({
        status: 'ok',
        provider: currentProvider(),
        textModel: process.env.AI_TEXT_MODEL || 'hy3',
      });
    default:
      throw new BizError('INVALID_ACTION', `未知 action: ${action}`);
  }
});
