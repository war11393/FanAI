import {
  Controller, Post, Body, Get, HttpCode, Header as RouteHeader,
} from '@nestjs/common';
import { Headers } from '@nestjs/common';
import { IncomingHttpHeaders } from 'http';
import { AiService } from './ai.service';

const JSON_INSTRUCT = '请只输出一个合法的 JSON 对象，不要输出任何解释、前言或 markdown 代码围栏。';

interface RecognizePayload { openid: string; imageUrl: string }
interface ParsePayload { openid: string; text: string }
interface RecommendPayload {
  openid: string;
  dinersCount: number;
  ingredients?: string[];
  stoves?: Array<{ type: string; count: number }>;
  allergies?: string[];
  taboos?: string[];
}
interface MealPlanPayload extends RecommendPayload {
  dishes: Array<{ name: string }>;
  stoves?: Array<{ type: string; count: number }>;
}

@Controller('ai')
export class AiController {
  constructor(private readonly ai: AiService) {}

  /** 文本兜底解析：从口语化文本中提取数字+单位+食材名 */
  private fallbackParseText(text: string): Array<{ name: string; quantity: number; unit: string }> {
    const items: Array<{ name: string; quantity: number; unit: string }> = [];
    // 匹配 [数字][半/斤/两/盒/个/颗/把/袋/瓶/升] + 食材
    const segRe = /([0-9一-九十两]+)\s*(斤|两|公斤|克|个|颗|多|盒|包|袋|把|瓶|根|块|片)?\s*([\u4e00-\u9fa5]{2,8})/g;
    let m: RegExpExecArray | null;
    while ((m = segRe.exec(text))) {
      const unitMap: Record<string, string> = {
        斤: '斤', 两: '两', 公斤: '公斤', 克: 'g', 个: '个', 颗: '个', 盒: '盒',
        包: '袋', 袋: '袋', 把: '把', 瓶: '瓶', 根: '根', 块: '块', 片: '片',
      };
      const names = ['西红柿', '土豆', '黄瓜', '胡萝卜', '鸡蛋', '牛奶', '五花肉', '猪肉', '牛肉', '鸡肉', '豆腐', '青菜', '白菜', '洋葱', '大蒜', '生姜', '玉米', '青椒', '苹果', '香蕉'];
      const name = names.find((n) => m![3].includes(n) || n.includes(m![3]));
      if (!name) continue;
      const qRaw = m[1];
      let q = parseFloat(qRaw);
      if (qRaw === '两') q = 2;
      else if (qRaw === '一半') q = 0.5;
      else if (/[一二三四五六七八九十]/.test(qRaw)) {
        const cn: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };
        q = cn[qRaw] ?? 1;
      }
      const unit = unitMap[m[2] || ''] || (m[2] === '斤' ? '斤' : '个');
      items.push({ name, quantity: isNaN(q) || !q ? 1 : q, unit });
    }
    return items;
  }

  /** 拍照识别食材：AI 失败时返回空并标记 */
  @Post('recognize')
  @HttpCode(200)
  @RouteHeader('Cache-Control', 'no-cache')
  async recognize(@Body() body: RecognizePayload, @Headers() headers: IncomingHttpHeaders) {
    const { openid, imageUrl } = body;
    if (!imageUrl) return { code: 400, msg: 'imageUrl 不能为空', data: [] };
    const prompt = `你是冰箱食材识别助手。请识别这张照片中的所有食材。
要求：只输出食材名称（标准中文名）、可估算的份量数量、单位（如 g/个/棵）、以及基于常温/冷藏的保质期天数（单位：天，合理估算）。
输出格式：{"items":[{"name":"土豆","quantity":3,"unit":"个","shelfLifeDays":30}]}。最多返回 8 项。
${JSON_INSTRUCT}`;
    const result = await this.ai.analyzeImage(imageUrl, prompt, headers);
    const list = Array.isArray((result as any)?.items) ? (result as any).items : [];
    const items = list
      .filter((it: any) => it && it.name)
      .map((it: any) => ({
        name: String(it.name),
        quantity: Number(it.quantity) || 1,
        unit: String(it.unit || '个'),
        shelfLifeDays: Number(it.shelfLifeDays) || 3,
        confidence: Number(it.confidence) ?? 1,
        _openid: openid,
      }));
    return { code: 200, msg: 'success', data: items, aiOffline: items.length === 0 };
  }

  /** 语音/文本解析：AI 失败时使用本地规则兜底 */
  @Post('parse')
  @HttpCode(200)
  async parse(@Body() body: ParsePayload, @Headers() headers: IncomingHttpHeaders) {
    const { openid, text } = body;
    if (!text) return { code: 400, msg: 'text 不能为空', data: [] };
    const prompt = `你是食材录入助手。请从下面的口语化文本中提取所有食材（名词），并推断份量。
例如"买了两个西红柿和半斤五花肉" → [{"name":"西红柿","quantity":2,"unit":"个"},{"name":"五花肉","quantity":250,"unit":"g"}]。
只输出食材，输出格式：{"items":[{"name":"","quantity":1,"unit":"个"}]}。
${JSON_INSTRUCT}
文本内容：${text}`;
    const result = await this.ai.generateJson(
      '你是结构化的中文食材解析器，只输出 JSON。',
      prompt,
      { temperature: 0.2 },
      headers,
    );
    const list = Array.isArray((result as any)?.items) ? (result as any).items : [];
    let items = list
      .filter((it: any) => it && it.name)
      .map((it: any) => ({
        name: String(it.name),
        quantity: Number(it.quantity) || 1,
        unit: String(it.unit || '个'),
        _openid: openid,
      }));
    let aiOffline = false;
    if (items.length === 0) {
      aiOffline = true;
      items = this.fallbackParseText(text).map((it) => ({ ...it, _openid: openid }));
    }
    return { code: 200, msg: 'success', data: items, aiOffline };
  }

  /**
   * AI 菜谱推荐（核心亮点）
   * 情况 A：冰箱有食材 → 用现有食材推荐 3 道菜
   * 情况 B：无食材 → 按人数推荐 3 道家常菜
   */
  @Post('recommend')
  @HttpCode(200)
  async recommend(@Body() body: RecommendPayload, @Headers() headers: IncomingHttpHeaders) {
    const { openid, dinersCount, ingredients = [], stoves = [], allergies = [], taboos = [] } = body;
    // 构造 Prompt（强制 JSON）
    const system = '你是一位资深家常菜大厨。推荐菜品时需考虑人数、现有食材、灶具数量、过敏史与饮食禁忌。请只输出 JSON。';
    const user = `总就餐人数：${dinersCount} 人
现有食材：${ingredients.length ? ingredients.filter(Boolean).join('、') : '（无，冰箱空）'}
灶具情况：${stoves.length ? stoves.map((s: any) => `${s.type}x${s.count}`).join('、') : '（未知）'}
过敏史：${allergies.length ? allergies.join('、') : '无'}
饮食禁忌：${taboos.length ? taboos.join('、') : '无'}

${ingredients.length ? '情况 A：请推荐 3 道能用这些现有食材做出的菜（可少量补充家常调味料）。' : '情况 B：请推荐 3 道适合该人数的经典家常菜。'}
要求每道菜包含：name（菜名）、duration_minutes（预计耗时分钟）、difficulty（简单/中等/较难）、ingredients（所需食材名称数组）、brief（一句话简介）、main_steps（2-4条主要做法步骤）。
输出格式：{"dishes":[{"name":"","duration_minutes":0,"difficulty":"","ingredients":[""],"brief":"","main_steps":[""]}]}`;
    const result = await this.ai.generateJson(system, user, { temperature: 0.7 }, headers);
    const dishes = Array.isArray((result as any)?.dishes) ? (result as any).dishes : [];
    let aiOffline = false;
    let final = dishes.filter((d: any) => d && d.name);
    if (final.length === 0) {
      aiOffline = true;
      final = this.fallbackRecommend(dinersCount, ingredients);
    }
    return { code: 200, msg: 'success', data: { dishes: final, aiOffline } };
  }

  /** 备菜清单生成：汇总选定菜品，去重生成备菜项 */
  @Post('prep')
  @HttpCode(200)
  async prep(@Body() body: MealPlanPayload, @Headers() headers: IncomingHttpHeaders) {
    const { openid, dinersCount, dishes = [] } = body;
    const system = '你是家庭厨房备菜助手，请为多道菜生成去重后的备菜清单（动词+食材），并给出每道菜可并行开始的顺序提示。只输出 JSON。';
    const user = `就餐人数：${dinersCount}人。选定菜品：${dishes.map((d: any) => d.name).join('、')}。
请生成去重后的备菜清单，每项含：task（如"切土豆丝"）、dish（所属菜名）、minutes（预估分钟）、done（false）。
同时给出 cooking_tips（1-2条统筹建议，如先炖后炒）。
输出格式：{"prep_list":[{"task":"","dish":"","minutes":0,"done":false}],"cooking_tips":[""]}`;
    const result = await this.ai.generateJson(system, user, { temperature: 0.5 }, headers);
    const prepList = Array.isArray((result as any)?.prep_list) ? (result as any).prep_list : [];
    let final = prepList.filter((p: any) => p && p.task);
    let aiOffline = false;
    let tips: string[] = (result as any)?.cooking_tips ?? [];
    if (final.length === 0) {
      aiOffline = true;
      final = this.fallbackPrep(dishes);
      tips = ['建议先把耗时长的炖煮类准备好，炒菜类可最后处理', '两样快手菜可轮流起锅，减少等待'];
    }
    return { code: 200, msg: 'success', data: { prep_list: final, cooking_tips: tips, aiOffline } };
  }

  /** 做菜步骤排序：结合灶具情况智能安排 */
  @Post('cooking')
  @HttpCode(200)
  async cooking(@Body() body: MealPlanPayload, @Headers() headers: IncomingHttpHeaders) {
    const { openid, dinersCount, dishes = [], stoves = [] } = body;
    const system = '你是厨房统筹导演，结合灶具数量把多道菜的做菜步骤排成串行流程，标注每当可同时开火的并行步骤。只输出 JSON。';
    const user = `就餐人数：${dinersCount}人。灶具：${stoves.length ? stoves.map((s: any) => `${s.type}x${s.count}`).join('、') : '燃气灶x2, 电磁炉x1'}。
菜品详情：${JSON.stringify(dishes)}。
请生成做菜流程：steps 数组，每项含 seq（序号）、dish（菜名）、instruction（一句话当前步骤）、tips（可选小贴士）、can_parallel（是否可与其他步骤并行）。
并给出 final_message（出餐祝贺语）。
输出格式：{"steps":[{"seq":1,"dish":"","instruction":"","tips":"","can_parallel":false}],"final_message":""}`;
    const result = await this.ai.generateJson(system, user, { temperature: 0.5 }, headers);
    let steps = Array.isArray((result as any)?.steps) ? (result as any).steps : [];
    let final = steps.filter((s: any) => s && s.instruction);
    let aiOffline = false;
    if (final.length === 0) {
      aiOffline = true;
      const built = this.fallbackCooking(dishes);
      final = built.steps;
      return { code: 200, msg: 'success', data: { steps: final, final_message: built.final_message, aiOffline } };
    }
    return {
      code: 200, msg: 'success',
      data: { steps: final, final_message: (result as any)?.final_message ?? '大功告成，开饭啦！', aiOffline },
    };
  }

  /** 健康检查 */
  @Get('health')
  async health() {
    return { code: 200, msg: 'success', data: { status: 'ok' } };
  }

  // ===== 离线兜底数据（AI 不可用时保证功能可用） =====
  private fallbackRecommend(diners: number, ingredients: string[]): Array<Record<string, unknown>> {
    const base: Array<Record<string, unknown>> = [
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
    // 情况 A：根据食材匹配
    if (ingredients.length) {
      const has = (k: string) => ingredients.some((i) => i.includes(k));
      return base.filter((d) => (d.ingredients as string[]).some((ig) => has(ig)));
    }
    return base;
  }

  private fallbackPrep(dishes: Array<{ name: string }>): Array<Record<string, unknown>> {
    const set = new Set<string>();
    const out: Array<Record<string, unknown>> = [];
    const rule: Record<string, string> = {
      '西红柿': '切块', '鸡蛋': '打散备用', '土豆': '切丝泡水', '青椒': '切丝',
      '白菜': '洗净切段', '五花肉': '切片', '豆腐': '切块', '葱': '切葱花',
      '大蒜': '拍碎剁末', '生姜': '切丝', '紫菜': '泡发', '油菜': '洗净',
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
      if (matched.length === 0) out.push({ task: `备好${name}所需食材`, dish: name, minutes: 3, done: false });
    }
    if (out.length === 0) out.push({ task: '洗净并备好今天要用的蔬菜', dish: '通用', minutes: 5, done: false });
    return out.slice(0, 8);
  }

  private fallbackCooking(dishes: Array<{ name: string }>) {
    const steps: Array<Record<string, unknown>> = [];
    dishes.forEach((d, i) => {
      steps.push({ seq: i + 1, dish: d.name, instruction: `起锅烧油，开始制作${d.name}`, tips: '中小火更稳', can_parallel: i % 2 === 1 });
    });
    if (steps.length === 0) steps.push({ seq: 1, dish: '家常菜', instruction: '起锅烧油，下入备好的食材翻炒至熟，调味出锅', tips: '大火快炒更香', can_parallel: false });
    return { steps, final_message: '咔哒！满屋飘香，恭喜出餐，今天也要好好吃饭呀 🍳' };
  }
}