import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { getSupabaseClient } from '@/storage/database/supabase-client';
import { SHELF_LIFE_DICT } from '../ai/shelf-life-dict';

export interface IngredientInput {
  name: string;
  icon?: string;
  quantity?: number;
  unit?: string;
  add_time?: string;
  expire_time?: string;
  shelfLifeDays?: number;
  source?: 'photo' | 'voice' | 'text';
}

const STATUS = { FRESH: 'fresh', EXPIRING: 'expiring', EXPIRED: 'expired' } as const;

@Injectable()
export class IngredientsService {
  private client = getSupabaseClient();

  /** 新鲜度规则引擎 */
  computeStatus(expireTime: string): 'fresh' | 'expiring' | 'expired' {
    const expire = new Date(expireTime).getTime();
    const now = Date.now();
    const oneDay = 24 * 60 * 60 * 1000;
    if (expire < now) return STATUS.EXPIRED;
    if (expire - now <= oneDay) return STATUS.EXPIRING;
    return STATUS.FRESH;
  }

  /** 刷新所有食材状态（打开冰箱/首页时调用） */
  async refreshStatuses(openid: string): Promise<number> {
    const { data: list, error } = await this.client
      .from('ingredients')
      .select('id, expire_time, status')
      .eq('openid', openid);
    if (error || !list) return 0;
    let updated = 0;
    for (const item of list) {
      const status = this.computeStatus(item.expire_time);
      if (status !== item.status) {
        await this.client.from('ingredients').update({ status }).eq('id', item.id);
        updated++;
      }
    }
    return updated;
  }

  lookupShelfLife(name: string): number | undefined {
    return SHELF_LIFE_DICT[name];
  }

  async list(openid: string) {
    const { data, error } = await this.client
      .from('ingredients')
      .select('*')
      .eq('openid', openid)
      .order('expire_time', { ascending: true });
    if (error) throw new HttpException(`查询失败: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    return data ?? [];
  }

  async add(openid: string, input: IngredientInput) {
    const addTime = input.add_time ? new Date(input.add_time) : new Date();
    let expireTime: Date;
    if (input.expire_time) {
      expireTime = new Date(input.expire_time);
    } else {
      const shelfDays = this.lookupShelfLife(input.name) ?? input.shelfLifeDays ?? 3;
      expireTime = new Date(addTime.getTime() + shelfDays * 24 * 60 * 60 * 1000);
    }
    const status = this.computeStatus(expireTime.toISOString());
    const { data, error } = await this.client
      .from('ingredients')
      .insert({
        openid: openid,
        name: input.name,
        icon: input.icon || '',
        quantity: input.quantity ?? 1,
        unit: input.unit || '个',
        add_time: addTime.toISOString(),
        expire_time: expireTime.toISOString(),
        status,
        source: input.source || 'text',
      })
      .select()
      .single();
    if (error) throw new HttpException(`添加食材失败: ${error.message}`, HttpStatus.BAD_REQUEST);
    return data;
  }

  async batchAdd(openid: string, items: IngredientInput[]) {
    const results: any[] = [];
    for (const it of items) {
      results.push(await this.add(openid, it));
    }
    return results;
  }

  async update(openid: string, id: string, patch: Partial<IngredientInput>) {
    const { data: current, error: queryErr } = await this.client
      .from('ingredients').select('*').eq('id', id).eq('openid', openid).single();
    if (queryErr || !current) throw new HttpException('食材不存在', HttpStatus.NOT_FOUND);

    const updatePayload: Record<string, unknown> = {};
    if (patch.name !== undefined) updatePayload.name = patch.name;
    if (patch.icon !== undefined) updatePayload.icon = patch.icon;
    if (patch.quantity !== undefined) updatePayload.quantity = patch.quantity;
    if (patch.unit !== undefined) updatePayload.unit = patch.unit;
    if (patch.source !== undefined) updatePayload.source = patch.source;

    const name = patch.name ?? current.name;
    if (patch.expire_time) {
      updatePayload.expire_time = new Date(patch.expire_time).toISOString();
      updatePayload.status = this.computeStatus(updatePayload.expire_time as string);
    } else if (patch.name || patch.shelfLifeDays) {
      const shelfDays = this.lookupShelfLife(name) ?? patch.shelfLifeDays ?? 3;
      const base = current.add_time ? new Date(current.add_time) : new Date();
      const expire = new Date(base.getTime() + shelfDays * 24 * 60 * 60 * 1000).toISOString();
      updatePayload.expire_time = expire;
      updatePayload.status = this.computeStatus(expire);
    }

    const { data, error } = await this.client
      .from('ingredients').update(updatePayload).eq('id', id).eq('openid', openid).select().single();
    if (error) throw new HttpException(`更新食材失败: ${error.message}`, HttpStatus.INTERNAL_SERVER_ERROR);
    return data;
  }

  async remove(openid: string, id: string) {
    const { data, error } = await this.client
      .from('ingredients').delete().eq('id', id).eq('openid', openid).select().single();
    if (error) throw new HttpException(`删除食材失败: ${error.message}`, HttpStatus.NOT_FOUND);
    return data;
  }

  /** 上传图片：优先存入 Supabase Storage 并生成临时可访问 URL；未配置存储桶时回退为 base64 data URL */
  async uploadPhoto(buffer: Buffer, originalname: string, mimetype?: string) {
    const contentType = mimetype || 'image/jpeg';
    const fileName = `ingredients/${Date.now()}_${(originalname || 'photo.jpg').replace(/[^\w.\-]/g, '_')}`;
    const bucket = process.env.SUPABASE_STORAGE_BUCKET;

    if (bucket) {
      const { error } = await this.client.storage
        .from(bucket)
        .upload(fileName, buffer, { contentType, upsert: true });
      if (!error) {
        const { data } = await this.client.storage
          .from(bucket)
          .createSignedUrl(fileName, 3600);
        if (data?.signedUrl) {
          return { imageKey: fileName, imageUrl: data.signedUrl };
        }
      }
      console.error('[ingredients] supabase storage upload failed, fallback to data url', error?.message);
    }

    // 回退：base64 data URL（视觉模型通常直接支持）
    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    return { imageKey: '', imageUrl: dataUrl };
  }
}