/**
 * bubble-editor.ts — 气泡框编辑器
 *
 * 顶部边框：左边=模型（provider 配色+图标）· thinking · 5h/周额度 · 余额
 *           右边=分支 · worktree · 项目路径
 * 底部边框：快捷键提示
 *
 * 图标风格：环境变量 BUBBLE_ICON_MODE = nerdfont | unicode | emoji（默认 unicode）
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CustomEditor, type ExtensionAPI, type ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth, type TUI } from "@mariozechner/pi-tui";
import { formatResetCountdown } from "./layout.ts";
import type { QuotaService } from "./quota.ts";

// ============================================================================
// 图标系统：Nerd Font / Unicode / Emoji 三种风格
// ============================================================================

type IconMode = "nerdfont" | "unicode" | "emoji";

interface IconSet {
	providers: Record<string, string>;
	os: Record<string, string>;
	branch: string;
	worktree: string;
	money: string;
	sep: string;
}

const ICON_SETS: Record<IconMode, IconSet> = {
  nerdfont: {
    providers: {
      anthropic: "",
      openai: "",
      google: "",
      deepseek: "",
      "zai-coding-cn": "",
      minimax: "",
      "minimax-cn": "",
      kimi: "",
    },
    os: { win32: "", darwin: "", linux: "", other: "" },
    branch: "",
    worktree: "",
    money: "",
    sep: " · ",
  },
  unicode: {
    providers: {
      anthropic: "●", openai: "◉", google: "◆", deepseek: "▲",
      "zai-coding-cn": "▣", minimax: "★", "minimax-cn": "★", kimi: "◐",
    },
    os: { win32: "▩", darwin: "⌘", linux: "◈", other: "▣" },
    branch: "⎇",
    worktree: "§",
    money: "＄",
    sep: " · ",
  },
  emoji: {
    providers: {
      anthropic: "🧠", openai: "🟢", google: "🔵", deepseek: "🐳",
      "zai-coding-cn": "🌐", minimax: "⭐", "minimax-cn": "⭐", kimi: "🌙",
    },
    os: { win32: "🪟", darwin: "🍎", linux: "🐧", other: "💻" },
    branch: "🌿",
    worktree: "🔗",
    money: "💰",
    sep: " · ",
  },
};

function getIconMode(): IconMode {
	const env = (process.env.BUBBLE_ICON_MODE || "").toLowerCase();
	if (env === "nerdfont" || env === "nf") return "nerdfont";
	if (env === "emoji") return "emoji";
	return "unicode";
}

const ICON_MODE = getIconMode();
const ICONS = ICON_SETS[ICON_MODE];
const osIcon = (): string => ICONS.os[process.platform] ?? ICONS.os.other;

/** 图标加粗渲染：unicode 符号默认是细线条，加粗后更饱满。
 *  emoji 模式下无需加粗（emoji 本身就是彩色实心）。 */
const ico = (s: string): string =>
	ICON_MODE === "emoji" ? s : `\x1b[1m${s}\x1b[22m`;

/** 图标 + 文本统一带一个空格分隔 */
const iconText = (icon: string, text: string): string => `${ico(icon)} ${text}`;

const BLUE = (s: string) => `\x1b[38;5;75m${s}\x1b[0m`; // 蓝色边框

// Provider 配色（不含图标，图标走 ICON_SETS）
const PROVIDER_COLOR: Record<string, (s: string) => string> = {
  anthropic:       (s) => `[38;5;209m${s}[0m`,
  openai:          (s) => `[38;5;78m${s}[0m`,
  google:          (s) => `[38;5;75m${s}[0m`,
  deepseek:        (s) => `[38;5;51m${s}[0m`,
  "zai-coding-cn": (s) => `[38;5;141m${s}[0m`,
  minimax:         (s) => `[38;5;221m${s}[0m`,
  "minimax-cn":    (s) => `[38;5;221m${s}[0m`,
  kimi:            (s) => `[38;5;117m${s}[0m`,
};


// ============================================================================
// Git 信息
// ============================================================================

interface GitInfo {
	/** 完整项目路径 */
	project: string;
	branch: string;
	isWorktree: boolean;
}

function readGitInfo(cwd: string): GitInfo {
	const info: GitInfo = { project: cwd, branch: "", isWorktree: false };
	let cur = cwd;
	for (let i = 0; i < 20; i++) {
		const gp = path.join(cur, ".git");
		try {
			const stat = fs.statSync(gp);
			info.isWorktree = stat.isFile();
			const headPath = info.isWorktree
				? path.join(fs.readFileSync(gp, "utf8").trim().replace("gitdir: ", ""), "HEAD")
				: path.join(gp, "HEAD");
			const head = fs.readFileSync(headPath, "utf8").trim();
			info.branch = head.startsWith("ref: refs/heads/") ? head.slice(16) : `[${head.slice(0, 8)}]`;
			return info;
		} catch { /* 不是 git 仓库 */ }
		const parent = path.dirname(cur);
		if (parent === cur) break;
		cur = parent;
	}
	return info;
}

// ============================================================================
// 安装
// ============================================================================

/**
 * 把当前会话的编辑器替换为 BubbleEditor。
 * 返回卸载函数（退订 quota 监听；编辑器本身由调用方 setEditorComponent(undefined) 恢复）。
 */
export function installBubbleEditor(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	quota: QuotaService,
): () => void {
	const git = readGitInfo(ctx.cwd);
	let tuiRef: TUI | undefined;
	const unsubQuota = quota.onChange(() => tuiRef?.requestRender());
	// 每秒滚动 reset 倒计时显示（planUsage 字段不变，但重置时间是动态的）
	const resetTimer = setInterval(() => tuiRef?.requestRender(), 1_000);

	class BubbleEditor extends CustomEditor {
		render(width: number): string[] {
			const innerW = width - 2;
			const pad = 2;
			const editorW = Math.max(1, innerW - pad * 2);
			const lines: string[] = [];

			// 实时读取当前模型（/model 切换后下一帧即生效）
			const modelId = ctx.model?.id ?? "";
			const providerId = (ctx.model as { provider?: string } | undefined)?.provider ?? "";
			const modelReasoning = (ctx.model as { reasoning?: boolean } | undefined)?.reasoning ?? false;
			const planUsage = quota.planUsage;
			const balanceInfo = quota.balanceInfo;

			// ── 顶部边框：左边=模型+用量, 右边=工程信息 ──
			const color = PROVIDER_COLOR[providerId] ?? BLUE;
			const provIcon = ICONS.providers[providerId] ?? (ICON_MODE === "emoji" ? "🤖" : "●");
			const sep = ICONS.sep;

			// 左边：模型 + thinking + 用量
			const leftParts: string[] = [];
			if (modelId) leftParts.push(iconText(provIcon, modelId));
			// thinking 档位：仅推理模型且非 off 时显示（与 HUD 逻辑一致）
			const thinking = pi.getThinkingLevel?.() ?? "";
			if (modelReasoning && thinking && thinking !== "off") leftParts.push(thinking);
			if (planUsage?.fiveHour) {
				const w5 = planUsage.fiveHour;
				const r5 = w5.resetAt ? formatResetCountdown(w5.resetAt) : "";
				leftParts.push(`5h:${Math.round(w5.usedPercent)}%${r5 ? ` ↻${r5}` : ""}`);
			}
			if (planUsage?.weekly) {
				const w7 = planUsage.weekly;
				const r7 = w7.resetAt ? formatResetCountdown(w7.resetAt) : "";
				leftParts.push(`7d:${Math.round(w7.usedPercent)}%${r7 ? ` ↻${r7}` : ""}`);
			}
			if (planUsage?.monthly) {
				const w30 = planUsage.monthly;
				const r30 = w30.resetAt ? formatResetCountdown(w30.resetAt) : "";
				leftParts.push(`30d:${Math.round(w30.usedPercent)}%${r30 ? ` ↻${r30}` : ""}`);
			}
			if (balanceInfo) leftParts.push(iconText(ICONS.money, balanceInfo.label));
			const leftText = leftParts.join(sep);

			// 右边：工程信息
			const rightParts: string[] = [];
			if (git.branch) rightParts.push(iconText(ICONS.branch, git.branch));
			if (git.isWorktree) rightParts.push(iconText(ICONS.worktree, "wt"));
			if (git.project) rightParts.push(iconText(osIcon(), git.project));
			let rightText = rightParts.join(sep);

			// 拼顶部线：空隙全部用 ─ 填满，左中右三段均分
			let leftW = visibleWidth(leftText);
			let rightW = visibleWidth(rightText);
			// 右侧超宽先截断（至少给左侧留位）
			const maxRight = Math.max(10, innerW - leftW - 5);
			if (rightW > maxRight) {
				rightText = truncateToWidth(rightText, maxRight, "…");
				rightW = visibleWidth(rightText);
			}
			// 左侧同样要截断：模型+用量可能很长，窄终端下不截断会让中缝算出负数
			const maxLeft = Math.max(8, innerW - rightW - 6);
			const leftFinal = leftW > maxLeft ? truncateToWidth(leftText, maxLeft, "…") : leftText;
			leftW = visibleWidth(leftFinal);
			const usable = innerW - 2 - leftW - rightW - 4; // 两个角 + 4 个空格
			const leftD = Math.min(2, Math.max(0, Math.floor(usable / 3)));
			const rightD = Math.min(2, Math.max(0, Math.floor(usable / 3)));
			const midD = Math.max(0, usable - leftD - rightD);
			const topLine =
				BLUE("╭" + "─".repeat(leftD) + " ") + color(leftFinal) +
				BLUE(" " + "─".repeat(midD) + " " + rightText + " " + "─".repeat(rightD) + "╮");
			lines.push(truncateToWidth(topLine, width));

			// ── 中间：编辑器 ──
			const rawLines = super.render(editorW);
			const editorLines = rawLines.length > 2 ? rawLines.slice(1, -1) : rawLines;
			for (const line of editorLines) {
				const clipped = truncateToWidth(line, editorW);
				const padRight = Math.max(0, editorW - visibleWidth(clipped));
				lines.push(truncateToWidth(
					BLUE("│ ") + clipped + " ".repeat(padRight) + BLUE(" │"), width,
				));
			}

			// ── 底部边框 ──
			// 固定部分：╰─(2) + hint + ╯(1)，padding 补齐到 innerW，保证与顶/中行等宽
			const hint = " Esc 取消 · Enter 发送 · Ctrl+H 历史/计划 · Ctrl+Shift+J 执行计划";
			const bPad = innerW - visibleWidth("╰─") - visibleWidth(hint) - visibleWidth("╯");
			if (bPad >= 0) {
				const l = Math.floor(bPad / 2), r = bPad - l;
				lines.push(truncateToWidth(BLUE("╰─" + "─".repeat(l) + hint + "─".repeat(r) + "╯"), width));
			} else {
				lines.push(truncateToWidth(BLUE("╰" + "─".repeat(Math.max(0, innerW - 2)) + "╯"), width));
			}

			return lines;
		}
	}

	ctx.ui.setEditorComponent((tui, theme, kb) => {
		tuiRef = tui;
		return new BubbleEditor(tui, theme, kb);
	});

	return () => {
		clearInterval(resetTimer);
		unsubQuota();
	};
}
