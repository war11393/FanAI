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

## 发布流程（建议）

1. 更新 `package.json` / `server/package.json` 的 `version`
2. 在本文件追加版本条目
3. `pnpm build` 全量校验通过后提交：`chore(release): v<x.y.z>`
4. 打 tag：`git tag -a v<x.y.z> -m "v<x.y.z>"`
5. 未在正式环境（真机/生产）验证的版本，tag 追加 `-unverified` 后缀并在版本条目中注明
