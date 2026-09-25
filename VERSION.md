# 版本管理（VERSION）

本项目遵循 [语义化版本 SemVer 2.0.0](https://semver.org/lang/zh-CN/)：`MAJOR.MINOR.PATCH`。

- **MAJOR**：不兼容的 API / 数据结构变更（如数据库 schema 破坏性调整）
- **MINOR**：向下兼容的新功能（新页面、新接口、新 AI 能力）
- **PATCH**：向下兼容的问题修复

版本号唯一来源为根目录 `package.json` 的 `version` 字段（`server/package.json` 与其保持同步），发布时同步打 Git tag（格式 `v<version>`）。

## 版本历史

### v1.0.0 — 2026-09（本地化基线）

- ✅ 完整功能：AI 菜单推荐、冰箱食材管理（拍照/语音/文本录入 + 保质期预警）、菜谱库与私人菜谱、口味偏好画像、备菜/烹饪模式
- 🔄 **脱离 Coze 平台完成本地化**：
  - 移除 `coze-coding-dev-sdk` 私有依赖（AI 调用、Supabase 连接、对象存储全部改为标准开源实现）
  - AI Provider 切换为 `http`（OpenAI 兼容接口，默认）/ `wechat`（云函数桥接）双模式
  - 拍照识别的图片存储改为 Supabase Storage，未配置时回退 base64 直传
  - 删除 `.coze` / `.cozeproj` 平台脚本，构建脚本回归标准 `taro build`
  - 项目更名 `today-eat-what`，新增 `.env.example` 配置模板
- ⚠️ 状态：本地构建与自检通过；微信小程序真机/正式环境未验证

### v1.0.1 — 2026-09-25（云开发链路打通）

- 🐛 **修复启动即报 `-501000 FUNCTION_NOT_FOUND`**：
  - 根因不是本地化未完成，而是云端只部署了 `db-init` / `recipe-sync` 两个云函数，
    首页启动调用的 `user` / `ingredient` 缺失
  - 补齐部署 5 个云函数（`user` / `ingredient` / `recipe` / `ai-text` / `ai-image`），
    云端现有 7 个
- 🔒 页面层从 `Network.request` + `getOpenid` 迁移到 `@/cloud` 云开发调用层：
  openid 改由云函数从 `getWXContext()` 取，前端不再传入，堵死伪造路径
- 🛠 新增部署工具链（修复三个 Windows/CLI 坑）：
  - `scripts/deploy-cloudfunctions.js`：CLI 的 `--names` 只接受单个函数名
    （逗号分隔报 `cloudfunction path not found`）；Creating 状态自动退避重试；
    **部署后下载云端代码逐字核对** —— CLI 返回 `success` 只代表请求被接受，
    不代表云端跑的是这份代码
  - `scripts/init-database.js` + `scripts/devtools-auto.js`：经 CLI 自动化端口
    真实调用 `db-init`，绕开 `cli.bat` 在 git-bash 下不可用
  - `scripts/deploy-recipes.js` 改为复用上述脚本，顺带获得源码核对能力
  - `project.config.json` 补 `cloudfunctionRoot`；README 补「微信云开发部署」整节
- ✅ **已验证**（2026-09-25）：
  - 7 个云函数云端源码与本地逐字一致、依赖齐备
  - `node cloudfunctions/test-offline.js` 48 项全过、`pnpm validate` 全绿
  - 开发者工具模拟器实跑：启动报错消失，首页正常渲染
    （人数区「2 人」= `user` 返回、冰箱区空态文案 = `ingredient` 返回）
- 🔒 **集合权限已收紧**（2026-09-25，控制台配置）：`users` / `ingredients` /
  `meal_plans` / `recipes` 均由默认「仅创建者可读写」改为「所有用户不可读写」
  —— 小程序端零权限，读写全部经云函数（管理端身份，不受该档位限制）
  - **不影响个人菜谱功能**：私人菜谱的建/改/删/查全链路都在云函数内，
    前端不直连数据库（`src/` 下无任何 `wx.cloud.database()`），
    归属隔离靠 `openid` 字段 + 查询条件 `_.or([{openid:null},{openid}])`，
    不依赖集合权限档位
  - 已排除的旁路：前端若有人新增直连查询，现会直接被拒（原档位下可读到自己
    `_openid` 的记录），等于多加一道与代码自律无关的防线
- ⚠️ **仍未验证**：正式环境 / 真机（非模拟器）未跑过

### v1.1.0 — 2026-09-26（AI 全链路 + 初版流程打通）

**里程碑**：AI 交互从「只走兜底」变为真跑 hy3 大模型，完整闭环
（推荐 → 选菜 → 备菜/做菜 → 出餐 → 补货 → 入库 → 记录）打通。

#### 🎯 AI 能力真正生效
- 🐛 **修复 AI 调用必然超时**：`ai-text` 云端超时默认 3 秒，而 hy3 实际耗时
  1.8~4.6 秒 → 每次调用都 `-504003` 超时、静默回退本地兜底。
  超时改 60 秒后实测 **冒烟测试 5/5 通过**，首次确认 hy3 真在跑。
- ✨ **prompt 集中化**：新建 `cloudfunctions/_shared/prompts.js`，
  4 个 prompt（recommend / cookingPlan / recognize / parseText）统一维护，
  每个带 `version` + `schema` + `example` 三件套（few-shot 提升 JSON 稳定性）。
  `ai-text` 内零硬编码 prompt 残留。
- ✨ **接口挂接与可观测日志**：每个 action 打印入参 / 模型名 / prompt 版本 /
  耗时 / JSON 解析结果；解析失败时打印原始返回前 800 字。

#### 🍳 推荐与做菜流程
- ✨ **recommend 输入增强**：接入近一周做菜记录（`recipe.recentDishes`，
  避开重复）与菜谱库候选（`recipe.matchByIngredients`，按食材命中数 +
  匹配率排序，云端匹配只回候选菜名，避免 372 条全量入 prompt）。
- ✨ **缺料补充建议**：大模型产出 `missing_ingredients`；
  基础调味料（盐糖油醋等）在 prompt 与后端双重排除，不产生"补货：盐"类噪音。
- ✨ **备菜 + 做菜合并为一次调用**（`cookingPlan`）：原 `prep`/`cooking`
  两次请求合并，点「备菜完成」不再等待第二轮；旧 action 名保留为别名。
- ✨ **缺料一键补货**：移到备菜环节（菜品已确定，缺料才准确），
  支持改数量与**单位**；缺料为**本地集合运算**（不额外调模型），
  并标注每个缺料用于哪道菜。
- ✨ **统筹建议展示**：`cooking_tips` 此前云函数一直返回但页面从未渲染，已补上。

#### 🧊 冰箱与食材
- ✨ **同类项合并**：`西红柿`/`番茄`、`马铃薯`/`土豆` 等不再各存一条，
  合并时累加数量、合并录入途径（显示「文本+拍照」）、取较晚的保质期。
- ✨ **食材命名归一化共享模块**：新建 `_shared/ingredient-names.js`，
  30+ 组同义词 + 基础调料白名单，由 `recipe`/`ingredient`/`ai-text`
  三函数共用（原先三份重复表，改一处漏两处）。
- ✨ **单位可选 + 入库归一化**：`g/kg/斤/个/ml/L/份/把/棵/包/盒`，
  入库统一 `kg→g`、`L→ml`；合并时**先换量纲再相加**
  （修复 `1斤 + 500g` 被算成 501 的隐患），跨量纲无法换算则放弃累加并 warn。
- ✨ **拍照识别 → 确认弹窗 → 入库**：识别结果作为初稿，用户可改名称 /
  数量 / 单位、删除误识别项、手动补项；识别失败不阻断流程。
- ✨ **图片 base64 直传**：不再落云存储，调用后即销毁；
  上传前 `compressImage` 压缩（质量 80、最长边 1280），
  云函数侧再加 4MB 体积保护。

#### 🖥 界面与状态
- ✨ **跨 tab 状态同步**：新建 `src/store/profile.ts`（zustand），
  档案保存后首页立即可见；`useDidShow` 兜底刷新。
- ✨ **离开首页清空推荐**：`useDidHide` 重置推荐与选中，出餐回首页不再看到上轮残留。
- ✨ **冰箱页 `useDidShow` 刷新**：修复「一键补货后切到冰箱看不到新食材、
  必须重进小程序」的 tab 页缓存问题。
- 🐛 **底部操作栏重叠/错位**：改为**纯流式布局**（根容器 `flex-col` +
  内容 `flex-1` + 底栏参与文档流），彻底移除绝对定位与占位块补丁；
  安全区用 `env(safe-area-inset-bottom)`。
  —— 此前三轮分别在 `bottom:50px`、占位块、`screenHeight-windowHeight`
  上打转，根因是"用绝对定位适应布局"本身方向错了。
- 🐛 **`showLoading`/`hideLoading` 未配对**：改为先收集提示文案，
  关闭 loading 后再 toast。

#### 🛠 工具链
- ✨ `scripts/ai-smoke-test.js`：7 条用例的 AI 冒烟测试
  （health / recommend×2 / cookingPlan / parse + recipe 两条新 action），
  逐条打印耗时与判据，失败时给出排查提示。`pnpm ai:smoke` 可跑。

#### ✅ 已验证（2026-09-26）
- hy3 冒烟测试 7 条用例通过（含 prompt 版本核对 = 确认云端跑的是新版）
- 缺料口径 v1→v2 实测修正：`盐糖油醋` 噪音消除
- 用户在开发者工具实测：推荐 / 选菜 / 备菜 / 做菜 / 出餐 / 补货 / 入库
  全流程可用；人数同步、冰箱刷新、按钮布局均已复测通过
- `test-offline` 48 项全过、`pnpm validate` 全绿、`build:weapp` 成功
- 7 个云函数云端源码与本地逐字一致

#### ⚠️ 仍未验证 / 已知未完成
- **正式环境 / 真机（非模拟器）未跑过**
- **拍照识别链路从未端到端跑通**：base64 直传 + 确认弹窗为新实现，
  仅过静态校验（此前 fileID 方案因 3 秒超时根本没成功过）
- **菜谱库匹配对推荐质量的实际影响未评估**
- 菜谱库尚未按 D1 规划补充「简略信息」字段（现依赖开源 `ingredients`，
  372 条中 144 条可命中）；如需提升匹配质量可后续补充
- 冰箱页 `fridge` 的悬浮按钮仍用 `fixed + bottom-24` 硬编码，
  未按流式方案改造（非当前问题，留待后续）

## 发布流程（建议）

1. 更新 `package.json` / `server/package.json` 的 `version`
2. 在本文件追加版本条目
3. `pnpm build` 全量校验通过后提交：`chore(release): v<x.y.z>`
4. 打 tag：`git tag -a v<x.y.z> -m "v<x.y.z>"`
5. 未在正式环境（真机/生产）验证的版本，tag 追加 `-unverified` 后缀并在版本条目中注明
