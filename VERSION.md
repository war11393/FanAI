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

## 发布流程（建议）

1. 更新 `package.json` / `server/package.json` 的 `version`
2. 在本文件追加版本条目
3. `pnpm build` 全量校验通过后提交：`chore(release): v<x.y.z>`
4. 打 tag：`git tag -a v<x.y.z> -m "v<x.y.z>"`
5. 未在正式环境（真机/生产）验证的版本，tag 追加 `-unverified` 后缀并在版本条目中注明
