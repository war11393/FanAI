/**
 * 云函数离线自检（不依赖云环境）
 * ---------------------------------------------------------------
 * 用 mock 替换 wx-server-sdk / @cloudbase/node-sdk，真实执行云函数业务逻辑，
 * 验证：新鲜度状态机、兜底解析、查询条件构造、参数校验、信封格式。
 *
 * 用法：node cloudfunctions/test-offline.js
 * ★ 这是本地唯一能验证业务逻辑的手段（真机/云环境验证另算）。
 */

const path = require('path');
const Module = require('module');

/* ============ 一、注入 mock 模块 ============ */
const origResolve = Module._resolveFilename;
const MOCKS = {};

function makeMockCloud() {
  let addCounter = 0;
  const store = new Map(); // collectionName -> [docs]

  const matches = (doc, where) => {
    if (!where || typeof where !== 'object') return true;
    return Object.entries(where).every(([k, v]) => {
      if (k === '$and') return v.every((sub) => matches(doc, sub));
      if (k === '$or') return v.some((sub) => matches(doc, sub));
      const actual = k === '_id' ? doc._id : doc[k];
      if (v && v.__isRegExp) return new RegExp(v.regexp, v.options).test(String(actual ?? ''));
      return actual === v;
    });
  };

  function collection(name) {
    if (!store.has(name)) store.set(name, []);
    const docs = store.get(name);

    // 每次调用都新建一个持有 where 条件的查询对象，避免链式调用互相污染
    const makeQuery = (where = {}) => {
      const q = {
        where: (w) => makeQuery(w),
        orderBy: () => makeQuery(where),
        field: () => makeQuery(where),
        limit: (n) => {
          const inner = makeQuery(where);
          inner.__limit = n;
          return inner;
        },
        get: async () => {
          let rows = docs.filter((d) => matches(d, where));
          if (q.__limit != null) rows = rows.slice(0, q.__limit);
          return { data: rows.map((d) => ({ ...d })) };
        },
        count: async () => ({ total: docs.filter((d) => matches(d, where)).length }),
        add: async ({ data }) => {
          const _id = `mock_${++addCounter}`;
          docs.push({ _id, ...data });
          return { _id };
        },
        doc: (id) => ({
          get: async () => {
            const d = docs.find((x) => x._id === id);
            if (!d) throw new Error('doc not found');
            return { data: { ...d } };
          },
          update: async ({ data }) => {
            const i = docs.findIndex((x) => x._id === id);
            if (i === -1) throw new Error('doc not found');
            docs[i] = { ...docs[i], ...data };
            return { stats: { updated: 1 } };
          },
          remove: async () => {
            const i = docs.findIndex((x) => x._id === id);
            if (i >= 0) docs.splice(i, 1);
            return { stats: { removed: 1 } };
          },
        }),
      };
      return q;
    };

    return makeQuery({});
  }

  return {
    init: () => {},
    DYNAMIC_CURRENT_ENV: 'mock-env',
    database: () => ({
      collection,
      command: {
        aggregate: {},
        or: (arr) => ({ $or: arr }),
        and: (arr) => ({ $and: arr }),
      },
      serverDate: () => new Date().toISOString(),
      RegExp: ({ regexp, options }) => ({ __isRegExp: true, regexp, options }),
      createCollection: async () => {},
    }),
    getWXContext: () => ({ OPENID: MOCK_OPENID }),
    uploadFile: async ({ cloudPath }) => ({ fileID: `cloud://mock/${cloudPath}` }),
    ai: () => ({
      createModel: () => ({
        generateText: async () => ({ text: JSON.stringify({ items: [] }) }),
      }),
    }),
    __store: store,
  };
}

let MOCK_OPENID = 'test_openid_001';
MOCKS['wx-server-sdk'] = makeMockCloud();
MOCKS['@cloudbase/node-sdk'] = {
  init: () => ({
    ai: () => ({
      createImageModel: () => ({
        generateImage: async () => ({
          data: [{ url: 'https://mock.example.com/img.png', revised_prompt: 'revised' }],
        }),
      }),
    }),
  }),
};

Module._resolveFilename = function (request, ...args) {
  if (MOCKS[request]) return `__mock__:${request}`;
  return origResolve.call(this, request, ...args);
};
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (MOCKS[request]) return MOCKS[request];
  return origLoad.call(this, request, parent, isMain);
};

/* ============ 二、断言工具 ============ */
let passed = 0;
let failed = 0;
const failures = [];

function check(name, cond, extra) {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    failures.push(name);
    console.log(`  ✗ ${name}${extra ? ` -> ${JSON.stringify(extra)}` : ''}`);
  }
}

function section(title) {
  console.log(`\n── ${title} ${'─'.repeat(Math.max(0, 50 - title.length))}`);
}

/* ============ 三、测试 ============ */
async function run() {
  // ---------- ingredient ----------
  section('ingredient 新鲜度状态机');
  const ingredient = require('./ingredient/index.js');
  const { INGREDIENT_STATUS } = require('./ingredient/schema.js');

  const now = Date.now();
  const ONE_DAY = 24 * 60 * 60 * 1000;
  const call = (event) => ingredient.main(event, {});

  // 过期 / 临期 / 新鲜 三种状态
  const addExpired = await call({
    action: 'add',
    input: { name: '过期菜', expireTime: new Date(now - 2 * ONE_DAY).toISOString() },
  });
  check('过期食材 status=expired', addExpired.data.status === 'expired', addExpired.data.status);

  const addExpiring = await call({
    action: 'add',
    input: { name: '临期菜', expireTime: new Date(now + 2 * 60 * 60 * 1000).toISOString() },
  });
  check('临期食材(2h内) status=expiring', addExpiring.data.status === 'expiring', addExpiring.data.status);

  const addFresh = await call({
    action: 'add',
    input: { name: '土豆', quantity: 3, unit: '个' },
  });
  check('新鲜食材 status=fresh', addFresh.data.status === 'fresh', addFresh.data.status);
  check('保质期字典生效(土豆=30天)',
    Math.round((new Date(addFresh.data.expireTime) - new Date(addFresh.data.addTime)) / ONE_DAY) === 30,
    { expireTime: addFresh.data.expireTime, addTime: addFresh.data.addTime });

  // list 返回结构
  const listRes = await call({ action: 'list' });
  check('list 返回 {list, refreshed}', Array.isArray(listRes.data.list) && typeof listRes.data.refreshed === 'number');
  check('list 条数为 3', listRes.data.list.length === 3, listRes.data.list.length);
  check('list 按 expireTime 升序',
    listRes.data.list[0].expireTime <= listRes.data.list[2].expireTime);

  // 更新：改名应重算保质期
  const updateRes = await call({
    action: 'update',
    id: addFresh.data._id,
    patch: { name: '黄瓜' },
  });
  check('改名后保质期按新名重算(黄瓜=5天)',
    Math.round((new Date(updateRes.data.expireTime) - new Date(updateRes.data.addTime)) / ONE_DAY) === 5,
    updateRes.data);

  // 越权删除：换个 openid 应删不到
  // ★ 注意：wrap() 会把 BizError 转成「失败信封返回」而非 throw，断言要看返回值
  MOCK_OPENID = 'other_user_openid';
  const crossRes = await call({ action: 'remove', id: addFresh.data._id });
  check('他人无法删除自己的食材(返回 NOT_FOUND)',
    crossRes.success === false && crossRes.code === 'NOT_FOUND', crossRes.code);
  MOCK_OPENID = 'test_openid_001';

  const removeRes = await call({ action: 'remove', id: addFresh.data._id });
  check('本人可删除自己的食材', removeRes.data.removed === true);

  // 参数校验
  const badAdd = await call({ action: 'add', input: {} });
  check('缺 name 返回 INVALID_PARAM',
    badAdd.success === false && badAdd.code === 'INVALID_PARAM', badAdd.code);

  // ---------- ai-text 兜底 ----------
  section('ai-text 兜底逻辑');
  const aiText = require('./ai-text/index.js');
  const aiCall = (event) => aiText.main(event, {});

  const parseRes = await aiCall({ action: 'parse', text: '买了两个西红柿和半斤五花肉' });
  check('parse 返回 aiOffline=true（mock AI 返回空）', parseRes.data.aiOffline === true);
  check('parse 兜底能提取出食材', parseRes.data.items.length >= 2, parseRes.data.items);
  const tomato = parseRes.data.items.find((i) => i.name === '西红柿');
  check('兜底解析出「西红柿」数量=2', tomato && tomato.quantity === 2, tomato);

  const recRes = await aiCall({ action: 'recommend', dinersCount: 3, ingredients: [] });
  check('recommend 兜底返回 3 道菜', recRes.data.dishes.length === 3, recRes.data.dishes.length);
  check('recommend aiOffline=true', recRes.data.aiOffline === true);

  const recWith = await aiCall({ action: 'recommend', dinersCount: 2, ingredients: ['西红柿', '鸡蛋'] });
  check('有食材时兜底能匹配到西红柿炒鸡蛋',
    recWith.data.dishes.some((d) => d.name.includes('西红柿')), recWith.data.dishes.map((d) => d.name));

  const prepRes = await aiCall({ action: 'prep', dinersCount: 2, dishes: [{ name: '西红柿炒鸡蛋' }] });
  check('prep 兜底返回备菜项', prepRes.data.prep_list.length > 0);
  check('prep 兜底返回 tips', Array.isArray(prepRes.data.cooking_tips) && prepRes.data.cooking_tips.length === 2);

  const cookRes = await aiCall({ action: 'cooking', dinersCount: 2, dishes: [{ name: '红烧肉' }] });
  check('cooking 兜底返回 steps', cookRes.data.steps.length === 1);
  check('cooking 兜底返回 final_message', typeof cookRes.data.final_message === 'string' && cookRes.data.final_message.length > 0);

  const healthRes = await aiCall({ action: 'health' });
  check('health 返回 provider 与模型名', healthRes.data.provider === 'cloudbase' && healthRes.data.textModel === 'hy3', healthRes.data);

  const badAction = await aiCall({ action: 'nope' });
  check('未知 action 返回 INVALID_ACTION', badAction.code === 'INVALID_ACTION');

  // ---------- recipe ----------
  section('recipe 可见性与查询');
  const recipe = require('./recipe/index.js');
  const rCall = (event) => recipe.main(event, {});

  // 灌入公共菜谱
  const seed = await rCall({ action: 'seed' });
  check('seed 灌入 8 条公共菜谱', seed.data.inserted === 8 && seed.data.total === 8, seed.data);
  const seedAgain = await rCall({ action: 'seed' });
  check('seed 幂等（二次调用 skipped=8）', seedAgain.data.inserted === 0 && seedAgain.data.skipped === 8, seedAgain.data);

  // 本人创建私人菜谱
  const created = await rCall({ action: 'create', recipe: { name: '我的私房菜', brief: '测试用' } });
  check('create 私人菜谱成功', created.data.name === '我的私房菜' && created.data.source === 'user');

  const myList = await rCall({ action: 'list' });
  check('list 可见 公共8条+私人1条=9条', myList.data.list.length === 9, myList.data.list.length);

  // 换用户后看不到别人的私人菜谱
  MOCK_OPENID = 'other_user_openid';
  const otherList = await rCall({ action: 'list' });
  check('他人只能看到 8 条公共菜谱', otherList.data.list.length === 8, otherList.data.list.length);

  // 他人不能删公共菜谱之外的东西 / 不能删本人的
  const crossRecipeRes = await rCall({ action: 'remove', id: created.data._id });
  check('他人无法删除我的私人菜谱',
    crossRecipeRes.success === false && crossRecipeRes.code === 'NOT_FOUND', crossRecipeRes.code);
  MOCK_OPENID = 'test_openid_001';

  // 关键词搜索
  const kwList = await rCall({ action: 'list', keyword: '西红柿' });
  check('关键词搜索能命中西红柿炒鸡蛋',
    kwList.data.list.some((r) => r.name.includes('西红柿')), kwList.data.list.map((r) => r.name));

  // 餐计划：同日保存应覆盖
  const plan1 = await rCall({ action: 'savePlan', plan: { date: '2026-09-23', dinersCount: 2 } });
  const plan2 = await rCall({ action: 'savePlan', plan: { date: '2026-09-23', dinersCount: 5 } });
  check('同日 savePlan 覆盖而非新增', plan1.data._id === plan2.data._id && plan2.data.dinersCount === 5, {
    id1: plan1.data._id, id2: plan2.data._id, diners: plan2.data.dinersCount,
  });
  const plans = await rCall({ action: 'listPlans' });
  check('listPlans 只返回 1 条', plans.data.list.length === 1, plans.data.list.length);

  // ---------- recipe-sync ----------
  section('recipe-sync 菜谱同步（HowToCook → 云数据库）');
  const recipeSync = require('./recipe-sync/index.js');
  const sCall = (event) => recipeSync.main(event, {});

  const first = await sCall({ action: 'sync', mode: 'changed', limit: 150 });
  const syncOk = first.success === true;
  check('sync(changed) 信封成功（数据文件缺失时也应报 NOT_FOUND 而非崩溃）',
    syncOk || first.code === 'NOT_FOUND', first.code);
  if (syncOk) {
    check('首批规模正确（min(dataset, limit)）',
      first.data.processed === Math.min(first.data.datasetCount, 150) &&
      first.data.remaining === Math.max(0, first.data.datasetCount - 150),
      { processed: first.data.processed, remaining: first.data.remaining, datasetCount: first.data.datasetCount });
    // full 模式（372 条）走多批次路径：首批必有 remaining，循环推进直到 done
    let res = await sCall({ action: 'sync', mode: 'full', limit: 150 });
    check('full 模式分批生效（372>150 时 remaining>0）',
      res.data.processed === 150 && res.data.remaining > 0 && res.data.nextOffset === 150,
      { processed: res.data.processed, remaining: res.data.remaining });
    let guard = 0;
    while (!res.data.done && guard++ < 20) {
      res = await sCall({ action: 'sync', mode: 'full', offset: res.data.nextOffset, limit: 150 });
      if (!res.success) break;
    }
    check('分批循环至 done（共 3 批）', res.data.done === true && res.data.remaining === 0 && guard === 2, { guard, done: res.data.done });
    check('同步全部成功写入（无 failed）', res.data.failed === 0, res.data.failures);
    const totalInserted = await (async () => {
      const st = await sCall({ action: 'status' });
      return st.data.bySource.howtocook;
    })();
    check('status 统计 = 数据集条数', totalInserted === res.data.datasetCount, { totalInserted, datasetCount: res.data.datasetCount });
    // 重复同步幂等：全部 skipped
    const again = await sCall({ action: 'sync', mode: 'changed', limit: 200 });
    check('重复同步幂等（首批全部 skipped）',
      again.data.inserted === 0 && again.data.updated === 0 && again.data.skipped === again.data.processed, again.data);
    // 同步进来的公共菜谱对普通用户可见（openid null）
    const listAfter = await rCall({ action: 'list' });
    check('同步的菜谱 openid=null 全员可见', listAfter.data.list.some((x) => x.source === 'howtocook'));
  }

  // ---------- user ----------
  section('user 档案');
  const user = require('./user/index.js');
  const uCall = (event) => user.main(event, {});

  const u1 = await uCall({ action: 'get' });
  check('get 自动创建默认档案', u1.data.openid === 'test_openid_001' && u1.data.regularMembers === 2, u1.data);
  check('默认档案含默认灶具', Array.isArray(u1.data.stoves) && u1.data.stoves.length === 1);

  const u2 = await uCall({ action: 'get' });
  check('二次 get 不重复创建（_id 相同）', u1.data._id === u2.data._id);

  const u3 = await uCall({ action: 'upsert', profile: { regularMembers: 4, allergies: ['花生'] } });
  check('upsert 更新成功', u3.data.regularMembers === 4 && u3.data.allergies[0] === '花生', u3.data);

  const u4 = await uCall({ action: 'upsert', profile: { openid: 'hacked', _id: 'hacked' } });
  check('upsert 拒绝越权字段（openid 不可改）/ 白名单', u4.code === 'INVALID_PARAM', u4.code);

  // ---------- 信封一致性 ----------
  section('响应信封一致性');
  const envelopes = [parseRes, recRes, seed, u1, listRes, kwList];
  check('所有响应均有 success/code/message/data',
    envelopes.every((e) => 'success' in e && 'code' in e && 'message' in e));
  check('成功响应 success=true', envelopes.every((e) => e.success === true));
  check('成功响应 code=200', envelopes.every((e) => e.code === 200));

  /* ============ 四、汇总 ============ */
  console.log(`\n${'='.repeat(56)}`);
  console.log(`通过 ${passed} 项，失败 ${failed} 项`);
  if (failed > 0) {
    console.log(`\n失败项：`);
    failures.forEach((f) => console.log(`  - ${f}`));
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✓');
  }
}

run().catch((e) => {
  console.error('\n[测试异常]', e);
  process.exitCode = 1;
});
