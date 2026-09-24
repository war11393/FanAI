/**
 * 云函数数据库 schema 常量与集合初始化定义
 * ---------------------------------------------------------------
 * 字段设计对齐原 Supabase/Drizzle schema（server/src/storage/database/shared/schema.ts），
 * 确保业务语义零漂移；同时贴合云开发文档型数据库的习惯。
 *
 * ★ 命名约定：云数据库为文档型，统一使用 camelCase 字段。
 *   原 Postgres 的 snake_case（add_time / expire_time / regular_members ...）
 *   在云函数出口处转换为 camelCase 并返回给前端。
 */

/** 集合名 */
const COLLECTIONS = {
  USERS: 'users',
  INGREDIENTS: 'ingredients',
  MEAL_PLANS: 'meal_plans',
  RECIPES: 'recipes',
};

/**
 * 集合定义 + 索引
 * ★ 索引需在云开发控制台或通过 db-init 云函数创建
 *   （云开发 Node SDK 的 createCollection 不支持直接建索引，
 *    索引需走 HTTP API / 控制台，详见 db-init 的说明）
 */
const COLLECTION_DEFS = [
  {
    name: COLLECTIONS.USERS,
    desc: '用户档案（按 openid 隔离）',
    indexes: [
      { name: 'openid_unique', keys: [{ field: 'openid', direction: 1 }], unique: true },
    ],
  },
  {
    name: COLLECTIONS.INGREDIENTS,
    desc: '食材库存（新鲜度状态机）',
    indexes: [
      { name: 'openid_idx', keys: [{ field: 'openid', direction: 1 }] },
      { name: 'openid_status_idx', keys: [{ field: 'openid', direction: 1 }, { field: 'status', direction: 1 }] },
      { name: 'openid_expire_idx', keys: [{ field: 'openid', direction: 1 }, { field: 'expireTime', direction: 1 }] },
    ],
  },
  {
    name: COLLECTIONS.MEAL_PLANS,
    desc: '餐饮计划',
    indexes: [
      { name: 'openid_idx', keys: [{ field: 'openid', direction: 1 }] },
      { name: 'openid_date_idx', keys: [{ field: 'openid', direction: 1 }, { field: 'date', direction: -1 }] },
      { name: 'openid_status_idx', keys: [{ field: 'openid', direction: 1 }, { field: 'status', direction: 1 }] },
    ],
  },
  {
    name: COLLECTIONS.RECIPES,
    desc: '菜谱：公开菜谱(openid 为空) + 私人菜谱(openid 为用户)',
    indexes: [
      { name: 'openid_idx', keys: [{ field: 'openid', direction: 1 }] },
      { name: 'name_idx', keys: [{ field: 'name', direction: 1 }] },
      { name: 'source_idx', keys: [{ field: 'source', direction: 1 }] },
      { name: 'slug_idx', keys: [{ field: 'slug', direction: 1 }] },
    ],
  },
];

/** 默认用户档案（对齐原 DEFAULT_PROFILE） */
const DEFAULT_PROFILE = (openid) => ({
  openid,
  familyId: null,
  regularMembers: 2,
  stoves: [{ type: '燃气灶', count: 2 }],
  pots: ['炒锅', '汤锅'],
  allergies: [],
  taboos: [],
  flavors: [],
  voiceControlOn: false,
});

/** 食材新鲜度状态 */
const INGREDIENT_STATUS = {
  FRESH: 'fresh',
  EXPIRING: 'expiring',
  EXPIRED: 'expired',
};

module.exports = {
  COLLECTIONS,
  COLLECTION_DEFS,
  DEFAULT_PROFILE,
  INGREDIENT_STATUS,
};
