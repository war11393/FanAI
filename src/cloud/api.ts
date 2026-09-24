/**
 * 业务 API 层
 * ---------------------------------------------------------------
 * 把云函数调用收敛成语义化函数，页面只调用这里，不直接写云函数名与 action。
 * ★ 替代原 src/network.ts 的全部 /api/* 调用。
 * ★ 注意：不再需要传 openid —— 云函数从微信上下文取真实 openid。
 */

import { callCloud, uploadToCloudStorage, buildIngredientPhotoPath } from './index';
import { CLOUD_FN } from './config';

/* ============================================================
 * 类型定义（对齐云函数返回的 camelCase 字段）
 * ============================================================ */

export interface UserProfile {
  _id?: string;
  openid?: string;
  familyId?: string | null;
  regularMembers: number;
  stoves: Array<{ type: string; count: number }>;
  pots: string[];
  allergies: string[];
  taboos: string[];
  flavors: string[];
  voiceControlOn: boolean;
}

export interface Ingredient {
  _id: string;
  name: string;
  icon?: string;
  quantity: number;
  unit: string;
  addTime: string;
  expireTime: string;
  status: 'fresh' | 'expiring' | 'expired';
  source?: 'photo' | 'voice' | 'text';
}

export interface Recipe {
  _id: string;
  openid?: string | null;
  name: string;
  category?: string;
  flavors?: string[];
  ingredients?: string[];
  mainSteps?: string[];
  brief?: string;
  difficulty?: string;
  durationMinutes?: number;
  source?: string;
  /** 开源菜谱库同步来源的唯一标识（如 howtocook/meat_dish/红烧肉/简易红烧肉.md） */
  slug?: string;
  /** 预估卡路里（大卡），仅开源菜谱有 */
  calories?: number | null;
  /** 上游开源仓库原文链接（署名与溯源用） */
  sourceUrl?: string;
}

export interface MealPlan {
  _id: string;
  date: string;
  dinersCount: number;
  selectedDishes: Array<{ name: string }>;
  prepList: Array<{ task: string; dish: string; minutes: number; done: boolean }>;
  cookingSteps: Array<{ seq: number; dish: string; instruction: string; tips?: string; can_parallel?: boolean }>;
  status: string;
}

export interface AiDish {
  name: string;
  duration_minutes?: number;
  difficulty?: string;
  ingredients?: string[];
  brief?: string;
  main_steps?: string[];
}

export interface AiPrepItem {
  task: string;
  dish: string;
  minutes: number;
  done: boolean;
}

export interface AiStep {
  seq: number;
  dish: string;
  instruction: string;
  tips?: string;
  can_parallel?: boolean;
}

/* ============================================================
 * 用户档案
 * ============================================================ */

export const getUserProfile = (): Promise<UserProfile> =>
  callCloud<UserProfile>(CLOUD_FN.USER, { action: 'get' });

export const saveUserProfile = (profile: Partial<UserProfile>): Promise<UserProfile> =>
  callCloud<UserProfile>(CLOUD_FN.USER, { action: 'upsert', profile });

/* ============================================================
 * 食材
 * ============================================================ */

export const listIngredients = (): Promise<{ list: Ingredient[]; refreshed: number }> =>
  callCloud(CLOUD_FN.INGREDIENT, { action: 'list' });

export const addIngredient = (input: {
  name: string;
  quantity?: number;
  unit?: string;
  icon?: string;
  expireTime?: string;
  shelfLifeDays?: number;
  source?: 'photo' | 'voice' | 'text';
}): Promise<Ingredient> => callCloud(CLOUD_FN.INGREDIENT, { action: 'add', input });

export const batchAddIngredients = (
  items: Array<{
    name: string;
    quantity?: number;
    unit?: string;
    icon?: string;
    expireTime?: string;
    shelfLifeDays?: number;
    source?: 'photo' | 'voice' | 'text';
  }>,
): Promise<{ list: Ingredient[]; count: number }> =>
  callCloud(CLOUD_FN.INGREDIENT, { action: 'batchAdd', items });

export const updateIngredient = (
  id: string,
  patch: Partial<Pick<Ingredient, 'name' | 'icon' | 'quantity' | 'unit' | 'source'>> & {
    expireTime?: string;
    shelfLifeDays?: number;
  },
): Promise<Ingredient> => callCloud(CLOUD_FN.INGREDIENT, { action: 'update', id, patch });

export const removeIngredient = (id: string): Promise<{ id: string; removed: boolean }> =>
  callCloud(CLOUD_FN.INGREDIENT, { action: 'remove', id });

/* ============================================================
 * 菜谱
 * ============================================================ */

export const listRecipes = (keyword?: string): Promise<{ list: Recipe[] }> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'list', keyword });

export const seedRecipes = (): Promise<{ inserted: number; skipped: number; total: number }> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'seed' });

export const createRecipe = (recipe: Partial<Recipe>): Promise<Recipe> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'create', recipe });

export const updateRecipe = (id: string, patch: Partial<Recipe>): Promise<Recipe> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'update', id, patch });

export const removeRecipe = (id: string): Promise<{ id: string; removed: boolean }> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'remove', id });

/* ============================================================
 * 餐饮计划
 * ============================================================ */

export const listMealPlans = (status?: string): Promise<{ list: MealPlan[] }> =>
  callCloud(CLOUD_FN.RECIPE, { action: 'listPlans', status });

export const saveMealPlan = (plan: {
  date: string;
  dinersCount?: number;
  selectedDishes?: Array<{ name: string }>;
  prepList?: AiPrepItem[];
  cookingSteps?: AiStep[];
  status?: string;
}): Promise<MealPlan> => callCloud(CLOUD_FN.RECIPE, { action: 'savePlan', plan });

/* ============================================================
 * AI 生文能力
 * ============================================================ */

/** 拍照识别食材（视觉） */
export const aiRecognizePhoto = (
  imageUrl: string,
): Promise<{ items: Array<{ name: string; quantity: number; unit: string; shelfLifeDays: number; confidence?: number }>; aiOffline: boolean }> =>
  callCloud(CLOUD_FN.AI_TEXT, { action: 'recognize', imageUrl });

/** 口语文本解析为结构化食材 */
export const aiParseText = (
  text: string,
): Promise<{ items: Array<{ name: string; quantity: number; unit: string }>; aiOffline: boolean }> =>
  callCloud(CLOUD_FN.AI_TEXT, { action: 'parse', text });

/** AI 菜谱推荐 */
export const aiRecommend = (payload: {
  dinersCount: number;
  ingredients?: string[];
  stoves?: Array<{ type: string; count: number }>;
  allergies?: string[];
  taboos?: string[];
}): Promise<{ dishes: AiDish[]; aiOffline: boolean }> =>
  callCloud(CLOUD_FN.AI_TEXT, { action: 'recommend', ...payload });

/** 备菜清单 */
export const aiPrep = (payload: {
  dinersCount: number;
  dishes: Array<{ name: string }>;
}): Promise<{ prep_list: AiPrepItem[]; cooking_tips: string[]; aiOffline: boolean }> =>
  callCloud(CLOUD_FN.AI_TEXT, { action: 'prep', ...payload });

/** 做菜流程编排 */
export const aiCooking = (payload: {
  dinersCount: number;
  dishes: Array<{ name: string }>;
  stoves?: Array<{ type: string; count: number }>;
}): Promise<{ steps: AiStep[]; final_message: string; aiOffline: boolean }> =>
  callCloud(CLOUD_FN.AI_TEXT, { action: 'cooking', ...payload });

/* ============================================================
 * AI 生图能力（菜谱成品图）
 * ============================================================ */

export interface GeneratedImage {
  fileID: string | null;
  tempUrl: string;
  tempUrlExpiresIn: number;
  revisedPrompt: string;
  model: string;
  size: string;
  mirrored: boolean;
  mirrorError: string | null;
}

/**
 * 生成菜谱成品图
 * ★ 生图较慢（10~30 秒，开 revise +10s），云函数超时已设 900 秒
 */
export const aiGenerateDishImage = (payload: {
  prompt: string;
  size?: '1024x1024' | '1280x720' | '720x1280' | '1280x1280';
  revise?: boolean;
  enableThinking?: boolean;
  recipeName?: string;
}): Promise<GeneratedImage> =>
  callCloud(CLOUD_FN.AI_IMAGE, { action: 'generate', ...payload });

/* ============================================================
 * 图片上传
 * ============================================================ */

/** 上传食材照片到云存储，返回 fileID */
export const uploadIngredientPhoto = (filePath: string): Promise<string> =>
  uploadToCloudStorage(filePath, buildIngredientPhotoPath());

/* ============================================================
 * 初始化（首次部署后调用一次）
 * ============================================================ */

export const initDatabase = (
  seed = true,
): Promise<{ collections: Array<{ name: string; created: boolean }>; seed: unknown; nextSteps: string[] }> =>
  callCloud(CLOUD_FN.DB_INIT, { action: 'init', seed });
