/**
 * 内置菜谱库（openid 为 null，所有用户可见）
 * ---------------------------------------------------------------
 * ★ 由 server/src/modules/recipes/builtin-recipes.ts 自动迁移而来
 *   字段已从 snake_case 转为 camelCase，对齐云数据库约定。
 *   若原文件更新，请重新执行迁移脚本，勿手工双份维护。
 */
/** 内置菜谱库（openid 为空，所有用户可见） */
const BUILTIN_RECIPES = [
  {
    name: '西红柿炒鸡蛋',
    category: '家常菜',
    flavors: ['咸鲜'],
    ingredients: ['西红柿', '鸡蛋', '葱', '盐', '糖'],
    mainSteps: ['鸡蛋打散加盐，热油炒熟盛出', '西红柿切块下锅炒出汁', '倒回鸡蛋，加糖盐调味，翻炒均匀', '撒葱花出锅'],
    brief: '国民家常菜，酸甜开胃，5分钟出锅。',
    difficulty: '简单',
    durationMinutes: 10,
  },
  {
    name: '青椒土豆丝',
    category: '家常菜',
    flavors: ['清爽', '咸鲜'],
    ingredients: ['土豆', '青椒', '蒜', '醋', '盐'],
    mainSteps: ['土豆丝切好泡水去淀粉', '热油爆香蒜片', '下土豆丝大火快炒', '加青椒丝、醋和盐，炒至断生'],
    brief: '清脆爽口的下饭菜，考验刀工与火候。',
    difficulty: '简单',
    durationMinutes: 15,
  },
  {
    name: '红烧肉',
    category: '硬菜',
    flavors: ['咸甜', '浓郁'],
    ingredients: ['五花肉', '冰糖', '生抽', '老抽', '姜', '八角'],
    mainSteps: ['五花肉切块焯水', '小火炒糖色至琥珀色', '下肉块翻炒上色', '加生抽老抽、姜片八角，加水没过肉', '小火炖40分钟收汁'],
    brief: '肥而不腻、入口即化的经典硬菜。',
    difficulty: '普通',
    durationMinutes: 60,
  },
  {
    name: '紫菜蛋花汤',
    category: '汤羹',
    flavors: ['清淡', '鲜'],
    ingredients: ['紫菜', '鸡蛋', '葱', '盐', '香油'],
    mainSteps: ['水烧开放入紫菜', '淋入打散的蛋液成蛋花', '加盐、撒葱花，滴香油即可'],
    brief: '简单清爽的居家快手汤。',
    difficulty: '简单',
    durationMinutes: 8,
  },
  {
    name: '宫保鸡丁',
    category: '川菜',
    flavors: ['微辣', '酸甜'],
    ingredients: ['鸡胸肉', '花生米', '干辣椒', '黄瓜', '生抽', '醋', '糖'],
    mainSteps: ['鸡丁腌制后滑炒盛出', '爆香干辣椒', '下黄瓜丁、鸡丁翻炒', '调入糖醋汁收浓', '加花生米翻匀'],
    brief: '口感复合，酸甜微辣的国民川菜。',
    difficulty: '普通',
    durationMinutes: 25,
  },
  {
    name: '香菇滑鸡',
    category: '蒸菜',
    flavors: ['咸鲜', '清淡'],
    ingredients: ['鸡腿', '香菇', '姜', '料酒', '生抽', '淀粉'],
    mainSteps: ['鸡块加料酒生抽淀粉腌制', '与香菇片拌匀', '大火蒸20分钟', '撒葱花即可'],
    brief: '肉质滑嫩，保留原汁原味的蒸菜。',
    difficulty: '简单',
    durationMinutes: 30,
  },
  {
    name: '蒜蓉西兰花',
    category: '素菜',
    flavors: ['清淡', '蒜香'],
    ingredients: ['西兰花', '蒜', '盐', '蚝油'],
    mainSteps: ['西兰花焯水', '热油爆香蒜末', '下西兰花翻炒', '加盐和蚝油炒匀'],
    brief: '低卡健康的快手素菜。',
    difficulty: '简单',
    durationMinutes: 12,
  },
  {
    name: '酸辣土豆粉',
    category: '小吃',
    flavors: ['酸辣', '开胃'],
    ingredients: ['土豆粉', '酸豆角', '花生米', '辣椒油', '醋', '葱花'],
    mainSteps: ['土豆粉煮软捞出', '加入酸豆角、花生米', '淋辣椒油、醋，撒葱花拌匀'],
    brief: '酸辣开胃的街边风味。',
    difficulty: '简单',
    durationMinutes: 15,
  },
];
module.exports = { BUILTIN_RECIPES };
