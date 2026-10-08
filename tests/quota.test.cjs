const assert = require('node:assert/strict');
const { test, after } = require('node:test');
const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
// jiti 随 pi 安装；非 Homebrew 路径需同步调整
const PI_ROOT = '/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent';
const originalHome = process.env.HOME;
const originalFetch = global.fetch;
const isolatedHome = mkdtempSync(join(tmpdir(), 'hud-quota-test-'));
process.env.HOME = isolatedHome;
const { createJiti } = require(join(PI_ROOT, 'node_modules', 'jiti'));
const quota = createJiti(__filename)(join(__dirname, '../extensions/agent-hud/quota.ts'));
const tick = () => new Promise((r) => setImmediate(r));

after(() => {
	global.fetch = originalFetch;
	process.env.HOME = originalHome;
	rmSync(isolatedHome, { recursive: true, force: true });
});

const findPlan = (id) => quota.PLAN_PROVIDERS.find((p) => p.providers.includes(id));
const findBalance = (id) => quota.BALANCE_PROVIDERS.find((p) => p.providers.includes(id));
const jsonResponse = (body, status = 200) => ({
	ok: status < 400,
	status,
	json: async () => body,
});

// --- 注册表覆盖 ---------------------------------------------------------------

test('registry covers the new plan/balance providers', () => {
	assert.ok(findPlan('opencode-go') && findPlan('opencode'), 'opencode zen');
	assert.ok(findPlan('zai-coding-plan') && findPlan('zai'), 'zai intl');
	assert.ok(findPlan('zai-coding-cn'), 'zai cn 仍在');
	for (const id of ['stepfun', 'moonshotai-cn', 'moonshotai', 'siliconflow-cn', 'siliconflow', 'openrouter', 'skywork', 'novita', 'deepseek']) {
		assert.ok(findBalance(id), `balance spec for ${id}`);
	}
});

// --- parse：opencode zen ------------------------------------------------------

test('opencode zen parse maps rolling/weekly/monthly and clamps percent', () => {
	const parse = findPlan('opencode-go').parse;
	const out = parse({
		usage: {
			rolling: { percent: 92.4, resetsAt: new Date(Date.now() + 5 * 3600e3).toISOString() },
			weekly: { percent: 41, resetsAt: new Date(Date.now() + 4 * 86400e3).toISOString() },
			monthly: { percent: 120 }, // 越界值钳制到 100
		},
	}, 'https://opencode.ai/zen/go/v1/usage');
	assert.equal(out.fiveHour.usedPercent, 92.4);
	assert.equal(out.fiveHour.windowMinutes, 300);
	assert.ok(out.fiveHour.resetAt > Date.now());
	assert.equal(out.weekly.usedPercent, 41);
	assert.equal(out.monthly.usedPercent, 100);
	assert.equal(out.monthly.windowMinutes, 30 * 24 * 60);
});

// --- parse：zai ---------------------------------------------------------------

test('zai parse handles TOKENS_LIMIT windows and rejects success:false', () => {
	const parse = findPlan('zai-coding-cn').parse;
	const out = parse({
		data: { level: 'max', limits: [
			{ type: 'TOKENS_LIMIT', unit: 3, number: 5, percentage: 30, nextResetTime: 1759970000000 },
			{ type: 'TOKENS_LIMIT', unit: 6, number: 7, percentage: 12, nextResetTime: 1760400000000 },
		] },
	}, 'x');
	assert.equal(out.fiveHour.usedPercent, 30);
	assert.equal(out.fiveHour.windowMinutes, 300);
	assert.equal(out.weekly.windowMinutes, 7 * 24 * 60);
	assert.throws(() => parse({ success: false }, 'x'), quota.AuthRejectedError);
	// 国际站 spec 复用同一 parse
	assert.throws(() => findPlan('zai').parse({ success: false }, 'x'), quota.AuthRejectedError);
});

test('zai parse accepts the CREDIT_LIMIT type now returned by the live API', () => {
	// 2026-10 线上实际响应：type 已从 TOKENS_LIMIT 变为 CREDIT_LIMIT
	const parse = findPlan('zai-coding-cn').parse;
	const out = parse({
		code: 200,
		msg: '操作成功',
		data: { level: 'pro', limits: [
			{ type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 12000, currentValue: 3728, remaining: 8271, percentage: 31, nextResetTime: 1791432294100 },
			{ type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 60000, currentValue: 18938, remaining: 41061, percentage: 31, nextResetTime: 1791796394998 },
		] },
		success: true,
	}, 'x');
	assert.equal(out.fiveHour.usedPercent, 31);
	assert.equal(out.fiveHour.windowMinutes, 300);
	assert.equal(out.weekly.usedPercent, 31);
	assert.equal(out.weekly.windowMinutes, 24 * 60);
	assert.equal(out.fiveHour.resetAt, 1791432294100);
});

test('zai intl spec sends the raw key without Bearer', () => {
	const spec = findPlan('zai');
	assert.equal(spec.url, 'https://api.z.ai/api/monitor/usage/quota/limit');
	assert.deepEqual(spec.headers('sk-abc'), { Authorization: 'sk-abc' });
});

// --- parse：余额类 -------------------------------------------------------------

test('stepfun parse formats CNY balance', () => {
	const out = findBalance('stepfun').parse({ balance: 88.5, type: 'prepaid' }, 'x');
	assert.equal(out.label, '¥88.50');
	assert.equal(out.currency, 'CNY');
	assert.equal(out.value, 88.5);
});

test('moonshot parse picks currency by site and rejects foreign keys', () => {
	const cn = findBalance('moonshotai-cn');
	const payload = { code: 0, data: { available_balance: 12.5, voucher_balance: 2.5, cash_balance: 10 } };
	assert.deepEqual(cn.parse(payload, 'https://api.moonshot.cn/v1/users/me/balance').label, '¥12.50');
	assert.deepEqual(cn.parse(payload, 'https://api.moonshot.ai/v1/users/me/balance').label, '$12.50');
	assert.throws(() => cn.parse({ code: 401, msg: 'invalid' }, 'x'), quota.AuthRejectedError);
	const intl = findBalance('moonshotai');
	assert.equal(intl.url, 'https://api.moonshot.ai/v1/users/me/balance');
	assert.equal(intl.parse(payload, intl.url).currency, 'USD');
});

test('siliconflow parse formats balance and rejects foreign keys', () => {
	const cn = findBalance('siliconflow-cn');
	assert.equal(cn.parse({ data: { balance: '3.25' } }, 'x').label, '¥3.25');
	assert.throws(() => cn.parse({ status: false, message: 'bad key' }, 'x'), quota.AuthRejectedError);
	const intl = findBalance('siliconflow');
	assert.equal(intl.parse({ data: { balance: 3.25 } }, 'https://api.siliconflow.com/v1/user/info').currency, 'USD');
	assert.equal(intl.parse({ data: { balance: 3.25 } }, 'https://api.siliconflow.cn/v1/user/info').currency, 'CNY');
});

test('novita parse converts 1/10000 USD units', () => {
	const out = findBalance('novita').parse({ availableBalance: '1000000' }, 'x');
	assert.equal(out.label, '$100.00');
	assert.equal(out.value, 100);
});

test('skywork parse uses payload currency', () => {
	const spec = findBalance('skywork');
	assert.equal(spec.parse({ resp_data: { available_amount: 5.5, currency: 'CNY' } }, 'x').label, '¥5.50');
	assert.equal(spec.parse({ resp_data: { available_amount: 5.5 } }, 'x').label, '$5.50');
});

test('openrouter parse computes remaining credits', () => {
	const out = findBalance('openrouter').parse({ data: { total_credits: 20, total_usage: 7.25 } }, 'x');
	assert.equal(out.label, '$12.75');
});

// --- 集成：QuotaService 站点回退 + key 解析 -----------------------------------

test('QuotaService falls back to the international site on 401 and normalizes provider id', async () => {
	// auth.json 提供 moonshot key
	mkdirSync(join(isolatedHome, '.pi', 'agent'), { recursive: true });
	writeFileSync(
		join(isolatedHome, '.pi', 'agent', 'auth.json'),
		JSON.stringify({ 'moonshotai-cn': { type: 'api_key', key: 'cn-key' } }),
	);
	const urls = [];
	global.fetch = async (url, init) => {
		urls.push(String(url));
		if (url.includes('moonshot.cn')) return jsonResponse({ code: 401 }, 401);
		assert.equal(init.headers.Authorization, 'Bearer cn-key');
		return jsonResponse({ code: 0, data: { available_balance: 9 } });
	};
	const svc = new quota.QuotaService();
	try {
		svc.setProvider('moonshotai-cn');
		svc.maybePoll(true);
		for (let i = 0; i < 20 && !svc.balanceInfo; i++) await tick();
		assert.deepEqual(urls.map((u) => new URL(u).hostname), ['api.moonshot.cn', 'api.moonshot.ai']);
		assert.equal(svc.balanceInfo.label, '$9.00');
		// provider 归一化为当前 pi provider id（否则 maybePoll 会永远判旧连续轮询）
		assert.equal(svc.balanceInfo.provider, 'moonshotai-cn');
		// 数据新鲜时重复 maybePoll 不再发请求
		const before = urls.length;
		svc.maybePoll();
		await tick(); await tick();
		assert.equal(urls.length, before);
	} finally {
		svc.stopPolling();
	}
});

test('resolveKey expands $ENV references found in models.json', async () => {
	writeFileSync(
		join(isolatedHome, '.pi', 'agent', 'models.json'),
		JSON.stringify({ providers: { stepfun: { apiKey: '$STEPFUN_TEST_KEY' } } }),
	);
	process.env.STEPFUN_TEST_KEY = 'env-resolved-key';
	let authHeader = '';
	global.fetch = async (_url, init) => {
		authHeader = init.headers.Authorization;
		return jsonResponse({ balance: 1.5 });
	};
	const svc = new quota.QuotaService();
	try {
		svc.setProvider('stepfun');
		svc.maybePoll(true);
		for (let i = 0; i < 20 && !svc.balanceInfo; i++) await tick();
		assert.equal(authHeader, 'Bearer env-resolved-key');
		assert.equal(svc.balanceInfo.label, '¥1.50');
	} finally {
		svc.stopPolling();
		delete process.env.STEPFUN_TEST_KEY;
	}
});

test('QuotaService polls the opencode zen plan with monthly window', async () => {
	writeFileSync(
		join(isolatedHome, '.pi', 'agent', 'auth.json'),
		JSON.stringify({ 'opencode-go': { type: 'api_key', key: 'zen-key' } }),
	);
	global.fetch = async () =>
		jsonResponse({ usage: {
			rolling: { percent: 50 },
			weekly: { percent: 20 },
			monthly: { percent: 10 },
		} });
	const svc = new quota.QuotaService();
	try {
		svc.setProvider('opencode-go');
		svc.maybePoll(true);
		for (let i = 0; i < 20 && !svc.planUsage; i++) await tick();
		assert.equal(svc.planUsage.fiveHour.usedPercent, 50);
		assert.equal(svc.planUsage.weekly.usedPercent, 20);
		assert.equal(svc.planUsage.monthly.usedPercent, 10);
		assert.equal(svc.planUsage.source, 'opencode-go');
	} finally {
		svc.stopPolling();
	}
});
