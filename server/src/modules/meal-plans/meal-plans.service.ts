import { Injectable } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface MealPlan {
  id?: string;
  openid: string;
  date: string;
  diners_count: number;
  selected_dishes: Array<Record<string, unknown>>;
  prep_list: Array<string>;
  cooking_steps: Array<Record<string, unknown>>;
  status: 'pending' | 'prepping' | 'cooking' | 'done';
  created_at?: string;
  updated_at?: string;
}

@Injectable()
export class MealPlansService {
  private client = getSupabaseClient();

  /** 保存（新增或按 id 更新）用餐计划，完工后用于历史展示 */
  async save(plan: MealPlan): Promise<MealPlan> {
    if (!plan.openid) throw new Error('openid 不能为空');
    const now = new Date().toISOString();
    try {
      if (plan.id) {
        const { data, error } = await this.client
          .from('meal_plans')
          .update({
            date: plan.date,
            diners_count: plan.diners_count,
            selected_dishes: plan.selected_dishes,
            prep_list: plan.prep_list,
            cooking_steps: plan.cooking_steps,
            status: plan.status,
            updated_at: now,
          })
          .eq('id', plan.id)
          .select('id, openid, date, diners_count, selected_dishes, prep_list, cooking_steps, status, created_at, updated_at')
          .single();
        if (error) throw new Error(`更新失败: ${error.message}`);
        return data as MealPlan;
      }

      const { data, error } = await this.client
        .from('meal_plans')
        .insert({
          openid: plan.openid,
          date: plan.date,
          diners_count: plan.diners_count,
          selected_dishes: plan.selected_dishes,
          prep_list: plan.prep_list,
          cooking_steps: plan.cooking_steps,
          status: plan.status || 'done',
          created_at: now,
          updated_at: now,
        })
        .select('id, openid, date, diners_count, selected_dishes, prep_list, cooking_steps, status, created_at, updated_at')
        .single();
      if (error) throw new Error(`新增失败: ${error.message}`);
      return data as MealPlan;
    } catch (e) {
      console.error('[meal-plans] save error:', (e as Error).message);
      throw e;
    }
  }

  /** 查询历史（按时间倒序），可选过滤状态 */
  async list(openid: string, status?: string, limit = 50): Promise<MealPlan[]> {
    if (!openid) throw new Error('openid 不能为空');
    try {
      let q = this.client
        .from('meal_plans')
        .select('id, openid, date, diners_count, selected_dishes, prep_list, cooking_steps, status, created_at, updated_at')
        .eq('openid', openid)
        .order('date', { ascending: false })
        .limit(limit);
      if (status) q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw new Error(`查询失败: ${error.message}`);
      return (data ?? []) as MealPlan[];
    } catch (e) {
      console.error('[meal-plans] list error:', (e as Error).message);
      throw e;
    }
  }
}