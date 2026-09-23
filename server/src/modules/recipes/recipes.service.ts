import { Injectable } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { AiService } from '../ai/ai.service';
import { IncomingHttpHeaders } from 'http';
import { BUILTIN_RECIPES } from './builtin-recipes';

export interface RecipeInput {
  openid?: string;
  name: string;
  category?: string;
  flavors?: string[];
  ingredients?: string[];
  main_steps?: string[];
  brief?: string;
  difficulty?: string;
  duration_minutes?: number;
  source?: 'builtin' | 'private';
}

@Injectable()
export class RecipesService {
  private client = getSupabaseClient();

  constructor(private readonly aiService: AiService) {}

  /** 列出公开菜谱 + 用户私人菜谱，可按关键词搜索 */
  async list(openid: string, keyword?: string): Promise<RecipeInput[]> {
    try {
      const kw = keyword?.trim();
      let q = this.client
        .from('recipes')
        .select('id, openid, name, category, flavors, ingredients, main_steps, brief, difficulty, duration_minutes, source, created_at')
        .or(`openid.is.null,openid.eq.${openid}`)
        .order('created_at', { ascending: false })
        .limit(200);
      const { data, error } = await q;
      if (error) throw new Error(`菜谱查询失败: ${error.message}`);

      let rows = (data ?? []) as RecipeInput[];
      if (kw) {
        const lower = kw.toLowerCase();
        rows = rows.filter(
          (r) =>
            (r.name || '').toLowerCase().includes(lower) ||
            (r.ingredients || []).some((i) => i.toLowerCase().includes(lower)),
        );
      }
      return rows;
    } catch (e) {
      console.error('[recipes] list error:', (e as Error).message);
      throw e;
    }
  }

  /** 新建/更新私人菜谱 */
  async upsertPrivate(input: RecipeInput, id?: string): Promise<RecipeInput> {
    if (!input.openid) throw new Error('openid 不能为空');
    if (!input.name?.trim()) throw new Error('菜谱名称不能为空');
    const row = {
      openid: input.openid,
      name: input.name.trim(),
      category: input.category || '家常菜',
      flavors: input.flavors ?? [],
      ingredients: input.ingredients ?? [],
      main_steps: input.main_steps ?? [],
      brief: input.brief ?? '',
      difficulty: input.difficulty || '简单',
      duration_minutes: input.duration_minutes ?? 20,
      source: 'private',
    };
    try {
      if (id) {
        const { data, error } = await this.client
          .from('recipes')
          .update({ ...row, updated_at: new Date().toISOString() })
          .eq('id', id)
          .eq('openid', input.openid)
          .select('*')
          .single();
        if (error) throw new Error(`更新失败: ${error.message}`);
        return data as RecipeInput;
      }
      const { data, error } = await this.client
        .from('recipes')
        .insert({ ...row, created_at: new Date().toISOString(), updated_at: new Date().toISOString() })
        .select('*')
        .single();
      if (error) throw new Error(`新增失败: ${error.message}`);
      return data as RecipeInput;
    } catch (e) {
      console.error('[recipes] upsertPrivate error:', (e as Error).message);
      throw e;
    }
  }

  /** 删除私人菜谱 */
  async remove(openid: string, id: string): Promise<boolean> {
    try {
      const { error } = await this.client.from('recipes').delete().eq('id', id).eq('openid', openid);
      if (error) throw new Error(`删除失败: ${error.message}`);
      return true;
    } catch (e) {
      console.error('[recipes] remove error:', (e as Error).message);
      throw e;
    }
  }

  /**
   * 文本/语音创建私人菜谱：优先用 AI 结构化提取，失败时本地降级解析。
   */
  async createFromText(openid: string, text: string, headers?: IncomingHttpHeaders): Promise<RecipeInput> {
    if (!text?.trim()) throw new Error('请输入菜谱内容');
    const ai = await this.aiService.generateJson(
      '你是家庭菜谱整理助手。请把用户描述的一道菜结构化，仅输出 JSON。字段：name(菜名)、category(菜系/类型)、flavors(口味数组，如["微辣","家常"])、ingredients(食材数组)、main_steps(步骤数组)、brief(一句话简介)、difficulty(简单|普通|困难)、duration_minutes(数字分钟数)。不要输出除 JSON 外的任何内容',
      `请整理这道菜：${text}`,
      { temperature: 0.3 },
      headers,
    );
    const parsed = Array.isArray(ai) ? null : (ai as RecipeInput | null);
    if (parsed && typeof parsed.name === 'string' && parsed.name.trim()) {
      return this.upsertPrivate({ ...parsed, openid });
    }
    // 兜底：迁移 name 为输入首行，其余默认
    const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
    return this.upsertPrivate({
      openid,
      name: lines[0]?.slice(0, 30) || '私人菜谱',
      brief: text.slice(0, 80),
    });
  }

  /** 内置菜谱兜底：当 DB 无内置菜谱时可批量初始化 */
  async seedBuiltin(): Promise<number> {
    let count = 0;
    for (const r of BUILTIN_RECIPES) {
      const { data, error } = await this.client
        .from('recipes')
        .select('id')
        .eq('name', r.name)
        .is('openid', null)
        .maybeSingle();
      if (error) continue;
      if (!data) {
        await this.client.from('recipes').insert({
          name: r.name,
          category: r.category,
          flavors: r.flavors,
          ingredients: r.ingredients,
          main_steps: r.main_steps,
          brief: r.brief,
          difficulty: r.difficulty,
          duration_minutes: r.duration_minutes,
          source: 'builtin',
        });
        count += 1;
      }
    }
    return count;
  }
}