# 今天吃什么 🍳

> 冰箱有什么，AI 配什么，开口跟着做——今天吃什么，不再纠结。

一个 **AI 驱动的家庭吃饭决策微信小程序**：管理冰箱食材库存，结合家庭人数、灶台数量、过敏忌口与口味偏好，由大模型生成一桌可执行的菜单，并提供备菜清单与逐步烹饪指导，覆盖「从食材到上桌」的完整闭环。

## ✨ 核心功能

| 模块 | 说明 |
| --- | --- |
| 🏠 首页 · AI 推荐 | 读取家庭画像 + 冰箱库存，AI 生成今日菜单（含耗时/难度/食材/步骤）；「来且了」一键加人重新配菜；菜品多选后进入做菜流程 |
| 🧊 冰箱 · 食材管理 | 拍照识别 / 语音录入 / 文本录入三种入账方式；自动计算新鲜度（新鲜 / 临期 / 过期），临期过期高亮预警 |
| 📖 菜谱 · 菜谱库 | 浏览与搜索公共菜谱、查看就餐历史；一段文字即可让 AI 解析生成私人菜谱 |
| 👤 我的 · 口味偏好 | 常驻人数、灶台配置、过敏史、忌口、口味偏好（多选 + 自定义），全部作为 AI 推荐约束 |
| 🔥 做菜 · 烹饪模式 | 备菜清单逐项打勾 → 按灶台分配的逐步烹饪指导 → 完成打卡；支持语音播报开关 |

## 🛠 技术栈

- **前端**：[Taro 4](https://docs.taro.zone/) + React 18 + TypeScript 5 + Tailwind CSS 4（weapp-tailwindcss 跨端适配）+ Zustand
- **后端**：[NestJS 10](https://nestjs.com/) + Drizzle ORM + Zod
- **数据库**：Supabase（PostgreSQL）
- **AI 能力**：任何 OpenAI 兼容大模型接口（DeepSeek / 通义千问 / Kimi / GLM / OpenAI…），或通过 HTTP 触发器桥接微信云开发大模型
- **包管理**：pnpm（强制）
- **目标平台**：微信小程序（主）、H5（开发调试）、抖音小程序（兼容）

## 📁 项目结构

```
├── config/                  # Taro 构建配置（Vite、代理、Tailwind、CI 插件）
├── cloudfunctions/          # 微信云函数骨架（AI 桥接，方案 B 可选部署）
├── server/                  # NestJS 后端
│   └── src/
│       ├── modules/
│       │   ├── ai/          # AI 推荐 / 识别 / 解析 / 备菜 / 烹饪接口
│       │   ├── ingredients/ # 冰箱食材 CRUD + 拍照上传识别
│       │   ├── meal-plans/  # 就餐记录存档
│       │   ├── recipes/     # 菜谱库 + 私人菜谱
│       │   └── users/       # 家庭画像与口味偏好
│       └── storage/database # Supabase 客户端与 Drizzle schema
├── src/                     # Taro 前端
│   ├── pages/               # index(首页) / fridge(冰箱) / recipes(菜谱) / profile(我的) / cook(做菜)
│   ├── components/ui/       # shadcn 风格 Taro 组件库
│   ├── network.ts           # 请求封装（自动域名拼接）
│   └── utils/               # 保质期规则 / 本地身份
├── types/                   # 全局类型
└── .env.example             # 前端环境变量模板
```

## 🚀 快速开始

### 前置要求

- Node.js ≥ 18
- pnpm ≥ 9（`corepack enable` 后即可使用）
- 一个 Supabase 项目（或任意可访问的 PostgreSQL + Supabase 兼容接口）
- 一个 OpenAI 兼容的大模型 API Key

### 1. 安装依赖

```bash
pnpm install
```

### 2. 配置环境变量

```bash
# 前端（可选，H5 本地开发可不配）
cp .env.example .env.local

# 后端（必需）
cp server/.env.example server/.env
# 编辑 server/.env：填入 SUPABASE_URL / SUPABASE_ANON_KEY / AI_HTTP_* 等
```

数据库表结构参考 `server/src/storage/database/shared/schema.ts`（users / ingredients / recipes / meal_plans），可在 Supabase SQL Editor 中按此建表。

### 3. 启动开发

```bash
# 后端 NestJS（默认 http://localhost:3000，路由前缀 /api）
pnpm dev:server

# 前端 H5（默认 http://localhost:5000，/api 自动代理到后端）
pnpm dev:web

# 微信小程序（产物在 dist/，用微信开发者工具打开项目根目录）
pnpm dev:weapp
```

### 4. 构建与校验

```bash
pnpm build       # lint + tsc + web/weapp/tt/server 全量构建
pnpm validate    # 仅 lint + 类型检查
```

## ☁️ 微信云开发部署（必读）

本项目前端**不直连数据库**，全部经云函数中转。首次跑起来必须完成以下三步，
否则启动时会看到 `cloud.callFunction:fail ... FUNCTION_NOT_FOUND (-501000)`。

### 1. 部署云函数

```bash
node scripts/deploy-cloudfunctions.js            # 部署全部 7 个云函数
node scripts/deploy-cloudfunctions.js user recipe   # 只部署指定函数
node scripts/deploy-cloudfunctions.js --verify-only # 只核对云端现状
```

| 云函数 | 作用 |
| --- | --- |
| `user` | 用户档案读写（家庭人数 / 灶具 / 过敏忌口 / 口味） |
| `ingredient` | 冰箱食材 CRUD 与新鲜度状态机 |
| `recipe` | 菜谱库 + 就餐记录（备菜清单 / 烹饪步骤） |
| `ai-text` | 文本与视觉 AI（推荐 / 识别 / 解析 / 备菜 / 烹饪） |
| `ai-image` | 菜谱成品图生成（混元 HY-Image） |
| `db-init` | 数据库集合初始化（一次性） |
| `recipe-sync` | 开源菜谱库同步（HowToCook） |

> `ai-service` 目录是「方案 B」的后端桥接骨架，前端不调用，**无需部署**。

**部署后自动核对**：脚本会下载云端代码与本地逐字比对并校验依赖。
★ CLI 返回 `success` 只代表请求被接受，**不代表云端跑的是这份代码**——
只有逐字比对通过才算部署完成。

### 2. 初始化数据库集合（一次性）

```bash
# 另开一个终端，保持运行（连上开发者工具的自动化端口）
node scripts/devtools-auto.js

# 再开一个终端：建集合 + 灌入内置菜谱种子
node scripts/init-database.js --seed
node scripts/db:status          # 查看集合状态
```

建的是 4 个集合：`users` / `ingredients` / `meal_plans` / `recipes`。

> **索引与权限必须在控制台手动设置**（云开发 Node SDK 无法建索引）：
> - 权限：4 个集合均设为「**仅管理端可读写**」
> - 索引：见 `node scripts/init-database.js --status` 反馈的 `suggestedIndexes`
>
> 索引数据量小时可暂缓；**权限必须设**，否则前端可绕过云函数直读全量数据。

### 3. AI 能力配置（可选）

`ai-text` / `ai-image` 默认走云开发自带的混元模型（`AI_PROVIDER=cloudbase`），
需在云开发控制台开启 AI 能力。也可切到外部 OpenAI 兼容接口：
云函数「配置 → 环境变量」设 `AI_PROVIDER=http` 及
`AI_HTTP_BASE_URL` / `AI_HTTP_API_KEY` / `AI_HTTP_MODEL`。

AI 不可用时云函数返回本地规则兜底数据（`aiOffline=true`），核心流程不中断。

---

## 🤖 AI Provider 切换（后端 NestJS 版本）

后端通过 `AI_PROVIDER` 环境变量选择大模型来源，上层代码零改动：

| Provider | 说明 | 所需配置 |
| --- | --- | --- |
| `http`（默认） | 直连任何 OpenAI 兼容接口 | `AI_HTTP_BASE_URL` / `AI_HTTP_API_KEY` / `AI_HTTP_MODEL`（视觉另配 `AI_HTTP_VISION_MODEL`） |
| `wechat` | 转发到微信云开发云函数的 HTTP 触发器（密钥留在云侧） | `AI_WECHAT_URL` / `AI_WECHAT_TOKEN`，云函数骨架见 `cloudfunctions/ai-service/` |

AI 全部调用失败时后端返回内置的离线兜底菜单，保证核心流程不中断。

## 📱 平台说明

- **微信小程序**：本项目 `project.config.json` 中的 `appid` 请替换为你自己的小程序 AppID
- **TabBar 图标**位于 `src/assets/tabbar/`（微信强制要求本地 PNG）
- 拍照/语音等能力在 H5 端自动降级，仅小程序端完整可用
- AI 生成为推荐内容，前端展示处已标注「菜单由 AI 生成，仅供参考」

## 📄 版本与规范

- 版本号策略见 [VERSION.md](./VERSION.md)
- 开发规范（pnpm、命名、组件库、跨端兼容）见 [AGENTS.md](./AGENTS.md)
- 界面设计规范见 [DESIGN.md](./DESIGN.md)

## 📚 数据来源（第三方开源引用）

本项目的公共菜谱库引用自开源项目 **[HowToCook](https://github.com/Anduin2017/HowToCook)**（程序员做饭指南）：

- **许可证**：[Unlicense](https://github.com/Anduin2017/HowToCook/blob/master/LICENSE)（公有领域，可自由使用与商用）
- **版权**：菜谱内容归 HowToCook 原作者及贡献者所有，本项目仅做结构化转换
- **同步方式**：`scripts/fetch-recipes.js` 拉取上游仓库并解析为结构化数据（`data/recipes/`），经 `recipe-sync` 云函数幂等入库；每条菜谱携带 `sourceUrl` 指向上游原文
- **增量更新**：上游新增菜谱后执行 `pnpm recipes:deploy` 即可复用同一流程同步（详见下方「菜谱数据同步流水线」）

## 🍳 菜谱数据同步流水线（可复用）

```
GitHub 仓库 (HowToCook)
   │  ① pnpm recipes:fetch —— 克隆/更新 + 解析 markdown → 结构化 JSON
   ▼
data/recipes/howtocook.json          全量数据（入库持久化，提交 git）
data/recipes/howtocook.changed.json  增量数据（新增/变更子集）
data/recipes/manifest.json           来源 commit / 统计 / 增删摘要
   │  ② pnpm recipes:deploy —— 分发公共代码 → 离线自检 → CLI 部署云函数
   ▼
微信云开发 recipes 集合               按 slug 幂等 upsert（openid=null 公共菜谱）
```

- **增量拉取**：fetch 脚本对比上次数据的 `contentHash`，自动产出 `changed` 子集与 `removedSlugs` 清单
- **云端同步**：`node scripts/invoke-recipes-sync.js [--mode changed|full]`（经开发者工具 `cli auto` 自动化端口自动分批，单批 80 条，直到 `done:true`）；也可在云开发控制台「云端测试」传 `{"action":"sync","mode":"full","offset":0,"limit":80}` 按响应 `nextOffset` 手工续传；`prune:true` 可清理上游已删除的菜谱
- **★ 数据文件平铺**：部署数据副本以 `recipe-data.*.json` 放在函数根目录（Windows CLI 打包子目录会产出云端 Linux 读不到的反斜杠 zip 条目）
- **上游有新菜谱时**：重跑 `pnpm recipes:deploy`，按提示触发一次云端测试即完成同步，全程无需手工改数据

## 📄 License

[MIT](./LICENSE)
