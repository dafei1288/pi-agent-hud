# pi-agent-hud — Pi HUD Extension

pi-agent-hud 是一个 [pi-coding-agent](https://github.com/nicholasgasior/pi) 的状态栏扩展，在终端底部实时显示会话信息。

灵感来自 [claude-hud](https://github.com/jarrodwatts/claude-hud)。

![demo](docs/demo.png)

## 预览

```
[claude-sonnet-4-6] pi-mono git:(main) · medium    [████████░░░░░░░░░░░░] 39%    ⏱ 21m
AGENTS.md · skills x5 · ext.tools x2 · 📋 12t 🔍📖✎ · ✓ Grep ×10 · ✓ Bash ×3 · ◐ Edit (12s) · ◐ agent (2m 15s)
▸ how to build a REST API with authentication?
```

## 安装

### 方式一：克隆后安装（推荐）

```bash
# 1. 克隆仓库
pi install npm:pi-agent-hud
```

### 方式二：Claude / Pi 一键安装

在 Claude 或 Pi 对话中直接说：

```
请帮我安装 pi-agent-hud 扩展到当前项目
```

### 方式三：命令行临时加载

```bash
pi -e npm:pi-agent-hud
```

### 验证安装

```bash
pi list
```

安装后重启 pi 或在会话中输入 `/reload` 即可激活。

## 显示内容

### Line 1 — 会话概览

```
[模型名] 项目名 git:(分支) · thinking级别    [████░░░░] 39%    ⏱ 21m
```

| 元素 | 说明 |
|------|------|
| `[模型名]` | 当前 LLM 模型 ID |
| 项目名 | 当前工作目录名 |
| `git:(分支)` | Git 分支，非 git 仓库不显示 |
| `· medium` | Thinking 级别，关闭时不显示 |
| `[████░░░░] 39%` | Context 窗口使用率进度条 |
| `⏱ 21m` | 会话已运行时长 |

进度条颜色：<font color="green">0-70% 绿色</font> / <font color="orange">70-90% 黄色</font> / <font color="red">90%+ 红色</font>

### Line 2 — 活动详情

```
AGENTS.md · skills x5 · ext.tools x2 · ✓ Grep ×10 · ◐ Edit (12s) · ◐ agent (2m 15s)
```

| 元素 | 说明 |
|------|------|
| `AGENTS.md` | 检测到的上下文配置文件（绿色） |
| `skills x5` | 已加载的 skill 数量 |
| `ext.tools x2` | 扩展注册的工具数量 |
| `cmds x3` | 扩展注册的 slash 命令数量 |
| `↑12.5k ↓3.2k` | Token 明细，默认始终显示，可配置 |
| `$0.042` | 会话累计费用 |
| `✓ Grep ×10` | 已完成工具调用统计，按次数降序 |
| `◐ Edit (12s)` | 正在执行的工具，黄色 |
| `◐ agent (2m 15s)` | 正在运行的 Agent 循环，黄色 |

### Line 3 — 最近输入 + 历史提示

```
▸ how to build a REST API with authentication?  Ctrl+H:5
```

| 元素 | 说明 |
|------|------|
| `▸` | 指示符 |
| 用户文本 | 最近一次用户输入内容 |
| `Ctrl+H:5` | 历史记录数量提示（仅当历史 ≥ 2 条时显示） |

### Ctrl+H — 历史记录 + 执行计划浮层

按 `Ctrl+H` 弹出统一浮层，`Tab` 键在**历史记录**和**执行计划**之间切换；`Ctrl+Shift+J` 直接打开执行计划页：

**历史记录页（默认）：**

```
┌ [ History ]  Plan (Tab) ───────────────────────────────┐
│ ▸ how to build a REST API with authentication?        │
│   请帮我检查文档                                        │
│   帮我提交一下                                          │
├ ↑↓ scroll · Enter select · Tab plan · Esc close ──────┤
└────────────────────────────────────────────────────────┘
```

| 按键 | 功能 |
|------|------|
| `↑` / `k` | 上移选择 |
| `↓` / `j` | 下移选择 |
| `Enter` | 选中并回填到输入框 |
| `Tab` | 切换到执行计划页 |
| `Esc` / `Ctrl+C` | 关闭浮层 |

**执行计划页（Tab 切换）：**

```
┌ History (Tab)  [ Plan ] ───────────────────────────────┐
│ 🎯 how to build a REST API                              │
│ 📋 12 turns                                             │
├─────────────────────────────────────────────────────────┤
│ 📊 📖×5  ✎×3  🔍×2  ⚙×2                                │
├─────────────────────────────────────────────────────────┤
│ 🕐 Tool call timeline                                   │
│   ✓ 🔍 grep · extension                                 │
│   ✓ ✎ edit · extensions/agent-hud/index.ts             │
│   ◐ ⚙ bash · npm build (12s)                           │
├─────────────────────────────────────────────────────────┤
│ 💬 Turn log                                             │
│ T01 I'll start by reading the project structure         │
│ T02 Let me search for the relevant files...             │
│ T03 I'll make the changes to the extension...           │
└ Esc close ─────────────────────────────────────────────┘
```

| 按键 | 功能 |
|------|------|
| `Tab` | 切换回历史记录页 |
| `Esc` / `Ctrl+C` | 关闭浮层 |

**计划页详情：**

- **📊 分类统计** — 读/搜/写/执行/网络各类工具使用次数
- **🕐 工具时间线** — 最近工具调用序列，✓完成/◐运行中 + 耗时
- **💬 Turn log** — 每轮 agent 回复摘要，最多显示最近 10 轮
- **Agent 计划**（如有结构化步骤）— 步骤进度 + Subagent 委派状态

详细文档见 [docs/pi-agent-hud.md](docs/pi-agent-hud.md)。

### 气泡编辑器（Bubble Editor）

配置 `"editor": "bubble"` 后，默认输入框替换为带边框的气泡编辑器：

- 顶栏左侧：模型（provider 配色 + 图标）· thinking 档位 · 5h/每周额度 · 余额
- 顶栏右侧：git 分支 · worktree 标记 · 项目路径
- 图标风格：环境变量 `BUBBLE_ICON_MODE=nerdfont|unicode|emoji`（默认 unicode）
- 运行时切换：`/bubble` 命令开/关

气泡编辑器与状态栏共享同一份额度数据，不会重复请求配额接口。

## 配置

在 `.pi/pi-agent-hud.json`（项目级）或 `~/.pi/agent/pi-agent-hud.json`（全局）中配置：

```jsonc
{
  // Token 显示模式："always" 始终 | "highContext" 仅高占用时
  "tokenMode": "always",
  "tokenThreshold": 85,

  // 显示/隐藏元素
  "disabled": ["extCmds", "cost"],

  // 调试：把响应中的限额相关 header 落盘到 ~/.pi/agent/pi-agent-hud-headers.jsonl
  // （也可用环境变量 PI_HUD_DEBUG_HEADERS=1 开启）
  "debugDumpHeaders": false,

  // 输入框组件："default" 默认 | "bubble" 气泡编辑器（也可用 /bubble 命令切换）
  "editor": "default",

  // 或只显示指定元素（二选一）
  // "enabled": ["model", "project", "git", "contextBar", "elapsed", "tokens"]
}
```

**可配置元素：**

| 元素 | 说明 | 默认 |
|------|------|------|
| `model` | 模型名称 | ✅ |
| `project` | 项目目录名 | ✅ |
| `git` | Git 分支 | ✅ |
| `thinking` | Thinking 级别 | ✅ |
| `contextBar` | Context 进度条 | ✅ |
| `elapsed` | 会话时长 | ✅ |
| `contextFiles` | 上下文配置文件 | ✅ |
| `skills` | Skill 数量 | ✅ |
| `extTools` | 扩展工具数量 | ✅ |
| `extCmds` | 扩展命令数量 | ✅ |
| `tokens` | Token 明细 | ✅ |
| `cost` | 费用 | ✅ |
| `balance` | 💰 账户余额（DeepSeek 等按量付费 API） | ✅ |
| `rateLimit` | ⚡ API 额度剩余（Anthropic/OpenAI 自动检测） | ✅ |
| `plan5h` | ⏳ Coding Plan 5小时窗口用量（Claude 订阅 / Codex OAuth） | ✅ |
| `planWeek` | 📅 Coding Plan 周窗口用量（Claude 订阅 / Codex OAuth） | ✅ |
| `toolStats` | 工具调用统计 | ✅ |
| `runningTools` | 正在执行的工具 | ✅ |
| `runningAgents` | 正在运行的 Agent | ✅ |
| `lastInput` | 最近输入 | ✅ |
| `historyHint` | Ctrl+H 历史提示 | ✅ |

完整配置示例见 [examples/pi-agent-hud.json](examples/pi-agent-hud.json)。

## Coding Plan 用量（5小时 / 周限额）

使用订阅配额（Claude Pro/Max 订阅、ChatGPT Codex OAuth）时，HUD 会从响应头自动解析两个配额窗口并显示：

```
⏳5h 42% ↻2h15m · 📅wk 18% ↻3d4h
```

- **Claude 订阅（OAuth）**：解析 `anthropic-ratelimit-unified-5h-*` / `-7d-*` 响应头
- **Codex（ChatGPT OAuth）**：解析 `x-codex-primary-*`（主窗口）/ `x-codex-secondary-*`（周窗口）响应头，窗口时长由服务端返回，自动适配
- **GLM Coding Plan（智谱，zai-coding-cn）**：响应头不含配额，HUD 每 5 分钟轮询 `open.bigmodel.cn/api/monitor/usage/quota/limit`（从环境变量 `ZAI_CODING_CN_API_KEY` 或 `~/.pi/agent/auth.json` 读取 key）
- **GLM Coding Plan 国际版（zai / zai-coding-plan）**：同构接口，轮询 `api.z.ai`（Authorization 直接携带 key，不带 Bearer）
- **opencode Zen 订阅（opencode / opencode-go）**：轮询 `opencode.ai/zen/go/v1/usage`，含 5h / 7d / 30d 三个窗口（30d 窗口由 `plan30d` 元素显示）
- **MiniMax Coding Plan（minimax / minimax-cn）**：同样无响应头配额，HUD 每 5 分钟轮询 `api.minimaxi.com/v1/api/openplatform/coding_plan/remains`（key 来自 `MINIMAX_API_KEY` 或 `auth.json`）
- **Kimi Coding Plan（kimi）**：同样无响应头配额，HUD 每 5 分钟轮询 `api.kimi.com/coding/v1/usages`（key 依次从 `KIMI_CODE_API_KEY`/`KIMI_API_KEY`、`auth.json`、或 `~/.pi/agent/models.json` 的 `providers.kimi.apiKey` 读取）
- 颜色随用量变化：≤70% 绿 / >70% 黄 / >90% 红；`↻` 后为重置倒计时
- 纯 API key（按量付费）没有 5h/周配额概念，这两个元素会自动隐藏，仅显示 `rateLimit`

## 账户余额（按量付费 API）

使用按量付费 API（如 DeepSeek）时，HUD 每 5 分钟轮询余额接口并显示：

```
💰 ¥12.50
```

- **DeepSeek**：轮询 `api.deepseek.com/user/balance`（key 依次从 `DEEPSEEK_API_KEY`、`auth.json`、`models.json` 的 `providers.deepseek.apiKey` 读取）
- **StepFun**：轮询 `api.stepfun.com/v1/accounts`（人民币；`STEPFUN_API_KEY` / `auth.json` / `models.json`，支持 `"apiKey": "$STEPFUN_API_KEY"` 这类环境变量引用）
- **Kimi 开放平台（moonshotai-cn / moonshot / moonshotai）**：轮询 `/v1/users/me/balance`，.cn 站人民币、.ai 站美元；主站 401/业务层拒绝时自动换另一站
- **SiliconFlow（siliconflow / siliconflow-cn）**：轮询 `/v1/user/info`，.cn 人民币、.com 美元，同样支持站点回退
- **OpenRouter（openrouter）**：轮询 `openrouter.ai/api/v1/credits` 计算剩余 Credits（需 Management Key，普通 Key 返回 403 时不显示）
- **Skywork（skywork）**：轮询 `api.skyworkmodel.ai/api/v1/balance`（币种由响应携带）
- **Novita（novita）**：轮询 `api.novita.ai/openapi/v1/billing/balance/detail`（接口单位 1/10000 USD，已换算）
- 余额 ≤0 显示红色，<10 显示黄色，>10 绿色；超过 10 分钟未刷新变暗
- 切换 provider 时自动清除旧余额数据

不确定账号返回哪些头？开启 `"debugDumpHeaders": true`（或环境变量 `PI_HUD_DEBUG_HEADERS=1`），所有限额相关响应头会记录到 `~/.pi/agent/pi-agent-hud-headers.jsonl`。

## 网格布局

默认单栏模式（不设 `layout`）和现在完全一样。设置 `layout` 后启用网格分栏：

```jsonc
{
  // 每行列数数组，最多 5 行，每行 1/2/4 列
  "layout": [1, 2, 2],

  // 把元素钉到指定格子 { line: 行号(0起), col: 列号(0起) }
  // 未列出的元素自动从左到右、从上到下填充
  "placement": {
    "tokens":   { "line": 1, "col": 0 },
    "cost":     { "line": 1, "col": 0 },
    "toolStats": { "line": 1, "col": 1 },
    "lastInput": { "line": 2, "col": 0 },
    "plugin:random-quote": { "line": 2, "col": 1 }
  }
}
```

**渲染效果**（`layout: [1, 2, 2]`）：

```
Line 1 (全宽):
[claude-sonnet-4-6] pi-agent-hud git:(main) · medium    [████░░] 39%    ⏱ 21m

Line 2 (2列):
AGENTS.md · ↑12.5k ↓3.2k          │  ✓ Grep ×10 · ✓ Bash ×3

Line 3 (2列):
▸ how to build a REST API with auth? │  💬 温故而知新，可以为师矣。—— 孔子
```

**5 行仪表盘**（`layout: [1, 2, 2, 2, 4]`，最多 4×5=20 格）：

```
Line 1: [全宽]  模型 + 项目 + 进度条 + 时长
Line 2: [2列]   状态信息     │  资源统计
Line 3: [2列]   工具统计     │  运行状态
Line 4: [2列]   最近输入     │  💬 谏言
Line 5: [4列]   col0 │ col1 │ col2 │ col3
```

**布局 Demo 文件：**

| 文件 | 说明 |
|------|------|
| [examples/layout-2col-demo.json](examples/layout-2col-demo.json) | 2 列分栏布局 |
| [examples/layout-dashboard-demo.json](examples/layout-dashboard-demo.json) | 5 行仪表盘布局 |

## 插件系统

用户可以编写自定义插件，向 HUD 添加任何内容。

插件放置在 `.pi/pi-agent-hud-plugins/*.js`（项目级）或 `~/.pi/agent/pi-agent-hud-plugins/*.js`（全局）。

**插件接口：**

```js
module.exports = {
  name: "my-plugin",        // 唯一名称
  target: "line2",         // "line1" | "line2" | "line3" | "line4" | "line5"
  order: 100,              // 排序，越小越靠前
  col: 0,                  // 可选：网格模式下指定列号

  render(ctx, theme, width) {
    // ctx: 包含所有 HUD 数据
    // theme.fg(color, text): 颜色，color = text|dim|accent|success|warning|error
    // width: 终端宽度
    // 返回 string 显示，undefined 跳过
    return theme.fg("dim", `🔁 ${ctx.inputHistory.length} turns`);
  },
};
```

**示例插件：**

| 文件 | 功能 |
|------|------|
| [examples/turn-counter-plugin.js](examples/turn-counter-plugin.js) | 显示对话轮次计数 |
| [examples/clock-plugin.js](examples/clock-plugin.js) | 在 Line 1 显示当前时间 |
| [examples/context-emoji-plugin.js](examples/context-emoji-plugin.js) | 用 emoji 替代 context 进度条 |
| [examples/quote-plugin.js](examples/quote-plugin.js) | 每 10 秒随机显示一条谏言 💬 |

## 项目结构

```
pi-agent-hud/
├── extensions/
│   └── agent-hud/                  # 扩展源码（多文件目录扩展）
│       ├── index.ts                # 入口：事件/快捷键/命令装配
│       ├── quota.ts                # LLM 计费/额度共享服务
│       ├── state.ts                # 会话状态 + 事件追踪
│       ├── hud-footer.ts           # 状态栏 + 插件系统
│       ├── bubble-editor.ts        # 气泡编辑器
│       ├── overlay.ts              # 历史/计划 overlay
│       ├── layout.ts               # 渲染辅助 + 网格布局
│       └── config.ts               # 配置加载 + 元素开关
├── scripts/
│   └── install.js                 # 安装脚本（拷贝目录到 .pi/extensions/）
├── examples/
│   ├── pi-agent-hud.json           # 配置示例（全字段）
│   ├── layout-2col-demo.json       # 布局 Demo：2 列分栏
│   ├── layout-dashboard-demo.json  # 布局 Demo：5 行仪表盘
│   ├── turn-counter-plugin.js      # 插件：轮次计数
│   ├── clock-plugin.js             # 插件：时钟
│   ├── context-emoji-plugin.js     # 插件：emoji context
│   └── quote-plugin.js             # 插件：随机谏言
├── docs/
│   └── pi-agent-hud.md             # 详细文档
├── tsconfig.json
├── package.json
├── README.md
└── README_EN.md
```

## 依赖

运行时依赖 pi-coding-agent 的 Extension API：

- `@mariozechner/pi-ai`
- `@mariozechner/pi-coding-agent`
- `@mariozechner/pi-tui`

无需额外安装 npm 包，扩展由 pi 运行时直接加载。

## License

MIT
