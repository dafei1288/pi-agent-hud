/**
 * config.ts — 扩展配置：类型定义、加载、元素开关、上下文文件探测
 *
 * 配置文件：.pi/pi-agent-hud.json（项目）+ ~/.pi/agent/pi-agent-hud.json（全局）
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// ============================================================================
// 类型
// ============================================================================

/** 可开关的 HUD 显示元素 */
export type HudElement =
	| "model"          // Line 1: [model-name]
	| "project"        // Line 1: project directory name
	| "git"            // Line 1: git:(branch)
	| "thinking"       // Line 1: · medium
	| "contextBar"     // Line 1: [████░░] 39%
	| "elapsed"        // Line 1: ⏱ 21m
	| "contextFiles"   // Line 2: AGENTS.md
	| "skills"         // Line 2: skills x5
	| "extTools"       // Line 2: ext.tools x2
	| "extCmds"        // Line 2: cmds x3
	| "tokens"         // Line 2: ↑12.5k ↓3.2k
	| "cost"           // Line 2: $0.042
	| "balance"        // Line 2: 💰 ¥12.50 (LLM account balance)
	| "rateLimit"      // Line 2: ⚡ 85% (Anthropic/OpenAI rate limit)
	| "plan5h"         // Line 2: ⏳5h 42% ↻2h15m (coding plan 5-hour window)
	| "planWeek"       // Line 2: 📅wk 18% ↻3d (coding plan weekly window)
	| "plan30d"        // Line 2: 🗓️30d 26% ↻26d (coding plan monthly window, e.g. opencode Zen)
	| "toolStats"      // Line 2: ✓ Grep ×10
	| "runningTools"   // Line 2: ◐ Edit (12s)
	| "runningAgents"  // Line 2: ◐ agent (2m 15s)
	| "agentPlan"     // Line 2: 📋 3/5 steps · 2 subagents
	| "lastInput"      // Line 3: ▸ last user input
	| "historyHint"    // Line 3: Ctrl+H:5
	| "shortcutHints"; // widget below editor: Enter 发送 · Ctrl+H 历史/计划 · Ctrl+Shift+J 执行计划

/** 把元素钉到网格的某个格子 */
export interface Placement {
	/** 0 起行号 (0-4) */
	line: number;
	/** 0 起列号 */
	col: number;
}

/** pi-agent-hud 用户配置 */
export interface HudConfig {
	/** 要显示的元素。默认全部。 */
	enabled?: HudElement[];
	/** 要隐藏的元素。优先于 enabled。 */
	disabled?: HudElement[];
	/** Token 显示模式: "always" | "highContext" (85%+)。默认 "always"。 */
	tokenMode?: "always" | "highContext";
	/** tokenMode 为 "highContext" 时的阈值。默认 85。 */
	tokenThreshold?: number;
	/**
	 * 布局：每行的列数数组。最多 5 行，每行 1/2/4 列。
	 * undefined = 经典单列模式（默认行为）。
	 * 例：[1, 2, 2] 表示 Line1=整行, Line2=2列, Line3=2列。
	 */
	layout?: [number, ...number[]];
	/**
	 * 把元素钉到指定格子。仅 layout 设置后生效。
	 * Key = 元素 id 或插件名，value = { line, col }。
	 * 未列出的元素按从左到右、从上到下自动分配。
	 */
	placement?: Record<string, Placement>;
	/**
	 * 把 rate-limit 相关响应头 dump 到
	 * ~/.pi/agent/pi-agent-hud-headers.jsonl 用于发现新字段。
	 * 也可用环境变量 PI_HUD_DEBUG_HEADERS=1 开启。默认 false。
	 */
	debugDumpHeaders?: boolean;
	/**
	 * 输入框组件："bubble" = 气泡编辑器（带边框/图标/工程信息），
	 * "default" = pi 默认编辑器。默认 "default"。
	 * 运行时可用 /bubble 命令切换。
	 */
	editor?: "bubble" | "default";
}

// ============================================================================
// 加载与查询
// ============================================================================

/** 加载并合并配置：~/.pi/agent/pi-agent-hud.json（全局）→ .pi/pi-agent-hud.json（项目） */
export function loadConfig(cwd: string): HudConfig {
	const result: HudConfig = {
		tokenMode: "always",
		tokenThreshold: 85,
	};

	const paths = [
		join((process.env.HOME || process.env.USERPROFILE) || "", ".pi", "agent", "pi-agent-hud.json"),
		join(cwd, ".pi", "pi-agent-hud.json"),
	];

	for (const p of paths) {
		if (existsSync(p)) {
			try {
				const merged = { ...result, ...JSON.parse(readFileSync(p, "utf-8")) };
				Object.assign(result, merged);
			} catch {
				// 忽略坏配置
			}
		}
	}

	return result;
}

/** 元素是否启用：disabled 优先，其次 enabled 白名单 */
export function isEnabled(config: HudConfig, el: HudElement): boolean {
	if (config.disabled?.includes(el)) return false;
	if (config.enabled && config.enabled.length > 0) {
		return config.enabled.includes(el);
	}
	return true;
}

/** 探测全局 + 项目目录链上的 AGENTS.md / CLAUDE.md */
export function detectContextFiles(cwd: string): string[] {
	const found: string[] = [];
	const candidates = ["AGENTS.md", "CLAUDE.md"];
	const seen = new Set<string>();

	const home = process.env.HOME || process.env.USERPROFILE;
	if (home) {
		for (const name of candidates) {
			if (existsSync(join(home, ".pi", "agent", name))) {
				found.push(`~/.pi/agent/${name}`);
				seen.add(name);
			}
		}
	}

	let dir = cwd;
	for (let i = 0; i < 20; i++) {
		for (const name of candidates) {
			if (seen.has(name)) continue;
			if (existsSync(join(dir, name))) {
				found.push(dir === cwd ? name : `${dir.split(/[/\\]/).pop()}/${name}`);
				seen.add(name);
			}
		}
		const parent = join(dir, "..");
		if (parent === dir) break;
		dir = parent;
	}
	return found;
}
