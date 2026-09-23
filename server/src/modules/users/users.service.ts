import { Injectable } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';

export interface UserProfile {
  id?: string;
  openid: string;
  family_id?: string | null;
  regular_members: number;
  stoves: Array<{ type: string; count: number }>;
  pots: string[];
  allergies: string[];
  taboos: string[];
  flavors: string[];
  voice_control_on: boolean;
}

const DEFAULT_PROFILE = (openid: string) => ({
  openid,
  regular_members: 2,
  stoves: [{ type: '燃气灶', count: 2 }],
  pots: ['炒锅', '汤锅'],
  allergies: [],
  taboos: [],
  flavors: [],
  voice_control_on: false,
});

@Injectable()
export class UsersService {
  private client = getSupabaseClient();

  /** 获取用户档案，不存在则创建默认档案 */
  async getOrCreate(openid: string): Promise<UserProfile> {
    if (!openid) throw new Error('openid 不能为空');
    try {
      const { data, error } = await this.client
        .from('users')
        .select('id, openid, family_id, regular_members, stoves, pots, allergies, taboos, flavors, voice_control_on')
        .eq('openid', openid)
        .maybeSingle();
      if (error) throw new Error(`查询失败: ${error.message}`);

      if (!data) {
        const row = DEFAULT_PROFILE(openid);
        const { data: inserted, error: insertErr } = await this.client
          .from('users')
          .insert(row)
          .select('id, openid, family_id, regular_members, stoves, pots, allergies, taboos, flavors, voice_control_on')
          .single();
        if (insertErr) throw new Error(`创建失败: ${insertErr.message}`);
        return inserted as UserProfile;
      }
      return data as UserProfile;
    } catch (e) {
      console.error('[users] getOrCreate error:', (e as Error).message);
      throw e;
    }
  }

  /** 保存用户档案（整份覆盖更新） */
  async upsert(openid: string, profile: Partial<Omit<UserProfile, 'openid' | 'id'>>): Promise<UserProfile> {
    if (!openid) throw new Error('openid 不能为空');
    try {
      const existing = await this.client
        .from('users')
        .select('id, openid, family_id, regular_members, stoves, pots, allergies, taboos, flavors, voice_control_on')
        .eq('openid', openid)
        .maybeSingle();
      if (existing.error) throw new Error(`查询失败: ${existing.error.message}`);

      if (existing.data) {
        const { data, error } = await this.client
          .from('users')
          .update({
            ...profile,
            updated_at: new Date().toISOString(),
          })
          .eq('openid', openid)
          .select('id, openid, family_id, regular_members, stoves, pots, allergies, taboos, flavors, voice_control_on')
          .single();
        if (error) throw new Error(`更新失败: ${error.message}`);
        return data as UserProfile;
      }

      const { data, error } = await this.client
        .from('users')
        .insert({ ...DEFAULT_PROFILE(openid), ...profile })
        .select('id, openid, family_id, regular_members, stoves, pots, allergies, taboos, flavors, voice_control_on')
        .single();
      if (error) throw new Error(`创建失败: ${error.message}`);
      return data as UserProfile;
    } catch (e) {
      console.error('[users] upsert error:', (e as Error).message);
      throw e;
    }
  }
}