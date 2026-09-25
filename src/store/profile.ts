/**
 * 全局家庭画像 store
 * ---------------------------------------------------------------
 * 【为什么需要】
 *   「我的」页保存人数/灶具等档案后，首页（tab 页）不会自动重新拉取，
 *   导致切回首页仍显示旧值。本 store 作为**跨 tab 的共享状态**，
 *   在 profile 保存成功后立即写入，首页订阅即可实时更新。
 *
 * 【C1 决策：全局状态 + useDidShow 兜底刷新 两条都要】
 *   - 全局状态：保证保存后立刻生效（无需等待网络往返）
 *   - useDidShow：tab 页切回来时静默重拉，兜住"别处改了档案"的情况
 *   两者都失败时，首屏仍能用 store 里的旧值渲染，不会白屏。
 */

import { create } from 'zustand';
import type { UserProfile } from '@/cloud/api';

interface ProfileState {
  /** 当前家庭画像（null = 尚未加载） */
  profile: UserProfile | null;
  /** 是否正在加载 */
  loading: boolean;
  /** 更新画像（profile 页保存成功后调用） */
  setProfile: (p: UserProfile | null) => void;
  /**
   * 静默同步：重新拉取画像。
   * ★ 失败时不抛错、不清空已有值（静默刷新，失败就用全局里的旧内容）
   */
  syncProfile: (fn: () => Promise<UserProfile>) => Promise<void>;
}

export const useProfileStore = create<ProfileState>((set, get) => ({
  profile: null,
  loading: false,

  setProfile: (p) => set({ profile: p }),

  syncProfile: async (fn) => {
    if (get().loading) return; // 防并发重复请求
    set({ loading: true });
    try {
      const p = await fn();
      set({ profile: p ?? null, loading: false });
    } catch (e) {
      // ★ 静默失败：保留全局已有内容，不打断用户
      console.warn('[profileStore] 静默同步失败，沿用已有全局内容', (e as Error)?.message);
      set({ loading: false });
    }
  },
}));
