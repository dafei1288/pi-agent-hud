/**
 * hud-footer.ts — HUD 状态栏（footer）+ 插件系统
 *
 * Line 1: [████░░] 39%  ⚡85% · ↑12.5k ↓3.2k · $0.042 · 3 turn  ⏱ 21m
 * Line 2: AGENTS.md · skills x5 · ext.tools x2 · 💰 ¥12.50 · ⏳5h 42% · ✓ Grep ×10
 * Line 3: ▸ last user input  Ctrl+H:5
 *
 * 插件：把 .js/.ts 文件放到 .pi/pi-agent-hud-plugins/ 或 ~/.pi/agent/pi-agent-hud-plugins/
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import {
	detectContextFiles,
	isEnabled,
	loadConfig,
	type HudConfig,
} from "./config.ts";
import {
	ctxColor,
	formatDuration,
	formatResetCountdown,
	formatTokens,
	formatWindowLabel,
	progressBar,
	renderGrid,
	type CellItem,
} from "./layout.ts";
import type { BalanceInfo, PlanUsageInfo, QuotaService, RateLimitInfo } from "./quota.ts";
import type { SessionState } from "./state.ts";

// ============================================================================
// 插件 API 类型
// ============================================================================

/** 传给自定义 HUD 插件的上下文数据 */
export interface HudContext {
	model: { id: string; reasoning: boolean } | undefined;
	branch: string | undefined;
	ctxPercent: number;
	projectName: string;
	totalInput: number;
	totalOutput: number;
	totalCost: number;
	skillCount: number;
	extToolCount: number;
	extCmdCount: number;
	thinking: string;
	elapsed: string;
	toolCounts: Map<string, number>;
	runningTools: Map<string, { name: string; startTime: number }>;
	runningAgents: Array<{ id: string; status: string; startTime: number }>;
	inputHistory: string[];
	lastUserInput: string;
	cwd: string;
	sessionStart: number;
	rateLimitInfo?: RateLimitInfo;
	/** 编码计划（订阅）配额：5h 和每周窗口 */
	planUsage?: PlanUsageInfo;
	/** 按量付费 LLM 账户余额 */
	balanceInfo?: BalanceInfo;
	/** 从 assistant 计划消息解析出的步骤 */
	planSteps: Array<{ text: string; done: boolean; toolName?: string }>;
	/** 已完成的 agent turn 数 */
	turnCount: number;
	/** 活跃的子代理任务（经 subagent 工具委派） */
	subagentTasks: Array<{ task: string; status: "running" | "completed"; startTime: number }>;
}

/** 向 HUD 格子贡献自定义内容的插件 */
export interface HudPlugin {
	/** 插件唯一名 */
	name: string;
	/**
	 * 渲染某个 HUD 格子的内容。
	 * 返回字符串则显示，undefined 则跳过。
	 * 每个渲染周期都会调用 —— 保持快速。
	 */
	render(ctx: HudContext, theme: HudTheme, width: number): string | undefined;
	/** 目标行："line1" | ... | "line5"。默认 "line2"。 */
	target?: "line1" | "line2" | "line3" | "line4" | "line5";
	/** 行内排序，小者靠前。默认 100。 */
	order?: number;
	/** layout 模式下的列号（0 起）。缺省自动分配。 */
	col?: number;
}

/** 传给插件的主题 API 子集 */
export interface HudTheme {
	fg(color: "text" | "dim" | "accent" | "success" | "warning" | "error", text: string): string;
}

/** 从 .pi/pi-agent-hud-plugins/ 和 ~/.pi/agent/pi-agent-hud-plugins/ 加载用户插件 */
function loadPlugins(cwd: string): HudPlugin[] {
	const plugins: HudPlugin[] = [];
	const dirs = [
		join((process.env.HOME || process.env.USERPROFILE) || "", ".pi", "agent", "pi-agent-hud-plugins"),
		join(cwd, ".pi", "pi-agent-hud-plugins"),
	];

	for (const dir of dirs) {
		if (!existsSync(dir)) continue;
		try {
			for (const file of readdirSync(dir)) {
				if (file.endsWith(".js") || file.endsWith(".ts")) {
					try {
						// eslint-disable-next-line @typescript-eslint/no-require-imports
						const mod = require(join(dir, file));
						const plugin: HudPlugin = mod.default || mod;
						if (plugin.name && typeof plugin.render === "function") {
							plugins.push(plugin);
						}
					} catch {
						// 忽略坏插件
					}
				}
			}
		} catch {
			// 忽略不可读目录
		}
	}

	return plugins;
}

/** target 字符串 → 0 起行号 */
function targetToLine(target: string | undefined): number {
	switch (target ?? "line2") {
		case "line1": return 0;
		case "line2": return 1;
		case "line3": return 2;
		case "line4": return 3;
		case "line5": return 4;
		default: return 1;
	}
}

// ============================================================================
// Footer 创建
// ============================================================================

export function createHudFooter(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: SessionState,
	quota: QuotaService,
): void {
	let cachedCwd = "";
	let cachedContextFiles: string[] = [];
	let config: HudConfig = {};
	let plugins: HudPlugin[] = [];

	function refreshContextFiles(cwd: string) {
		if (cwd !== cachedCwd) {
			cachedCwd = cwd;
			cachedContextFiles = detectContextFiles(cwd);
			config = loadConfig(cwd);
			plugins = loadPlugins(cwd);
		}
	}

	refreshContextFiles(ctx.cwd);

	ctx.ui.setFooter((tui, theme, footerData) => {
		const unsubBranch = footerData.onBranchChange(() => tui.requestRender());
		const timer = setInterval(() => tui.requestRender(), 30_000);
		const unsubQuota = quota.onChange(() => tui.requestRender());

		const hudTheme: HudTheme = {
			fg: (color, text) => theme.fg(color, text),
		};

		return {
			dispose() {
				unsubBranch();
				clearInterval(timer);
				unsubQuota();
			},
			invalidate() {},
			render(width: number): string[] {
				refreshContextFiles(ctx.cwd);

				// ---- 数据收集 ----
				const model = ctx.model;
				const modelId = model?.id || "no-model";
				const branch = footerData.getGitBranch();

				// provider 切换（如 /model）：quota 服务内部丢弃过期配额/余额
				const provider = (model as { provider?: string } | undefined)?.provider;
				quota.setProvider(provider);
				quota.maybePoll();

				const rateLimitInfo = quota.rateLimitInfo;
				const planUsage = quota.planUsage;
				const balanceInfo = quota.balanceInfo;

				const ctxUsage = ctx.getContextUsage();
				const ctxPercent = ctxUsage?.percent ?? 0;

				const cwd = ctx.sessionManager.getCwd();
				const projectName = cwd.split(/[/\\]/).pop() || cwd;

				let totalInput = 0;
				let totalOutput = 0;
				let totalCost = 0;
				for (const e of ctx.sessionManager.getEntries()) {
					if (e.type === "message" && e.message.role === "assistant") {
						const m = e.message as AssistantMessage;
						totalInput += m.usage.input;
						totalOutput += m.usage.output;
						totalCost += m.usage.cost.total;
					}
				}

				const allTools = pi.getAllTools();
				const commands = pi.getCommands();
				const builtinToolNames = new Set(["bash", "read", "edit", "write", "grep", "find", "ls"]);
				const extTools = allTools.filter((t) => !builtinToolNames.has(t.name));
				const skillCmds = commands.filter((c) => c.source === "skill");
				const extCmds = commands.filter((c) => c.source === "extension");
				const thinking = pi.getThinkingLevel();

				const elapsed = formatDuration(Date.now() - state.sessionStart);

				const toolCounts = state.toolCounts;
				const runningTools = state.runningTools;
				const agentEntries = state.agentEntries;
				const inputHistory = state.inputHistory;
				const lastUserInput = state.lastUserInput;
				const planSteps = state.planSteps;
				const turnCount = state.turnCount;
				const subagentTasks = state.subagentTasks;

				const hudCtx: HudContext = {
					model: model ? { id: modelId, reasoning: model.reasoning } : undefined,
					branch: branch ?? undefined,
					ctxPercent,
					projectName,
					totalInput,
					totalOutput,
					totalCost,
					skillCount: skillCmds.length,
					extToolCount: extTools.length,
					extCmdCount: extCmds.length,
					thinking,
					elapsed,
					toolCounts,
					runningTools,
					runningAgents: agentEntries,
					inputHistory,
					lastUserInput,
					cwd,
					sessionStart: state.sessionStart,
					planSteps,
					turnCount,
					subagentTasks,
					planUsage,
					balanceInfo,
				};

				// ================================================================
				// 构建所有可渲染项
				// ================================================================
				const sep = theme.fg("dim", "│");

				// --- Line 1: 上下文 bar（最左）+ tokens/费用/rateLimit（中间）+ 耗时（最右） ---
				const line1Parts: string[] = [];
				if (isEnabled(config, "rateLimit") && rateLimitInfo) {
					const rl = rateLimitInfo;
					const tokenPct = rl.tokenLimit > 0 ? Math.round((rl.tokenRemaining / rl.tokenLimit) * 100) : -1;
					const reqPct = rl.requestLimit > 0 ? Math.round((rl.requestRemaining / rl.requestLimit) * 100) : -1;
					const worstPct = tokenPct >= 0 && reqPct >= 0 ? Math.min(tokenPct, reqPct) : Math.max(tokenPct, reqPct);
					if (worstPct >= 0) {
						const pctStr = worstPct >= 100 ? "∞" : `${worstPct}%`;
						const icon = worstPct > 50 ? "⚡" : worstPct > 20 ? "⚡" : "🪫";
						const color: "success" | "warning" | "error" = worstPct > 50 ? "success" : worstPct > 20 ? "warning" : "error";
						const detail = rl.tokenLimit > 0 ? `${formatTokens(rl.tokenRemaining)}/${formatTokens(rl.tokenLimit)}` : "";
						const ageMs = Date.now() - rl.capturedAt;
						const ageStr = ageMs < 60_000 ? `${Math.round(ageMs / 1000)}s ago` : ageMs < 3_600_000 ? `${Math.round(ageMs / 60_000)}m ago` : `${Math.round(ageMs / 3_600_000)}h ago`;
						line1Parts.push(`${theme.fg(color, `${icon} ${pctStr}`)}${detail ? theme.fg("dim", ` ${detail}`) : ""}${theme.fg("dim", ` ${ageStr}`)}`);
					}
				}
				// tokens & cost 在 Line 1 中间的右侧信息区
				if (isEnabled(config, "tokens") && totalInput > 0) {
					const threshold = config.tokenThreshold ?? 85;
					const showTokens = config.tokenMode === "always" || ctxPercent >= threshold;
					if (showTokens) line1Parts.push(theme.fg("dim", `↑${formatTokens(totalInput)} ↓${formatTokens(totalOutput)}`));
				}
				if (isEnabled(config, "cost") && totalCost > 0) {
					line1Parts.push(theme.fg("dim", `$${totalCost.toFixed(3)}`));
				}
				if (isEnabled(config, "agentPlan") && turnCount > 0) {
					line1Parts.push(theme.fg("dim", `${turnCount} turn`));
				}
				// 计划步骤 / 子代理信息
				if (isEnabled(config, "agentPlan") && (planSteps.length > 0 || subagentTasks.length > 0)) {
					const doneCount = planSteps.filter((s) => s.done).length;
					const runningSA = subagentTasks.filter((s) => s.status === "running").length;
					if (planSteps.length > 0) {
						let s = `📋 ${doneCount}/${planSteps.length}`;
						if (runningSA > 0) s += ` ⚡${runningSA}`;
						line1Parts.push(theme.fg("accent", s));
					} else if (runningSA > 0) {
						line1Parts.push(theme.fg("warning", `⚡ ${runningSA} agent`));
					}
				}
				const line1Middle = line1Parts.join(theme.fg("dim", " · "));

				let ctxBar = "";
				let ctxBarLen = 0; // 字符数（非 visibleWidth，避免 █ 被当宽字符）
				// 提前算好中间段宽（rateLimit + tokens + cost + turn）
				const mid = line1Middle ? ` ${line1Middle} ` : "";
				const midW = visibleWidth(mid);
				if (isEnabled(config, "contextBar")) {
					const line1RightStr = isEnabled(config, "elapsed") ? theme.fg("dim", `⏱ ${elapsed}`) : "";
					const rightW = visibleWidth(line1RightStr);
					// bar 从 col 0 开始，只用考虑中段+耗时占宽
					const barAvail = width - midW - rightW;
					if (barAvail > 8 && ctxPercent != null) {
						const pctStr = `${Math.round(ctxPercent)}%`;
						const barW = Math.min(Math.max(2, barAvail - 3 - pctStr.length), 30);
						const barText = `${progressBar(ctxPercent, barW)} ${pctStr}`;
						ctxBar = ctxColor(theme, ctxPercent, barText);
						ctxBarLen = barText.length;
					} else if (ctxPercent != null) {
						const pctStr = `${Math.round(ctxPercent)}%`;
						ctxBar = ctxColor(theme, ctxPercent, pctStr);
						ctxBarLen = pctStr.length;
					} else {
						ctxBar = theme.fg("dim", "?%");
						ctxBarLen = 2;
					}
				}
				const line1Right = isEnabled(config, "elapsed") ? theme.fg("dim", `⏱ ${elapsed}`) : "";

				// Line 1: bar(最左) | 中间(rateLimit/tokens/费用) | 耗时(最右)
				const line1Items: CellItem[] = [{
					key: "_line1_main",
					defaultLine: 0,
					order: 0,
					fixedCol: config.placement?._line1_main?.col,
					render: () => {
						const rightW = visibleWidth(line1Right);
						const fill = width - ctxBarLen - rightW; // ctxBar + (填充+mid) + right = width
						if (fill >= midW + 2) {
							return ctxBar + " ".repeat(fill - midW) + mid + line1Right;
						}
						return truncateToWidth(ctxBar + "  " + line1Middle + "  " + line1Right, width);
					},
				}];

				// --- Line 2 元素 ---
				const line2Items: CellItem[] = [];

				if (isEnabled(config, "contextFiles")) {
					for (const f of cachedContextFiles) {
						line2Items.push({
							key: `ctxFile:${f}`,
							defaultLine: 1, order: 0,
							fixedCol: config.placement?.[`ctxFile:${f}`]?.col,
							render: () => theme.fg("success", f),
						});
					}
				}
				if (isEnabled(config, "skills") && skillCmds.length > 0) {
					line2Items.push({
						key: "skills", defaultLine: 1, order: 1,
						fixedCol: config.placement?.skills?.col,
						render: () => theme.fg("dim", `skills x${skillCmds.length}`),
					});
				}
				if (isEnabled(config, "extTools") && extTools.length > 0) {
					line2Items.push({
						key: "extTools", defaultLine: 1, order: 2,
						fixedCol: config.placement?.extTools?.col,
						render: () => theme.fg("dim", `ext.tools x${extTools.length}`),
					});
				}
				if (isEnabled(config, "extCmds") && extCmds.length > 0) {
					line2Items.push({
						key: "extCmds", defaultLine: 1, order: 3,
						fixedCol: config.placement?.extCmds?.col,
						render: () => theme.fg("dim", `cmds x${extCmds.length}`),
					});
				}
				if (isEnabled(config, "balance") && balanceInfo) {
					const ageMs = Date.now() - balanceInfo.capturedAt;
					const fresh = ageMs < 10 * 60_000; // <10min 算新鲜
					const color: "success" | "warning" | "dim" = !fresh ? "dim"
						: balanceInfo.value <= 0 ? "warning"
						: balanceInfo.value < 10 ? "warning"
						: "success";
					line2Items.push({
						key: "balance", defaultLine: 1, order: 6,
						fixedCol: config.placement?.balance?.col,
						render: () => theme.fg(color, `💰 ${balanceInfo.label}`),
					});
				}

				if (isEnabled(config, "plan5h") && planUsage?.fiveHour) {
					const w = planUsage.fiveHour;
					const label = w.windowMinutes ? formatWindowLabel(w.windowMinutes) : "5h";
					line2Items.push({
						key: "plan5h", defaultLine: 1, order: 7,
						fixedCol: config.placement?.plan5h?.col,
						render: () => {
							const reset = w.resetAt ? formatResetCountdown(w.resetAt) : "";
							return `${ctxColor(theme, w.usedPercent, `⏳${label} ${Math.round(w.usedPercent)}%`)}${reset ? theme.fg("dim", ` ↻${reset}`) : ""}`;
						},
					});
				}
				if (isEnabled(config, "planWeek") && planUsage?.weekly) {
					const w = planUsage.weekly;
					const label = w.windowMinutes ? formatWindowLabel(w.windowMinutes) : "wk";
					line2Items.push({
						key: "planWeek", defaultLine: 1, order: 8,
						fixedCol: config.placement?.planWeek?.col,
						render: () => {
							const reset = w.resetAt ? formatResetCountdown(w.resetAt) : "";
							return `${ctxColor(theme, w.usedPercent, `📅${label} ${Math.round(w.usedPercent)}%`)}${reset ? theme.fg("dim", ` ↻${reset}`) : ""}`;
						},
					});
				}
				if (isEnabled(config, "plan30d") && planUsage?.monthly) {
					const w = planUsage.monthly;
					const label = w.windowMinutes ? formatWindowLabel(w.windowMinutes) : "wk";
					line2Items.push({
						key: "plan30d", defaultLine: 1, order: 9,
						fixedCol: config.placement?.planWeek?.col,
						render: () => {
							const reset = w.resetAt ? formatResetCountdown(w.resetAt) : "";
							return `${ctxColor(theme, w.usedPercent, `🗓️${label} ${Math.round(w.usedPercent)}%`)}${reset ? theme.fg("dim", ` ↻${reset}`) : ""}`;
						},
					});
				}

				if (isEnabled(config, "toolStats")) {
					const sortedTools = Array.from(toolCounts.entries()).sort(([, a], [, b]) => b - a);
					for (const [name, count] of sortedTools) {
						line2Items.push({
							key: `tool:${name}`, defaultLine: 1, order: 10,
							fixedCol: config.placement?.[`tool:${name}`]?.col,
							render: () => `${theme.fg("success", "✓")} ${theme.fg("dim", `${name} ×${count}`)}`,
						});
					}
				}
				if (isEnabled(config, "runningTools")) {
					for (const tool of Array.from(runningTools.values())) {
						line2Items.push({
							key: `running:${tool.name}`, defaultLine: 1, order: 20,
							fixedCol: config.placement?.[`running:${tool.name}`]?.col,
							render: () => `${theme.fg("warning", "◐")} ${theme.fg("text", `${tool.name} (${formatDuration(Date.now() - tool.startTime)})`)}`,
						});
					}
				}
				if (isEnabled(config, "runningAgents")) {
					const running = agentEntries.filter((a) => a.status === "running");
					for (const agent of running.slice(-2)) {
						line2Items.push({
							key: "runningAgent", defaultLine: 1, order: 21,
							fixedCol: config.placement?.runningAgent?.col,
							render: () => `${theme.fg("warning", "◐")} ${theme.fg("accent", `agent (${formatDuration(Date.now() - agent.startTime)})`)}`,
						});
					}
				}

				// --- Line 3 元素 ---
				const line3Items: CellItem[] = [];
				if (isEnabled(config, "lastInput") && lastUserInput) {
					line3Items.push({
						key: "lastInput", defaultLine: 2, order: 0,
						fixedCol: config.placement?.lastInput?.col,
						render: () => {
							const truncated = lastUserInput.length > 200 ? lastUserInput.slice(0, 197) + "..." : lastUserInput;
							const display = truncated.replace(/\n/g, " ").replace(/\s+/g, " ").trim();
							const parts = [theme.fg("accent", "▸"), theme.fg("dim", display)];
							if (isEnabled(config, "historyHint") && inputHistory.length > 1) {
								parts.push(theme.fg("dim", `Ctrl+H:${inputHistory.length}`));
							}
							return parts.join(" ");
						},
					});
				}

				// --- 插件项 ---
				const pluginItems: CellItem[] = plugins
					.sort((a, b) => (a.order ?? 100) - (b.order ?? 100))
					.map((p) => ({
						key: `plugin:${p.name}`,
						defaultLine: targetToLine(p.target),
						order: p.order ?? 100,
						fixedCol: p.col ?? config.placement?.[`plugin:${p.name}`]?.col,
						render: () => p.render(hudCtx, hudTheme, width),
					}));

				const allItems = [...line1Items, ...line2Items, ...line3Items, ...pluginItems];

				// ================================================================
				// 布局分支
				// ================================================================
				const layout = config.layout;

				if (layout && layout.length > 0) {
					// === 网格布局模式 ===
					return renderGrid(layout, allItems, width, sep);
				}

				// === 经典单列模式（默认） ===

				// Line 1
				const l1Content = line1Items[0]?.render();
				const pluginLine1 = pluginItems
					.filter((p) => p.defaultLine === 0)
					.sort((a, b) => a.order - b.order)
					.map((p) => p.render())
					.filter((s): s is string => s != null);
				let line1 = l1Content || "";
				if (pluginLine1.length > 0) line1 += " " + pluginLine1.join(" ");
				line1 = truncateToWidth(line1, width);

				// Line 2
				const l2Parts = line2Items
					.sort((a, b) => a.order - b.order)
					.map((item) => item.render())
					.filter((s): s is string => s != null);
				const pluginLine2 = pluginItems
					.filter((p) => p.defaultLine === 1)
					.sort((a, b) => a.order - b.order)
					.map((p) => p.render())
					.filter((s): s is string => s != null);
				l2Parts.push(...pluginLine2);
				const line2 = truncateToWidth(
					l2Parts.join(theme.fg("dim", " · ")),
					width,
					theme.fg("dim", "..."),
				);

				// Line 3
				let line3 = "";
				if (lastUserInput && isEnabled(config, "lastInput")) {
					const inputParts = line3Items
						.sort((a, b) => a.order - b.order)
						.map((item) => item.render())
						.filter((s): s is string => s != null);
					const pluginLine3 = pluginItems
						.filter((p) => p.defaultLine === 2)
						.sort((a, b) => a.order - b.order)
						.map((p) => p.render())
						.filter((s): s is string => s != null);
					inputParts.push(...pluginLine3);
					if (inputParts.length > 0) {
						if (line3) line3 += " ";
						line3 += inputParts.join(" ");
					}
				}

				if (line3) {
					line3 = truncateToWidth(line3, width, theme.fg("dim", "…"));
				}

				return line3 ? [line1, line2, line3] : [line1, line2];
			},
		};
	});
}
