/**
 * quota.ts — LLM 计费/额度共享服务
 *
 * 唯一数据源（single source of truth）：
 *  - 编码计划（订阅）配额：5h / 每周窗口（GLM / MiniMax / Kimi / Codex / Claude）
 *  - 按量付费余额（DeepSeek 等）
 *  - Provider 响应头里的 rate limit（Anthropic / OpenAI）
 *
 * hud-footer 和 bubble-editor 都只读取本服务，不各自发请求。
 *
 * 新增一个 provider = 在 PLAN_PROVIDERS / BALANCE_PROVIDERS 加一条声明式记录。
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// 类型
// ============================================================================

/** 从 provider 响应头解析出的 rate limit 信息 */
export interface RateLimitInfo {
	provider: string;
	tokenRemaining: number;
	tokenLimit: number;
	requestRemaining: number;
	requestLimit: number;
	tokenResetAt?: number;
	requestResetAt?: number;
	capturedAt: number;
}

/** 一个编码计划配额窗口（如 5 小时或每周）的使用情况 */
export interface PlanWindowUsage {
	/** 已用百分比 0-100 */
	usedPercent: number;
	/** 窗口长度（分钟），服务器报告时才有 */
	windowMinutes?: number;
	/** 窗口重置时间（Unix ms），服务器报告时才有 */
	resetAt?: number;
}

/** 编码计划（订阅）配额使用，解析自响应头或轮询接口 */
export interface PlanUsageInfo {
	/** 来源："codex" | "anthropic" | provider id */
	source: string;
	fiveHour?: PlanWindowUsage;
	weekly?: PlanWindowUsage;
	/** 月度窗口（如 opencode Zen 30d），仅部分订阅有 */
	monthly?: PlanWindowUsage;
	capturedAt: number;
}

/** 按量付费 API 账户余额 */
export interface BalanceInfo {
	provider: string;
	/** 展示标签（如 "¥12.50"） */
	label: string;
	/** 原始数值，用于颜色阈值 */
	value: number;
	currency: string;
	capturedAt: number;
}

/** 编码计划配额 provider 的声明式描述 */
export interface PlanProviderSpec {
	/** pi provider id(s)（ctx.model.provider） */
	providers: string[];
	/** 依次尝试的环境变量 */
	envKeys: string[];
	/** 环境变量之后在 ~/.pi/agent/auth.json 里尝试的名字 */
	authNames: string[];
	/**
	 * 最后在 ~/.pi/agent/models.json 的 providers.{id}.apiKey 里尝试。
	 * Kimi 这类把 key 存在 models.json 的 provider 需要。
	 */
	modelsJsonProvider?: string;
	url: string;
	/** 备用站点（CN/国际双站）：主站 401/403 或 AuthRejectedError 时依次尝试 */
	fallbackUrls?: string[];
	headers: (key: string) => Record<string, string>;
	/** 归一化响应 JSON → 窗口；undefined = 无可用数据。抛 AuthRejectedError 表示 key 不属于该站点 */
	parse: (json: any, url: string) => { fiveHour?: PlanWindowUsage; weekly?: PlanWindowUsage; monthly?: PlanWindowUsage } | undefined;
}

/** 余额 provider 的声明式描述 */
export interface BalanceProviderSpec {
	providers: string[];
	envKeys: string[];
	authNames: string[];
	modelsJsonProvider?: string;
	url: string;
	/** 备用站点（CN/国际双站）：主站 401/403 或 AuthRejectedError 时依次尝试 */
	fallbackUrls?: string[];
	headers: (key: string) => Record<string, string>;
	/** 归一化响应 JSON → BalanceInfo；undefined = 无可用数据。抛 AuthRejectedError 表示 key 不属于该站点 */
	parse: (json: any, url: string) => BalanceInfo | undefined;
}

/** parse 抛出该错误 = 该站点的 key 无效，尝试下一个站点（HTTP 200 + 业务层拒绝的接口用） */
export class AuthRejectedError extends Error {}

// ============================================================================
// 响应头解析辅助
// ============================================================================

/** 解析 reset 头：epoch 秒/毫秒或 ISO 日期串 → Unix ms */
export function parseResetHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (Number.isFinite(n) && n > 0) {
		return n < 1e12 ? n * 1000 : n; // epoch 秒 vs 毫秒
	}
	const t = Date.parse(value);
	return Number.isNaN(t) ? undefined : t;
}

/** 解析 utilization 头：小数 (0-1) 或百分数 (0-100) → 百分数 */
export function parseUtilizationHeader(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0) return undefined;
	return n <= 1 ? n * 100 : n;
}

/** 大小写不敏感的头查找 */
export function getHeader(headers: Record<string, string>, name: string): string | undefined {
	if (headers[name] !== undefined) return headers[name];
	const lower = name.toLowerCase();
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === lower) return headers[key];
	}
	return undefined;
}

// ============================================================================
// API key 解析：env → auth.json → models.json
// ============================================================================

function resolveKey(spec: { envKeys: string[]; authNames: string[]; modelsJsonProvider?: string }): string | undefined {
	for (const env of spec.envKeys) {
		if (process.env[env]) return process.env[env];
	}
	try {
		const auth = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "auth.json"), "utf8"));
		for (const name of spec.authNames) {
			const entry = auth[name];
			if (entry?.type === "api_key" && entry.key) return entry.key;
		}
	} catch { /* ignore */ }
	if (spec.modelsJsonProvider) {
		try {
			const models = JSON.parse(readFileSync(join(homedir(), ".pi", "agent", "models.json"), "utf8"));
			let key = models?.providers?.[spec.modelsJsonProvider]?.apiKey;
			// models.json 里 "apiKey": "$STEPFUN_API_KEY" 这类环境变量引用需要展开
			if (typeof key === "string" && key.startsWith("$") && process.env[key.slice(1)]) {
				key = process.env[key.slice(1)];
			}
			if (typeof key === "string" && key && !key.startsWith("$")) return key;
		} catch { /* ignore */ }
	}
	return undefined;
}

// ============================================================================
// 编码计划配额 provider 注册表
// ============================================================================

/** GLM Coding Plan 配额响应解析：window 条目 unit 3 = 小时窗口、unit 6 = 天窗口。key 失效时返回 HTTP 200 + success:false，抛 AuthRejectedError。 */
function parseZaiQuota(json: any): { fiveHour?: PlanWindowUsage; weekly?: PlanWindowUsage } | undefined {
	if (json?.success === false) throw new AuthRejectedError("zai: success:false");
	const limits = json?.data?.limits;
	if (!Array.isArray(limits)) return undefined;
	let fiveHour: PlanWindowUsage | undefined;
	let weekly: PlanWindowUsage | undefined;
	for (const l of limits) {
		// 接口已把 type 从 TOKENS_LIMIT 改为 CREDIT_LIMIT（2026-10 观察），两者都接受
		if (l?.type !== "TOKENS_LIMIT" && l?.type !== "CREDIT_LIMIT") continue;
		const w: PlanWindowUsage = {
			usedPercent: typeof l.percentage === "number" ? Math.max(0, Math.min(100, l.percentage)) : 0,
			resetAt: typeof l.nextResetTime === "number" ? l.nextResetTime : undefined,
		};
		if (l.unit === 3) {
			fiveHour = { ...w, windowMinutes: (l.number || 5) * 60 };
		} else if (l.unit === 6) {
			// unit 6 的 number 是天数（如 7 = 每周），直接换算分钟，不再多乘一个 7
			weekly = { ...w, windowMinutes: (l.number || 7) * 24 * 60 };
		}
	}
	return fiveHour || weekly ? { fiveHour, weekly } : undefined;
}

export const PLAN_PROVIDERS: PlanProviderSpec[] = [
	{
		// GLM Coding Plan (z.ai 国内版): GET /api/monitor/usage/quota/limit
		// TOKENS_LIMIT entries: unit 3 = hour-window (number = hours, e.g. 5h), unit 6 = day-window (number = days, e.g. 7d)
		providers: ["zai-coding-cn"],
		envKeys: ["ZAI_CODING_CN_API_KEY"],
		authNames: ["zai-coding-cn"],
		url: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: parseZaiQuota,
	},
	{
		// MiniMax Coding Plan: GET /v1/api/openplatform/coding_plan/remains
		// 用 "general" 模型条目：current_interval = 5h 窗口，current_weekly = 每周窗口。
		// 百分比是【剩余】，转换为已用。
		providers: ["minimax", "minimax-cn"],
		envKeys: ["MINIMAX_API_KEY", "MINIMAX_CN_API_KEY"],
		authNames: ["minimax", "minimax-cn"],
		url: "https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const general = json?.model_remains?.find((m: any) => m?.model_name === "general") ?? json?.model_remains?.[0];
			if (!general) return undefined;
			const fiveHour: PlanWindowUsage | undefined = typeof general.current_interval_remaining_percent === "number" ? {
				usedPercent: 100 - general.current_interval_remaining_percent,
				windowMinutes: 300,
				resetAt: typeof general.end_time === "number" ? general.end_time : undefined,
			} : undefined;
			const weekly: PlanWindowUsage | undefined = typeof general.current_weekly_remaining_percent === "number" ? {
				usedPercent: 100 - general.current_weekly_remaining_percent,
				windowMinutes: 7 * 24 * 60,
				resetAt: typeof general.weekly_end_time === "number" ? general.weekly_end_time : undefined,
			} : undefined;
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
	{
		// Kimi Coding Plan: GET /coding/v1/usages
		// 顶层 `usage` = 每周汇总；limits[] 携带各窗口明细，
		// window.duration+timeUnit 标识窗口（300 MINUTES = 5h）。
		// 数值字段可能是字符串；resetTime 是 ISO8601。
		providers: ["kimi"],
		envKeys: ["KIMI_CODE_API_KEY", "KIMI_API_KEY"],
		authNames: ["kimi"],
		modelsJsonProvider: "kimi",
		url: "https://api.kimi.com/coding/v1/usages",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const row = (d: any): PlanWindowUsage | undefined => {
				if (!d || typeof d !== "object") return undefined;
				const num = (v: any): number | undefined => {
					const n = Number(v);
					return !Number.isNaN(n) ? n : undefined;
				};
				const limit = num(d.limit);
				const used = num(d.used)
					?? (limit != null ? (() => { const r = num(d.remaining); return r != null ? Math.max(0, limit - r) : undefined; })() : undefined);
				if (used == null && limit == null) return undefined;
				const resetRaw = d.reset_at ?? d.resetAt ?? d.reset_time ?? d.resetTime;
				const resetAt = typeof resetRaw === "string" ? (Date.parse(resetRaw) || undefined)
					: typeof resetRaw === "number" ? (Number.isFinite(resetRaw) ? resetRaw : undefined) : undefined;
				const usedPercent = limit && limit > 0 ? ((used ?? 0) / limit) * 100 : 0;
				return { usedPercent, resetAt };
			};
			const toMinutes = (dur?: number, unit?: string): number | undefined => {
				if (typeof dur !== "number") return undefined;
				const u = (unit || "").toUpperCase();
				if (u.includes("DAY")) return dur * 1440;
				if (u.includes("HOUR")) return dur * 60;
				return dur; // MINUTES（默认）
			};
			let fiveHour: PlanWindowUsage | undefined;
			let weekly: PlanWindowUsage | undefined;
			const topUsage = row(json?.usage);
			if (topUsage) weekly = { ...topUsage, windowMinutes: 7 * 24 * 60 };
			if (Array.isArray(json?.limits)) {
				for (const item of json.limits) {
					const w = row(item?.detail ?? item);
					if (!w) continue;
					const mins = toMinutes(item?.window?.duration ?? item?.duration, item?.window?.timeUnit ?? item?.timeUnit);
					if (mins && mins <= 24 * 60) {
						fiveHour ??= { ...w, windowMinutes: mins };
					} else {
						weekly ??= { ...w, windowMinutes: mins ?? 7 * 24 * 60 };
					}
				}
			}
			return fiveHour || weekly ? { fiveHour, weekly } : undefined;
		},
	},
	{
		// opencode Zen 订阅: GET /zen/go/v1/usage
		// usage.rolling = 5h 窗口，weekly = 7d，monthly = 30d；百分比钳制 0-100。
		providers: ["opencode-go", "opencode"],
		envKeys: ["OPENCODE_API_KEY"],
		authNames: ["opencode-go", "opencode"],
		url: "https://opencode.ai/zen/go/v1/usage",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const usage = json?.usage;
			if (!usage) return undefined;
			const clamp = (v: any): number | undefined =>
				typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.min(100, v)) : undefined;
			const win = (w: any, minutes?: number): PlanWindowUsage | undefined => {
				const usedPercent = clamp(w?.percent);
				if (usedPercent === undefined) return undefined;
				const resetAt = typeof w?.resetsAt === "string" ? (Date.parse(w.resetsAt) || undefined) : undefined;
				return { usedPercent, windowMinutes: minutes, resetAt };
			};
			const fiveHour = win(usage.rolling, 5 * 60);
			const weekly = win(usage.weekly, 7 * 24 * 60);
			const monthly = win(usage.monthly, 30 * 24 * 60);
			return fiveHour || weekly || monthly ? { fiveHour, weekly, monthly } : undefined;
		},
	},
	{
		// GLM Coding Plan 国际版（Z.ai）: 与国内版同构，站点为 api.z.ai。
		// 该接口的 Authorization 直接携带 key，不带 Bearer 前缀。
		providers: ["zai-coding-plan", "zai"],
		envKeys: ["ZAI_API_KEY", "ZHIPU_API_KEY"],
		authNames: ["zai-coding-plan", "zai"],
		url: "https://api.z.ai/api/monitor/usage/quota/limit",
		headers: (key) => ({ Authorization: key }),
		parse: parseZaiQuota,
	},
];

// ============================================================================
// 余额 provider 注册表（按量付费 API 账户）
// ============================================================================

export const BALANCE_PROVIDERS: BalanceProviderSpec[] = [
	{
		// DeepSeek: GET /user/balance
		// Returns { is_available, balance_infos: [{ currency, total_balance, ... }] }
		providers: ["deepseek"],
		envKeys: ["DEEPSEEK_API_KEY"],
		authNames: ["deepseek"],
		url: "https://api.deepseek.com/user/balance",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			if (!json?.is_available) return undefined;
			const info = json?.balance_infos?.[0];
			if (!info) return undefined;
			const total = parseFloat(info.total_balance);
			if (isNaN(total)) return undefined;
			const currency = info.currency === "CNY" ? "¥" : info.currency === "USD" ? "$" : info.currency;
			return {
				provider: "deepseek",
				label: `${currency}${total.toFixed(2)}`,
				value: total,
				currency: info.currency,
				capturedAt: Date.now(),
			};
		},
	},
	{
		// StepFun 开放平台: GET /v1/accounts（人民币计费，响应不含 currency 字段）
		providers: ["stepfun", "stepfun-ai"],
		envKeys: ["STEPFUN_API_KEY"],
		authNames: ["stepfun"],
		modelsJsonProvider: "stepfun",
		url: "https://api.stepfun.com/v1/accounts",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const balance = typeof json?.balance === "number" ? json.balance : undefined;
			if (balance === undefined) return undefined;
			return { provider: "stepfun", label: `¥${balance.toFixed(2)}`, value: balance, currency: "CNY", capturedAt: Date.now() };
		},
	},
	{
		// Kimi 开放平台国内站: GET /v1/users/me/balance（人民币）。
		// code !== 0 = key 不属于该站点 → AuthRejectedError → 尝试国际站。
		providers: ["moonshotai-cn", "moonshot"],
		envKeys: ["MOONSHOT_API_KEY"],
		authNames: ["moonshotai-cn", "moonshot"],
		url: "https://api.moonshot.cn/v1/users/me/balance",
		fallbackUrls: ["https://api.moonshot.ai/v1/users/me/balance"],
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json, url) => {
			if (json?.code !== undefined && json.code !== 0) throw new AuthRejectedError(`moonshot: code ${json.code}`);
			const n = (v: any): number | undefined => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
			const available = n(json?.data?.available_balance);
			if (available === undefined) return undefined;
			const currency = url.includes("moonshot.ai") ? "USD" : "CNY";
			const symbol = currency === "USD" ? "$" : "¥";
			return { provider: "moonshot", label: `${symbol}${available.toFixed(2)}`, value: available, currency, capturedAt: Date.now() };
		},
	},
	{
		// Kimi 开放平台国际站（api.moonshot.ai，美元）
		providers: ["moonshotai"],
		envKeys: ["MOONSHOT_API_KEY"],
		authNames: ["moonshotai"],
		url: "https://api.moonshot.ai/v1/users/me/balance",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json, url) => {
			if (json?.code !== undefined && json.code !== 0) throw new AuthRejectedError(`moonshot: code ${json.code}`);
			const n = (v: any): number | undefined => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
			const available = n(json?.data?.available_balance);
			if (available === undefined) return undefined;
			return { provider: "moonshot", label: `$${available.toFixed(2)}`, value: available, currency: "USD", capturedAt: Date.now() };
		},
	},
	{
		// SiliconFlow 国内站: GET /v1/user/info（人民币）。
		// status:false = key 不属于该站点 → AuthRejectedError → 尝试国际站。
		providers: ["siliconflow-cn"],
		envKeys: ["SILICONFLOW_CN_API_KEY", "SILICONFLOW_API_KEY"],
		authNames: ["siliconflow-cn", "siliconflow"],
		url: "https://api.siliconflow.cn/v1/user/info",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			if (json?.status === false) throw new AuthRejectedError("siliconflow: status:false");
			const n = (v: any): number | undefined => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
			const balance = n(json?.data?.balance);
			if (balance === undefined) return undefined;
			return { provider: "siliconflow", label: `¥${balance.toFixed(2)}`, value: balance, currency: "CNY", capturedAt: Date.now() };
		},
	},
	{
		// SiliconFlow 国际站（api.siliconflow.com，美元），失败时回退国内站
		providers: ["siliconflow"],
		envKeys: ["SILICONFLOW_API_KEY"],
		authNames: ["siliconflow"],
		url: "https://api.siliconflow.com/v1/user/info",
		fallbackUrls: ["https://api.siliconflow.cn/v1/user/info"],
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json, url) => {
			if (json?.status === false) throw new AuthRejectedError("siliconflow: status:false");
			const n = (v: any): number | undefined => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
			const balance = n(json?.data?.balance);
			if (balance === undefined) return undefined;
			const currency = url.includes("siliconflow.cn") ? "CNY" : "USD";
			const symbol = currency === "USD" ? "$" : "¥";
			return { provider: "siliconflow", label: `${symbol}${balance.toFixed(2)}`, value: balance, currency, capturedAt: Date.now() };
		},
	},
	{
		// OpenRouter: GET /api/v1/credits（预付费 Credits 剩余，需 Management Key）。
		// 普通 Key 会得到 403，此时不显示（避免误导），不算站点回退。
		providers: ["openrouter"],
		envKeys: ["OPENROUTER_API_KEY"],
		authNames: ["openrouter"],
		url: "https://openrouter.ai/api/v1/credits",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const n = (v: any): number | undefined => { const x = Number(v); return Number.isFinite(x) ? x : undefined; };
			const total = n(json?.data?.total_credits);
			const used = n(json?.data?.total_usage);
			if (total === undefined || used === undefined) return undefined;
			const remaining = total - used;
			return { provider: "openrouter", label: `$${remaining.toFixed(2)}`, value: remaining, currency: "USD", capturedAt: Date.now() };
		},
	},
	{
		// Skywork: GET /api/v1/balance（币种由响应携带）
		providers: ["skywork", "skyworkmodel"],
		envKeys: ["SKYWORK_API_KEY"],
		authNames: ["skywork"],
		url: "https://api.skyworkmodel.ai/api/v1/balance",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const available = typeof json?.resp_data?.available_amount === "number" ? json.resp_data.available_amount : undefined;
			if (available === undefined) return undefined;
			const currency = json.resp_data?.currency ?? "USD";
			const symbol = currency === "CNY" ? "¥" : currency === "USD" ? "$" : `${currency} `;
			return { provider: "skywork", label: `${symbol}${available.toFixed(2)}`, value: available, currency, capturedAt: Date.now() };
		},
	},
	{
		// Novita: GET /openapi/v1/billing/balance/detail（金额单位 1/10000 USD）
		providers: ["novita", "novita-ai"],
		envKeys: ["NOVITA_API_KEY"],
		authNames: ["novita"],
		url: "https://api.novita.ai/openapi/v1/billing/balance/detail",
		headers: (key) => ({ Authorization: `Bearer ${key}` }),
		parse: (json) => {
			const units = Number(json?.availableBalance);
			if (!Number.isFinite(units)) return undefined;
			const usd = units / 10_000;
			return { provider: "novita", label: `$${usd.toFixed(2)}`, value: usd, currency: "USD", capturedAt: Date.now() };
		},
	},
];

/** 查找处理某个 pi provider id 的配额 spec */
export function findPlanProvider(provider: string | undefined): PlanProviderSpec | undefined {
	return provider ? PLAN_PROVIDERS.find((p) => p.providers.includes(provider)) : undefined;
}

/** 查找处理某个 pi provider id 的余额 spec */
export function findBalanceProvider(provider: string | undefined): BalanceProviderSpec | undefined {
	return provider ? BALANCE_PROVIDERS.find((p) => p.providers.includes(provider)) : undefined;
}

/** spec 的最后一个候选 URL（主站 + 备用站点的末尾） */
function lastUrl(spec: { url: string; fallbackUrls?: string[] }): string {
	const urls = [spec.url, ...(spec.fallbackUrls ?? [])];
	return urls[urls.length - 1];
}

async function pollPlanProvider(spec: PlanProviderSpec): Promise<PlanUsageInfo | undefined> {
	const key = resolveKey(spec);
	if (!key) return undefined;
	// 主站 → 备用站点依次尝试：HTTP 401/403 或业务层拒绝（AuthRejectedError）时换下一站
	for (const url of [spec.url, ...(spec.fallbackUrls ?? [])]) {
		try {
			const res = await fetch(url, {
				headers: spec.headers(key),
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				if ((res.status === 401 || res.status === 403) && url !== lastUrl(spec)) continue;
				return undefined;
			}
			const windows = spec.parse(await res.json(), url);
			if (windows) {
				return { source: spec.providers[0], ...windows, capturedAt: Date.now() };
			}
			return undefined;
		} catch (err) {
			if (err instanceof AuthRejectedError && url !== lastUrl(spec)) continue;
			return undefined; // 网络请求尽力而为
		}
	}
	return undefined;
}

async function pollBalanceProvider(spec: BalanceProviderSpec): Promise<BalanceInfo | undefined> {
	const key = resolveKey(spec);
	if (!key) return undefined;
	for (const url of [spec.url, ...(spec.fallbackUrls ?? [])]) {
		try {
			const res = await fetch(url, {
				headers: spec.headers(key),
				signal: AbortSignal.timeout(10_000),
			});
			if (!res.ok) {
				if ((res.status === 401 || res.status === 403) && url !== lastUrl(spec)) continue;
				return undefined;
			}
			return spec.parse(await res.json(), url);
		} catch (err) {
			if (err instanceof AuthRejectedError && url !== lastUrl(spec)) continue;
			return undefined; // 网络请求尽力而为
		}
	}
	return undefined;
}

// ============================================================================
// QuotaService — 共享轮询 + 响应头解析 + 变更订阅
// ============================================================================

const POLL_INTERVAL_MS = 5 * 60_000;
const STALE_MS = 5 * 60_000;

export class QuotaService {
	rateLimitInfo: RateLimitInfo | undefined;
	planUsage: PlanUsageInfo | undefined;
	balanceInfo: BalanceInfo | undefined;

	/** 是否 dump rate-limit 响应头（由 config.debugDumpHeaders 设置） */
	debugDumpHeaders = false;

	private provider: string | undefined;
	private planPollInFlight = false;
	private balancePollInFlight = false;
	private pollTimer: ReturnType<typeof setInterval> | undefined;
	private listeners = new Set<() => void>();

	/** 订阅数据变更（用于触发 UI 重绘）。返回退订函数。 */
	onChange(cb: () => void): () => void {
		this.listeners.add(cb);
		return () => { this.listeners.delete(cb); };
	}

	private notify(): void {
		for (const cb of this.listeners) {
			try { cb(); } catch { /* 忽略订阅者错误 */ }
		}
	}

	get currentProvider(): string | undefined {
		return this.provider;
	}

	/** 切换 provider：丢弃旧数据并立即拉取新数据。provider 不变时是 no-op。 */
	setProvider(provider: string | undefined): void {
		if (provider === this.provider) return;
		this.provider = provider;
		this.planUsage = undefined;
		this.balanceInfo = undefined;
		this.notify();
		this.maybePoll(true);
	}

	/** 数据过期（>5min）时轮询配额/余额接口。render 里可放心每次调用。 */
	maybePoll(force = false): void {
		const provider = this.provider;

		const planSpec = findPlanProvider(provider);
		if (planSpec) {
			const stale = force
				|| !this.planUsage
				|| this.planUsage.source !== provider
				|| Date.now() - this.planUsage.capturedAt > STALE_MS;
			if (stale && !this.planPollInFlight) {
				this.planPollInFlight = true;
				pollPlanProvider(planSpec).then((info) => {
					if (info && this.provider && findPlanProvider(this.provider)) {
						this.planUsage = { ...info, source: this.provider };
						this.notify();
					}
				}).finally(() => { this.planPollInFlight = false; });
			}
		}

		const balSpec = findBalanceProvider(provider);
		if (balSpec) {
			const stale = force
				|| !this.balanceInfo
				|| this.balanceInfo.provider !== provider
				|| Date.now() - this.balanceInfo.capturedAt > STALE_MS;
			if (stale && !this.balancePollInFlight) {
				this.balancePollInFlight = true;
				pollBalanceProvider(balSpec).then((info) => {
					if (info && this.provider && findBalanceProvider(this.provider)) {
						// provider 归一化为当前 pi provider id，避免多 id spec 永远判旧导致连续轮询
						this.balanceInfo = { ...info, provider: this.provider };
						this.notify();
					}
				}).finally(() => { this.balancePollInFlight = false; });
			}
		}
	}

	/** 启动 5 分钟定时轮询（保持 idle 时数据新鲜） */
	startPolling(): void {
		if (this.pollTimer) return;
		this.pollTimer = setInterval(() => this.maybePoll(true), POLL_INTERVAL_MS);
	}

	stopPolling(): void {
		if (this.pollTimer) {
			clearInterval(this.pollTimer);
			this.pollTimer = undefined;
		}
	}

	/**
	 * 处理 after_provider_response 的响应头：
	 * rate limit（Anthropic/OpenAI）+ 订阅配额窗口（Codex/Claude OAuth）。
	 */
	handleProviderHeaders(headers: Record<string, string> | undefined, status: number): void {
		// Debug: dump rate-limit 相关头用于发现新字段
		if (headers && (this.debugDumpHeaders || process.env.PI_HUD_DEBUG_HEADERS)) {
			try {
				const dir = join(homedir(), ".pi", "agent");
				mkdirSync(dir, { recursive: true });
				appendFileSync(
					join(dir, "pi-agent-hud-headers.jsonl"),
					JSON.stringify({ ts: new Date().toISOString(), status, headers }) + "\n",
				);
			} catch { /* 尽力而为的调试日志 */ }
		}

		if (!headers || status >= 400) return;
		let changed = false;

		const isAnthropic = !!getHeader(headers, "anthropic-ratelimit-tokens-limit");
		const isOpenAI = !isAnthropic && !!getHeader(headers, "x-ratelimit-limit-tokens");

		if (isAnthropic) {
			const tokenLimit = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-limit") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-tokens-remaining") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "anthropic-ratelimit-requests-limit") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "anthropic-ratelimit-requests-remaining") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				this.rateLimitInfo = { provider: "anthropic", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
				changed = true;
			}
		} else if (isOpenAI) {
			const tokenLimit = parseInt(getHeader(headers, "x-ratelimit-limit-tokens") || "0", 10);
			const tokenRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-tokens") || "0", 10);
			const requestLimit = parseInt(getHeader(headers, "x-ratelimit-limit-requests") || "0", 10);
			const requestRemaining = parseInt(getHeader(headers, "x-ratelimit-remaining-requests") || "0", 10);
			if (tokenLimit > 0 || requestLimit > 0) {
				this.rateLimitInfo = { provider: "openai", tokenRemaining, tokenLimit, requestRemaining, requestLimit, capturedAt: Date.now() };
				changed = true;
			}
		}

		// ---- 编码计划（订阅）配额窗口：5h / 每周 ----
		// Codex via ChatGPT OAuth: x-codex-primary-* (~5h) 和 x-codex-secondary-* (weekly)
		const codexPrimaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-primary-used-percent"));
		const codexSecondaryUsed = parseUtilizationHeader(getHeader(headers, "x-codex-secondary-used-percent"));
		if (codexPrimaryUsed !== undefined || codexSecondaryUsed !== undefined) {
			this.planUsage = {
				source: "codex",
				fiveHour: codexPrimaryUsed !== undefined ? {
					usedPercent: codexPrimaryUsed,
					windowMinutes: Number(getHeader(headers, "x-codex-primary-window-minutes")) || undefined,
					resetAt: parseResetHeader(getHeader(headers, "x-codex-primary-reset-at")),
				} : undefined,
				weekly: codexSecondaryUsed !== undefined ? {
					usedPercent: codexSecondaryUsed,
					windowMinutes: Number(getHeader(headers, "x-codex-secondary-window-minutes")) || undefined,
					resetAt: parseResetHeader(getHeader(headers, "x-codex-secondary-reset-at")),
				} : undefined,
				capturedAt: Date.now(),
			};
			changed = true;
		} else {
			// Claude 订阅 (OAuth): anthropic-ratelimit-unified-{5h,7d}-{utilization,reset}
			const a5h = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-5h-utilization"));
			const a7d = parseUtilizationHeader(getHeader(headers, "anthropic-ratelimit-unified-7d-utilization"));
			if (a5h !== undefined || a7d !== undefined) {
				this.planUsage = {
					source: "anthropic",
					fiveHour: a5h !== undefined ? {
						usedPercent: a5h,
						windowMinutes: 300,
						resetAt: parseResetHeader(getHeader(headers, "anthropic-ratelimit-unified-5h-reset")),
					} : undefined,
					weekly: a7d !== undefined ? {
						usedPercent: a7d,
						windowMinutes: 7 * 24 * 60,
						resetAt: parseResetHeader(getHeader(headers, "anthropic-ratelimit-unified-7d-reset")),
					} : undefined,
					capturedAt: Date.now(),
				};
				changed = true;
			}
		}

		if (changed) this.notify();
	}
}
