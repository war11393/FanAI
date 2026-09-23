# 设计指南 ·「今天吃什么」温馨插画风

> 应用定位：面向家庭的每日饮食决策助手。铲平"今天吃什么"的纠结，把下厨变成一件温暖、有成就感的小事。
> 风格内核：厨房里的烟火气 + 手绘插画的亲切感，避免冷冰冰的"科技感"。

## 一、配色方案

| 语义 | 值 | Tailwind 参考 | 用途 |
|---|---|---|---|
| 主色 / 品牌橙 | `#FF8C42` | `bg-[#FF8C42]` 或 `bg-orange-500` | 主按钮、"今天吃什么"大按钮、选中态、TabBar 高亮 |
| 主色浅底 | `#FF8C42` 15% 透明度 | `bg-orange-500/15` | 区块浅底填充、图标浅底 |
| 米黄辅助 / 背景 | `#FFF3E0` | `bg-[#FFF3E0]` / `bg-orange-50` | 页面整体背景、卡片底、插画氛围底 |
| 奶油白 | `#FFFDF8` | `bg-[#FFFDF8]` | 主卡片背景 |
| 正文墨色 | `#3E3226` | `text-[#3E3226]` | 主文字（暖调深棕） |
| 次级文字 | `#8B7D6E` | `text-[#8B7D6E]` | 说明、辅助文字 |
| 成功 / 新鲜 | `#4CAF50` | `bg-green-500` | 食材新鲜度-正常 |
| 警告 / 临期 | `#FFC107` | `bg-amber-500` | 食材新鲜度-临期 |
| 危险 / 过期 | `#F44336` | `bg-red-500` | 食材新鲜度-过期 |

- 颜色统一收敛到这些语义色；不建议引入其它色系（如蓝紫），保持温暖的统一感。

## 二、字体 / 排版

- 标题层级：`text-xl font-bold` → `text-lg font-semibold` → `text-base font-medium`
- 数字（就餐人数、步进器）：用醒目的大号粗体，配合主色突出。
- 正文 `text-sm`，辅助说明 `text-xs text-[#8B7D6E]`。

## 三、间距系统

- 页面边距：`px-5`（左右），页面顶 `pt-4`。
- 卡片内边距：`p-5`。
- 卡片间距：`space-y-4` / `gap-4`。
- 大按钮：圆角 `rounded-3xl`（手绘圆润感），高度 `py-4`/`py-5`。

## 四、组件选型（强制）

除非组件库未覆盖，遵循：
- 通用组件优先来自 `@/components/ui/*`（Button / Badge / Card / Dialog / Tabs / Switch / Input / Skeleton / Separator / Select / Sheet）。
- 禁止用 `View/Text` 手搓按钮、输入框、弹窗、标签、Tabs 等通用 UI。
- 心跳按钮"今天吃什么"可用 `View + lucide-react-taro` 做手绘感的插画大按钮（属业务视觉元素）。

## 五、卡片与容器风格

- 卡片：`bg-[#FFFDF8] rounded-3xl p-5`，弱阴影 `shadow-sm`。
- 分组标题：左侧小色块（主色圆点）+ 文字。
- 新鲜度标签：胶囊 `rounded-full px-2.5 py-0.5 text-xs text-white`（绿/黄/红）。

## 六、导航结构

- TabBar 3 页：首页（index）、冰箱（fridge）、我的（profile）。
- TabBar 颜色：`selectedColor #FF8C42`、`color #999999`、背景白。
- 页面跳转：TabBar 页用 `Taro.switchTab`，普通页（做饭流程）用 `Taro.navigateTo`。

## 七、交互与动效

- "来且了"弹窗：小人跑进屋的插画配合 `animate-bounce`/`animate-pulse` 轻快动画。
- 步进器：大号 `+`/`-` 按钮，圆角，主色描边，动效反馈。
- 语音按钮：录音时红色脉冲动画。

## 八、设计禁忌

- 不使用冷色科技蓝、紫渐变、玻璃拟态。
- 不使用生硬直角（一律大圆角）。
- 不做过度动画与装饰，运动克制而温暖。
- 不用会显得廉价的强阴影，用柔和的 `shadow-sm`。