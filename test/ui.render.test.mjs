/**
 * 用量页（CONTRACT §4 的 1…7 条）真浏览器回归。
 *
 * 为什么这样测：真 GUI（http://127.0.0.1:56113）是桌面 App 的 webview，服务器对普通浏览器一律
 * `401 dsh web authentication required`，带 token 的 URL 只有 App 自己知道。所以改用离线 DOM 测试台
 * （`../_harness/`，真 React 18.3.1 UMD）：跑的是 `lib/client.js` 的**真身**——真 hooks、真 DOM 事件、
 * 真 SVG、真 ResizeObserver——只有外部环境（槽位 / 远端 / 主题令牌）由本文件提供。
 * 真 GUI 的最终确认由 lead 用桌面端截图完成。
 *
 * 覆盖：
 *   ① 标题 + 数据来源 pill + 说明；② 5 列 KPI 条（列间细分隔线，窄面板 6 列/2 列补格不空洞）；
 *   ③ Token 活动卡（每日·每周·累计分段控件、月份轴在网格下方、今天 ring、悬停浮层「2026年9月24日 /
 *   4.5亿 tokens · 55 轮消息」、点击下钻明细；六档图例 = 少 [6 swatch] 多，区间 2 位有效数字）；
 *   ④ 分析区间行（近 7 日·近 30 日，且**不触发**远端重查）；⑤ 趋势图（多系列平滑曲线 + 对数纵轴 + 等距日期轴 +
 *   与环形图一致的系列色 + 悬停浮层）；⑥ 模型用量环形图 + 右侧占比列表；⑦ 右下刷新（refresh:true）+ 扫描小字。
 *   外加：v1 宿主（缺 allTime/rounds/mode）防御式降级、空数据、失败态（role=alert + 重试）、
 *   场景 5：**真宿主半**（`../src/cordis.js`，直接 new 出来跑真扫描）产出的 payload 灌进真浏览器半，
 *   验证 CONTRACT §1 字段名与 §3 mode 口径在两边真的对得上（宿主半不可用/本机无数据时自动跳过）；
 *   场景 6：**旧宿主半忽略 query.mode** 时的降级分支 —— 期望值用与宿主同源的 `src/scan.js`
 *   （modeValues / levelThresholds / levelOf）现算，并附一条反例断言证明这条不是空转。
 *
 * 桩与宿主同源：fixture 各 mode 的 value/level/legend 都调真 `src/scan.js` 现算，不另写一套算法。
 *
 * 运行：node test/ui.render.test.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(
	process.env.DSHP_PLAYWRIGHT ||
	(process.env.USERPROFILE || '') + '/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright',
);

const HARNESS = process.env.DSHP_HARNESS || 'E:/deepseek harness/token-usage/_harness';
const CLIENT = fileURLToPath(new URL('../lib/client.js', import.meta.url));
const SHOTS = process.env.DSHP_SHOTS || 'E:/deepseek harness/token-usage/_recon/';
const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';

/* 桩与宿主同源：fixture 的 mode 口径直接调真 src/scan.js 现算 —— 这样「宿主按 mode 返回」与
 * 「宿主没按 mode 返回 → 客户端降级自算」两条路径的期望值都出自同一份宿主算法，断言才有意义。 */
let hostScan = null;
try {
	hostScan = await import('../src/scan.js');
} catch (e) {
	console.log('info 无法 import ../src/scan.js，mode 口径断言将跳过：' + String((e && e.message) || e));
}

/* ---------------- 日期小工具（与插件/宿主半同一套纯字符串算法） ---------------- */
const DAY_MS = 86400000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const pd = (day) => Date.parse(day + 'T00:00:00.000Z');
const addDays = (day, n) => iso(pd(day) + n * DAY_MS);
const diffDays = (a, b) => Math.round((pd(b) - pd(a)) / DAY_MS);
const mondayOf = (day) => addDays(day, -((new Date(pd(day)).getUTCDay() + 6) % 7));

/* ---------------- fixture：CONTRACT §1 形状 ---------------- */
const TO = '2026-10-18';
const WEEKS = 52;
const FROM = mondayOf(addDays(TO, -(WEEKS * 7 - 1)));
const MODELS = [
	'deepseek/deepseek-v4.1-flash',
	'group/auto-deepseek-v4-1-flash',
	'group/auto',
	'deepseek/deepseek-v4.1-pro',
];
const SPLIT = [0.888, 0.076, 0.021, 0.015];
const TOOLTIP_DAY = '2026-09-24'; // 参考图 4：4.5 亿 tokens · 55 轮消息
const PEAK_DAY = '2026-10-15';

/** 当天计费总量（确定性波形；近 30 天有起伏，10 月 15 日尖峰同参考图 2）。 */
function totalFor(day) {
	const k = diffDays(day, TO); // 0 = 今天
	if (day === TOOLTIP_DAY) return 450000000;
	if (day === PEAK_DAY) return 1020782001;
	if (k === 0) return 38083921;
	if (k > 30) {
		if (k % 11 !== 0 && k % 7 !== 3) return 0; // 更早的窗口里稀疏有量
		return Math.round(9e6 + (k % 23) * 1.1e6);
	}
	return Math.round(7e6 + 5e6 * Math.sin(k / 2.2) + (k % 5 === 0 ? 1.7e7 : 0));
}
/** rounds：v2 字段才有的「轮消息」。 */
function roundsFor(day, total) {
	if (day === TOOLTIP_DAY) return 55;
	if (total <= 0) return 0;
	return Math.max(1, Math.round(total / 8e6));
}
/** 1/6…5/6 分位（与宿主半 levelThresholds 同算法）。 */
function cutsOf(values) {
	const vals = values.filter((v) => v > 0).sort((a, b) => a - b);
	if (vals.length < 2 || new Set(vals).size < 2) return null;
	const at = (q) => vals[Math.min(vals.length - 1, Math.max(0, Math.ceil(q * vals.length) - 1))];
	return [1, 2, 3, 4, 5].map((i) => at(i / 6));
}
function levelOf(v, cuts) {
	if (!(v > 0)) return 0;
	if (!cuts) return 3;
	let level = 1;
	for (const c of cuts) if (v >= c) level++;
	return Math.min(6, level);
}
/** cuts → 六档图例（与宿主半同形制）。 */
const legendOf = (cuts) =>
	cuts
		? [
				{ level: 1, min: null, max: cuts[0] },
				{ level: 2, min: cuts[0], max: cuts[1] },
				{ level: 3, min: cuts[1], max: cuts[2] },
				{ level: 4, min: cuts[2], max: cuts[3] },
				{ level: 5, min: cuts[3], max: cuts[4] },
				{ level: 6, min: cuts[4], max: null },
			]
		: [1, 2, 3, 4, 5, 6].map((level) => ({ level, min: null, max: null }));

/** 某 mode 口径下「有数据日 → level」，用真宿主的同一套算法现算（期望值唯一来源）。 */
function hostLevelsOf(payload, mode) {
	const windowDays = payload.days.map((d) => d.day);
	const dayTotals = new Map(payload.days.map((d) => [d.day, d.total]));
	const values = hostScan.modeValues(mode, windowDays, dayTotals);
	const cuts = hostScan.levelThresholds(values);
	const out = {};
	payload.days.forEach((row, i) => {
		out[row.day] = String(hostScan.levelOf(values[i], cuts));
	});
	return { values, cuts, levels: out, legend: legendOf(cuts) };
}

/** 按 mode 生成桩 payload：与宿主同源（scale.mode / days[].value / days[].level 全部对齐）。 */
function withMode(payload, mode) {
	if (!hostScan) return payload;
	const { values, cuts, legend } = hostLevelsOf(payload, mode);
	const out = JSON.parse(JSON.stringify(payload));
	out.mode = mode;
	out.scale = { metric: 'total', mode, cuts, legend, max: values.reduce((m, v) => Math.max(m, v), 0) };
	out.days = out.days.map((row, i) => Object.assign({}, row, { value: values[i], level: hostScan.levelOf(values[i], cuts) }));
	return out;
}

/**
 * 反例口径（修复前的实现）：取样集合 = 「窗口内每一天」（每周 7 天都继承周总量）。
 * 只用来证明降级那条断言不是空转 —— 两种口径的档位确实不同。
 */
function windowWideWeekLevels(payload) {
	const byDay = new Map(payload.days.map((d) => [d.day, d.total]));
	const week = new Map();
	for (let d = payload.window.from; d <= payload.window.to; d = addDays(d, 1)) {
		const mon = mondayOf(d);
		if (!week.has(mon)) {
			let s = 0;
			for (let k = 0; k < 7; k++) s += byDay.get(addDays(mon, k)) || 0;
			week.set(mon, s);
		}
	}
	const values = [];
	for (let d = payload.window.from; d <= payload.window.to; d = addDays(d, 1)) values.push(week.get(mondayOf(d)));
	const cuts = hostScan.levelThresholds(values);
	const out = {};
	for (const row of payload.days) out[row.day] = String(hostScan.levelOf(week.get(mondayOf(row.day)), cuts));
	return out;
}

function buildPayload({ legacy = false, empty = false } = {}) {
	const days = [];
	if (!empty) {
		for (let d = FROM; d <= TO; d = addDays(d, 1)) {
			const total = totalFor(d);
			if (total <= 0) continue;
			const models = MODELS.map((model, i) => {
				const t = Math.round(total * SPLIT[i]);
				return { model, total: t, input: Math.round(t * 0.02), output: Math.round(t * 0.03), cacheRead: Math.round(t * 0.94), requests: Math.max(1, Math.round(t / 250000)) };
			}).filter((m) => m.total > 0);
			const sum = models.reduce((s, m) => s + m.total, 0);
			const row = {
				day: d,
				total: sum,
				newTokens: Math.round(sum * 0.05),
				input: Math.round(sum * 0.02),
				output: Math.round(sum * 0.03),
				cacheRead: Math.round(sum * 0.93),
				cacheWrite: Math.round(sum * 0.02),
				requests: models.reduce((s, m) => s + m.requests, 0),
				/* 命中率取 95.5–98.5% 的窄区间（贴近真实数据的 97–98%），专门用来钉右轴自适应 */
				hitRate: 0.955 + 0.03 * ((diffDays(d, TO) % 5) / 4),
				models,
			};
			if (!legacy) row.rounds = roundsFor(d, sum);
			days.push(row);
		}
	}
	const cuts = cutsOf(days.map((d) => d.total));
	const legend = cuts
		? [
				{ level: 1, min: null, max: cuts[0] },
				{ level: 2, min: cuts[0], max: cuts[1] },
				{ level: 3, min: cuts[1], max: cuts[2] },
				{ level: 4, min: cuts[2], max: cuts[3] },
				{ level: 5, min: cuts[3], max: cuts[4] },
				{ level: 6, min: cuts[4], max: null },
			]
		: [1, 2, 3, 4, 5, 6].map((level) => ({ level, min: null, max: null }));
	for (const row of days) {
		row.level = levelOf(row.total, cuts);
		if (!legacy) row.value = row.total;
	}
	const totals = days.reduce(
		(a, d) => ({
			total: a.total + d.total,
			newTokens: a.newTokens + d.newTokens,
			input: a.input + d.input,
			output: a.output + d.output,
			cacheRead: a.cacheRead + d.cacheRead,
			cacheWrite: a.cacheWrite + d.cacheWrite,
			requests: a.requests + d.requests,
			rounds: a.rounds + (d.rounds || 0),
			days: a.days + 1,
		}),
		{ total: 0, newTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, rounds: 0, days: 0 },
	);
	totals.hitRate = 0.979;
	const payload = {
		generatedAt: '2026-10-18T12:31:02.000Z',
		tzOffsetMinutes: 480,
		sessionsRoot: 'C:\\Users\\you\\.dsh\\sessions',
		weeks: WEEKS,
		window: { from: FROM, to: TO },
		stats: { files: 47, reusedFiles: 47, usageEvents: 2100, parsedLines: 9000, badLines: 0, scanMs: 903 },
		scale: { metric: 'total', cuts, legend, max: days.reduce((m, d) => Math.max(m, d.total), 0) },
		totals,
		days,
		cached: false,
	};
	if (!legacy) {
		payload.mode = 'day';
		payload.scale.mode = 'day';
		payload.allTime = {
			total: 1780000000,
			activeDays: days.length,
			rounds: totals.rounds,
			peak: { day: PEAK_DAY, total: 1020782001 },
			currentStreak: 6,
			longestStreak: 13,
			longestSpanMs: 30120000,
		};
	}
	return payload;
}

const FIXTURE = buildPayload();
const FIXTURE_LEGACY = buildPayload({ legacy: true });
const FIXTURE_EMPTY = buildPayload({ empty: true, legacy: true });
/** 场景 1 的桩数据：三种 mode 各一份（scale.mode / days[].value / days[].level 全按宿主算法现算）。 */
const MODE_PAYLOADS = {
	day: withMode(FIXTURE, 'day'),
	week: withMode(FIXTURE, 'week'),
	cum: withMode(FIXTURE, 'cum'),
};
/** fixture 里有数据的日子（与「空白天」区分）。 */
const FIXTURE_DAYSET = new Set(FIXTURE.days.map((d) => d.day));
/** 按大括号配平从源码里抠出一个顶层函数（跑的是产品真身那段代码）。 */
function grabFn(source, name) {
	const start = source.indexOf('function ' + name + '(');
	if (start < 0) throw new Error('找不到 ' + name);
	let depth = 0;
	let i = source.indexOf('{', start);
	for (; i < source.length; i++) {
		if (source[i] === '{') depth++;
		else if (source[i] === '}') {
			depth--;
			if (depth === 0) break;
		}
	}
	return source.slice(start, i + 1);
}
/* 热力图固定 52 周后不再按宽度解周数；只抠 heatGapFor 复算格子公式里的 gap（桩与产品同源）。 */
const gapFor = new Function(
	grabFn(readFileSync(CLIENT, 'utf8'), 'isNum') + '\n' + grabFn(readFileSync(CLIENT, 'utf8'), 'heatGapFor') + '\nreturn heatGapFor;',
)();
/**
 * **等距抽稀的规格**（独立于产品实现的镜像）：stride = ceil(max(最宽标签 + 12, 1.5·最宽标签 + 8) / step)，
 * 只画 0、stride、2·stride…；首尾保留；末位与前一位冲突（间距 < 12px）时丢倒数第二个、保最后一个。
 * 端点是贴边画的（左 start / 右 end），所以要额外留半个标签宽 + 8px 呼吸位，否则 500px 下首两个
 * 日期只差 1.3px。返回被保留的下标数组。
 */
function expectedAxisPicks(n, plotW, labelW) {
	if (n <= 1) return [0];
	const step = plotW / (n - 1);
	const stride = Math.max(1, Math.ceil(Math.max(labelW + 12, labelW * 1.5 + 8) / step));
	const picks = [];
	for (let i = 0; i < n; i += stride) picks.push(i);
	if (picks[picks.length - 1] !== n - 1) {
		const prev = picks.length > 1 ? picks[picks.length - 1] : -1;
		const lastLeft = plotW - labelW; // 末位右对齐
		const prevRight = prev > 0 ? (prev * plotW) / (n - 1) + labelW / 2 : labelW;
		if (prev > 0 && lastLeft - prevRight < 12) picks.pop();
		picks.push(n - 1);
	}
	return picks;
}
/**
 * 等距的像素判据：**中段相邻标签中心距必须一致**（±1.5px）；首/末两段因为端点贴边（首 start、末 end）
 * 与「末位补位」会少/多半个标签宽到一个 stride，分别落在 [stride·step − w/2 − 1, 2·stride·step + 1]。
 * 返回 { ok, stride, want, interior, ends }。
 */
function axisUniform(gaps, step, labelW) {
	if (!(gaps.length >= 2)) return { ok: false, reason: 'gaps=' + gaps.length };
	const interior = gaps.length > 2 ? gaps.slice(1, -1) : gaps;
	const stride = Math.max(1, Math.round(Math.min(...interior) / step));
	const want = stride * step;
	const ends = [gaps[0], gaps[gaps.length - 1]];
	const innerOk = interior.every((g) => Math.abs(g - want) <= 1.5);
	const endOk = ends.every((g) => g >= want - labelW / 2 - 1 && g <= 2 * want + 1);
	return { ok: innerOk && endOk, stride, want: Math.round(want * 100) / 100, interior, ends: ends.map((g) => Math.round(g * 100) / 100) };
}
/**
 * 热力图固定 52 周：桩永远按 52 周窗口回数据（不再按容器宽解周数）。
 * 容器宽只影响**格子尺寸**（见产品里的 heatCell），不再影响请求。
 */
function payloadsForContainer(payloads, containerWidth) {
	if (!payloads || !containerWidth) return null;
	return { primary: payloads, byWeeks: { 52: payloads } };
}
/** 与 lib/client.js 同一套紧凑数字格式，用来核对图例区间文案。 */
const trimZero = (s) => (s.indexOf('.') === -1 ? s : s.replace(/0+$/, '').replace(/\.$/, ''));
const fmtCompact = (n) => (n >= 1e8 ? trimZero((n / 1e8).toFixed(2)) + '亿' : n >= 1e4 ? trimZero((n / 1e4).toFixed(2)) + '万' : String(Math.round(n)));
/** 与产品同一条「2 位有效数字」规则（图例区间的两端都走它，避免 1184.78万–1780万 这种精度错位）。 */
const fmt2 = (n) => {
	if (!(typeof n === 'number' && isFinite(n))) return '—';
	if (n === 0) return '0';
	const pow = Math.pow(10, Math.floor(Math.log(Math.abs(n)) / Math.LN10 + 1e-9)) / 10;
	const v = Math.round(n / pow) * pow;
	return fmtCompact(v);
};
const bandText = (b) => (b.min === null ? '< ' + fmt2(b.max) : b.max === null ? '≥ ' + fmt2(b.min) : fmt2(b.min) + '–' + fmt2(b.max));
/** 数字串里的有效位数（'1200万' → 2、'900万' → 1、'1.2亿' → 2）；用来钉「2 位有效数字」这条规则。 */
const sigDigits = (s) => {
	const m = /^([<≥] )?([\d.]+)/.exec(String(s));
	if (!m) return NaN;
	const digits = m[2].replace('.', '').replace(/0+$/, '');
	return Math.max(1, digits.length);
};
/** HSL 饱和度（「其他」必须是**中性灰**：蓝灰 slate(#94a3b8, ≈20%) 会被读成一种颜色而不是无色）。 */
const hslSat = (rgb) => {
	const [r, g, b] = rgb.map((v) => v / 255);
	const mx = Math.max(r, g, b);
	const mn = Math.min(r, g, b);
	const d = mx - mn;
	if (d < 1e-9) return 0;
	const l = (mx + mn) / 2;
	return d / (1 - Math.abs(2 * l - 1));
};

/* ---------------- 页面装配 ---------------- */
/**
 * 宿主主题令牌的**权威清单**（Theme.listTokens 原样）。测试里只给这些名字赋值：
 * 插件若引用了不存在的令牌名，静态审计那条断言会直接红（那种错会让亮/暗两套都不跟随主题）。
 *
 * ⚠️ brand-primary 必须设成**真宿主那样的单色**（深灰 / 浅灰，不是好看的蓝）：上一轮「热力图整条
 * 色阶变灰→黑」的回归之所以没被测出来，就是因为 harness 把品牌色设成了蓝色，掩盖了
 * 「数据可视化色板跟了品牌色」这个错。**桩不真实，测试就是安慰剂。**
 */
const TOKENS = {
	light: {
		'--dsw-alias-bg-base': '#ffffff',
		'--dsw-alias-bg-layer-1': '#ffffff',
		'--dsw-alias-bg-layer-2': '#f0f0f2',
		'--dsw-alias-bg-overlay': '#ffffff',
		'--dsw-alias-border-l1': '#ececef',
		'--dsw-alias-border-l2': '#e3e3e7',
		'--dsw-alias-brand-primary': '#2b2b2b',
		'--dsw-alias-label-primary': '#1b1b1f',
		'--dsw-alias-label-secondary': '#5b5b66',
		'--dsw-alias-state-error-primary': '#d93025',
		'--dsw-alias-state-idle-primary': '#c3c3cc',
		'--dsw-alias-state-success-primary': '#188038',
		'--dsw-alias-state-warn-primary': '#f59e0b',
		'--dsw-specific-sidebar-fill': '#f7f7f8',
	},
	dark: {
		'--dsw-alias-bg-base': '#111114',
		'--dsw-alias-bg-layer-1': '#1b1b20',
		'--dsw-alias-bg-layer-2': '#26262d',
		'--dsw-alias-bg-overlay': '#1b1b20',
		'--dsw-alias-border-l1': '#2c2c34',
		'--dsw-alias-border-l2': '#3a3a44',
		'--dsw-alias-brand-primary': '#e8e8ea',
		'--dsw-alias-label-primary': '#f2f2f5',
		'--dsw-alias-label-secondary': '#a8a8b3',
		'--dsw-alias-state-error-primary': '#f28b82',
		'--dsw-alias-state-idle-primary': '#6b6b78',
		'--dsw-alias-state-success-primary': '#5bb974',
		'--dsw-alias-state-warn-primary': '#fdd663',
		'--dsw-specific-sidebar-fill': '#17171b',
	},
};
const AUTHORITATIVE_TOKENS = Object.keys(TOKENS.light);
const decls = (name) => Object.entries(TOKENS[name]).map(([k, v]) => k + ':' + v).join(';');
const THEME = `
	:root{${decls('light')}}
	html,body{margin:0;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font-family:"Segoe UI",system-ui,-apple-system,"Microsoft YaHei",sans-serif}
	#root{padding:28px 32px 40px}
	body.bare #root{padding:0}
	body.dark{${decls('dark')}}
`;

const browser = await chromium.launch({ executablePath: CHROME });
const pages = [];
let failures = 0;
let checks = 0;
const check = (name, ok, detail) => {
	checks++;
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + JSON.stringify(detail)));
	if (!ok) failures++;
};

async function mount({ payloads = null, mode = 'full', ignoreMode = false, bare = false, measureScale = 1, containerWidth = 0, viewport = { width: 1180, height: 1600 }, browserOverride = null, extraCss = '', init = null } = {}) {
	const windowed = payloadsForContainer(payloads, containerWidth);
	const byWeeks = windowed ? windowed.byWeeks : null;
	if (windowed) payloads = windowed.primary;
	const page = await (browserOverride || browser).newPage({ viewport });
	if (!browserOverride) pages.push(page);
	const errors = [];
	page.on('pageerror', (e) => errors.push('pageerror: ' + String(e)));
	page.on('console', (m) => {
		if (m.type() === 'error') errors.push('console: ' + m.text());
	});
	await page.setContent('<!doctype html><html><head><meta charset="utf-8"><style>' + THEME + extraCss + '</style></head><body><div id="root"></div></body></html>');
	/* bare：去掉 #root 的内边距，让**容器宽度 == 视口宽度**，宽度场景才好报实测值 */
	if (bare) await page.evaluate(() => document.body.classList.add('bare'));
	/* init：在加载 React/产品脚本**之前**打桩（如 navigator.canShare），模拟宿主能力差异 */
	if (init) await page.evaluate(init);
	/* measureScale：把 canvas.measureText 的宽度乘 k —— 走产品真实的「实测标签宽」路径，
	 * 用来验证极端标签宽下 x 轴仍然保留首尾两个日期（上游 verifier 用的同一招）。 */
	if (measureScale !== 1) {
		await page.evaluate((k) => {
			const proto = CanvasRenderingContext2D.prototype;
			const orig = proto.measureText;
			proto.measureText = function (t) {
				const m = orig.call(this, t);
				return { width: m.width * k };
			};
		}, measureScale);
	}
	await page.addScriptTag({ path: HARNESS + '/react.development.js' });
	await page.addScriptTag({ path: HARNESS + '/react-dom.development.js' });
	await page.evaluate(() => {
		window.__ModuleLoader__ = { load: (s) => { window.__SPEC = s; } };
	});
	await page.addScriptTag({ path: CLIENT });
	const meta = await page.evaluate(
		(cfg) => {
			const spec = window.__SPEC;
			const mod = spec.factory((name) => {
				if (name === 'react') return window.React;
				throw new Error('unexpected require: ' + name);
			});
			/* 本插件的 factory 直接 return exports 对象（不是 { exports }），两种都兼容 */
			const api = mod && typeof mod.apply === 'function' ? mod : mod.exports;
			const calls = [];
			const ctx = {
				slots: {
					inject: (name, fn) => fn(),
					register: (opts, render) => {
						window.__OPTS = opts;
						window.__RENDER = render;
						return () => {};
					},
				},
				effect: (fn) => {
					const dispose = fn();
					return () => dispose && dispose();
				},
				get: (key) =>
					key === 'remote.tokenHeatmap'
						? {
								heatmap: (q) => {
									calls.push(q);
									if (cfg.mode === 'error') return Promise.resolve({ ok: false, error: { message: '扫描失败（测试桩）' } });
									if (cfg.mode === 'empty') return Promise.resolve({ ok: true, value: JSON.parse(JSON.stringify(cfg.empty)) });
									/* 桩按 query.mode 回同口径 payload；ignoreMode = 模拟忽略 mode 的旧宿主半 */
									const key = cfg.ignoreMode ? 'day' : (q && q.mode) || 'day';
									/* 像真宿主一样**按请求的 weeks 回窗口**：否则「首帧先发 52 周」这类回归在测试里看不出来 */
									const srcMap = (cfg.payloadsByWeeks && cfg.payloadsByWeeks[q && q.weeks]) || cfg.payloads;
									const value = (srcMap && (srcMap[key] || srcMap.day)) || null;
									window.__LASTWIN = value && value.window ? { from: value.window.from, to: value.window.to, weeks: value.weeks } : null;
									return Promise.resolve({ ok: true, value: JSON.parse(JSON.stringify(value)) });
								},
							}
						: undefined,
				remote: { $mount: () => Promise.resolve({}) },
			};
			api.apply(ctx);
			/* 首帧录像：每 16ms + 每次 DOM 变动各采一次，记录「有格子时」的列数与 cell。
			 * 用来抓「先画 52 周压缩格、再闪成正确周数」这类只有真机才看得见的缺陷。 */
			window.__FRAMES = [];
			const recFrame = () => {
				try {
					const c = document.querySelector('.thm-cell[data-day]');
					if (!c) return;
					const g = document.querySelector('.thm-grid');
					const cols = g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : 0;
					const w = Math.round(c.getBoundingClientRect().width * 100) / 100;
					const last = window.__FRAMES[window.__FRAMES.length - 1];
					if (last && last.w === w && last.cols === cols) return; // 只记变化，避免刷屏
					window.__FRAMES.push({ t: Math.round(performance.now()), w, cols });
				} catch (e) {}
			};
			setInterval(recFrame, 16);
			new MutationObserver(recFrame).observe(document.getElementById('root'), { childList: true, subtree: true });
			window.__CALLS = calls;
			window.__ROOT = window.ReactDOM.createRoot(document.getElementById('root'));
			window.__ROOT.render(window.React.createElement(function () {
				return window.__RENDER();
			}));
			return {
				id: window.__OPTS && window.__OPTS.id,
				order: window.__OPTS && window.__OPTS.order,
				label: window.__OPTS && window.__OPTS.label && window.__OPTS.label(),
			};
		},
		{ payloads, payloadsByWeeks: byWeeks, empty: FIXTURE_EMPTY, mode, ignoreMode },
	);
	page.__errors = errors;
	page.__meta = meta;
	return page;
}
const inner = (page) => page.evaluate(() => document.body.innerText);
const text = (page, sel) => page.locator(sel).first().innerText();
/** 尽力等一个条件成立；超时不抛异常（让后面的断言把问题报成红灯，而不是整轮崩掉）。 */
const settle = async (page, fn, ms = 8000) => {
	try {
		await page.waitForFunction(fn, null, { timeout: ms });
		return true;
	} catch (e) {
		return false;
	}
};

/* ============================ 场景 1：v2 宿主（完整 payload） ============================ */
console.log('\n— 场景 1：完整 payload（v2 宿主半）');
const page = await mount({ payloads: MODE_PAYLOADS });
await page.waitForSelector('.thm-kpibar', { timeout: 10000 });

check('挂载成功：id / order / label 不变', page.__meta.id === 'token-heatmap' && page.__meta.order === 31 && page.__meta.label === '用量热力图', page.__meta);

/* ① 标题区 */
check('① 标题 = 用量热力图', (await text(page, '.thm-h2')) === '用量热力图');
check('① 数据来源 pill = 本地会话日志', (await text(page, '.thm-pill')) === '本地会话日志');
check('① 说明句写清口径（计费总量 / 本地时区 / 六档）', /计费总量/.test(await text(page, '.thm-intro')) && /本地时区/.test(await text(page, '.thm-intro')));
check('① 标题区只有一个 h2', (await page.locator('.thm-h2').count()) === 1);

/* ② KPI 条：5 列 + 列间细分隔线 */
const kpi = await page.evaluate(() => {
	const bar = document.querySelector('.thm-kpibar');
	const cells = [...bar.querySelectorAll('.thm-kpiCell')];
	return {
		n: cells.length,
		keys: cells.map((c) => c.dataset.kpi),
		labels: cells.map((c) => c.querySelector('.thm-kpiLabel').textContent),
		values: cells.map((c) => c.querySelector('.thm-kpiVal').textContent),
		subs: cells.map((c) => (c.querySelector('.thm-kpiSub') ? c.querySelector('.thm-kpiSub').textContent : null)),
		divider: getComputedStyle(cells[1]).borderLeftWidth,
		noDividerOnFirst: getComputedStyle(cells[0]).borderLeftWidth,
	};
});
check('② KPI 恰好 5 列', kpi.n === 5, kpi.n);
check('② 五列口径 = 累计/峰值/最长时长/当前连续/最长连续', JSON.stringify(kpi.keys) === JSON.stringify(['total', 'peak', 'span', 'streak', 'longest']), kpi.keys);
check('② 五列文案正确', JSON.stringify(kpi.labels) === JSON.stringify(['累计 Token 数', '峰值 Token 数', '最长聊天时长', '当前连续天数', '最长连续天数']), kpi.labels);
check('② 累计 = 17.8亿', kpi.values[0] === '17.8亿', kpi.values[0]);
check('② 峰值 = 10.21亿 + 峰值日副标题', kpi.values[1] === '10.21亿' && kpi.subs[1] === '峰值日 10月15日', [kpi.values[1], kpi.subs[1]]);
check('② 最长聊天时长 = 8 小时 22 分钟', kpi.values[2] === '8 小时 22 分钟', kpi.values[2]);
check('② 当前连续天数 = 6 天 / 最长 = 13 天', kpi.values[3] === '6 天' && kpi.values[4] === '13 天', kpi.values);
check('② 列间有细分隔线（首列没有）', kpi.divider !== '0px' && kpi.noDividerOnFirst === '0px', [kpi.divider, kpi.noDividerOnFirst]);

/* ③ Token 活动卡 */
check('③ 卡头 = Token 活动', (await text(page, '.thm-activity .thm-h3')) === 'Token 活动');
const seg = await page.evaluate(() => {
	const el = document.querySelector('[data-seg="mode"]');
	return { labels: [...el.querySelectorAll('button')].map((b) => b.textContent), pressed: [...el.querySelectorAll('button')].map((b) => b.getAttribute('aria-pressed')) };
});
check('③ 分段控件 = 每日 | 每周 | 累计', JSON.stringify(seg.labels) === JSON.stringify(['每日', '每周', '累计']), seg.labels);
check('③ 默认选中「每日」', JSON.stringify(seg.pressed) === JSON.stringify(['true', 'false', 'false']), seg.pressed);
check('③ 卡上带 data-mode=day', (await page.locator('.thm-activity').getAttribute('data-mode')) === 'day');

const shape = await page.evaluate(() => {
	const cells = [...document.querySelectorAll('.thm-cell[data-day]')];
	const grid = document.querySelector('.thm-grid');
	const months = document.querySelector('.thm-months');
	const gridBox = grid.getBoundingClientRect();
	const monBox = months.getBoundingClientRect();
	const cols = getComputedStyle(grid).gridTemplateColumns.split(' ').length;
	const cs = getComputedStyle(cells[0]);
	return {
		cells: cells.length,
		cols,
		rows: getComputedStyle(grid).gridTemplateRows.split(' ').length,
		monthsBelow: monBox.top >= gridBox.bottom - 1,
		monthLabels: [...months.querySelectorAll('.thm-month')].map((m) => m.textContent).filter(Boolean).length,
		cellW: Math.round(cells[0].getBoundingClientRect().width),
		radius: cs.borderTopLeftRadius,
		borderW: cs.borderTopWidth,
		borderColor: cs.borderTopColor,
	};
});
const expectCells = diffDays(FROM, TO) + 1;
check('③ 格子数 = 窗口天数（52 周 × 7 天）', shape.cells === expectCells && shape.cols === WEEKS && shape.rows === 7, shape);
check('③ 月份轴在网格下方', shape.monthsBelow === true && shape.monthLabels >= 10, shape);
check('③ 格子 ~13–15px、圆角 3–4px、描边透明', shape.cellW >= 12 && shape.cellW <= 15 && parseFloat(shape.radius) >= 3 && parseFloat(shape.radius) <= 4 && shape.borderColor === 'rgba(0, 0, 0, 0)', shape);
check('③ 今天那格带 ring（thm-today）', (await page.locator('[data-day="' + TO + '"]').getAttribute('class')).includes('thm-today'));
/* 六档图例（P1-1）：结构 = 少 [l1]…[l6] 多 —— l0「无调用」灰格移出数据阶，灰格含义写进 intro；
 * 区间文字统一 2 位有效数字；宽面板显示文字、窄面板只留 swatch（精确区间在 title / 浮层里）。 */
const legend = await page.evaluate(() => {
	const box = document.querySelector('.thm-activity .thm-legend');
	const parts = [...box.querySelectorAll('.thm-legendPart')];
	const swatches = [...box.querySelectorAll('.thm-swatch')];
	const texts = [...box.querySelectorAll('.thm-legendText')];
	const intro = document.querySelector('.thm-intro').textContent;
	return {
		parts: parts.length,
		names: parts.map((p) => p.textContent.trim()),
		swatches: swatches.map((s) => s.className.replace(/^thm-swatch\s*/, '')),
		hasL0Swatch: !!box.querySelector('.thm-l0'),
		texts: texts.map((t) => t.textContent),
		textDisplay: texts.length ? getComputedStyle(texts[0]).display : null,
		titles: parts.map((p) => p.getAttribute('title') || ''),
		introGray: /灰格/.test(intro) && /无模型调用|无调用/.test(intro),
	};
});
check('③ 图例结构 = 少 + 6 个 swatch + 多（l0 灰格已移出数据阶）', legend.parts === 8 && legend.names[0] === '少' && legend.names[7] === '多' && !legend.hasL0Swatch, legend);
check('③ 图例的 6 个 swatch 依次是第 1–6 档', JSON.stringify(legend.swatches) === JSON.stringify(['thm-l1', 'thm-l2', 'thm-l3', 'thm-l4', 'thm-l5', 'thm-l6']), legend.swatches);
check('③ 灰格含义写进 intro（不再占数据阶一格）', legend.introGray === true, legend.introGray);
check('③ 图例区间 = 2 位有效数字、两端同一套取整', legend.texts.length === 6 && legend.texts.every((t) => sigDigits(t) <= 2), legend.texts);
check(
	'③ 图例 title 与宿主 cuts 一一对应（精确区间没丢）',
	JSON.stringify(legend.titles.slice(1, 7)) === JSON.stringify(MODE_PAYLOADS.day.scale.legend.map((b) => '第 ' + b.level + ' 档：' + bandText(b) + ' tokens')),
	legend.titles,
);
check('③ 首屏不自动展开明细（版面 = 参考图 1 的 1…7 条）', (await page.locator('.thm-detail').count()) === 0);

/* 悬停浮层（参考图 4） */
await page.hover('[data-day="' + TOOLTIP_DAY + '"]');
await page.waitForSelector('.thm-tip', { timeout: 5000 });
const tip = await page.evaluate(() => {
	const el = document.querySelector('.thm-tip');
	const card = document.querySelector('.thm-activity').getBoundingClientRect();
	const box = el.getBoundingClientRect();
	return {
		day: el.querySelector('.thm-tipDay').textContent,
		meta: el.querySelector('.thm-tipMeta').textContent,
		lines: el.querySelectorAll('.thm-tipDay, .thm-tipMeta').length,
		insideX: box.left >= card.left - 1 && box.right <= card.right + 1,
		insideY: box.top >= card.top - 1 && box.bottom <= card.bottom + 1,
		pe: getComputedStyle(el).pointerEvents,
	};
});
check('③ 悬停浮层第一行 = 2026年9月24日', tip.day === '2026年9月24日', tip.day);
check('③ 悬停浮层 = 两行：第一行日期、第二行 `4.5亿 tokens · 55 轮消息`', tip.lines === 2 && tip.meta === '4.5亿 tokens · 55 轮消息', tip);
check('③ 浮层不出卡 / 不挡鼠标', tip.insideX && tip.insideY && tip.pe === 'none', tip);

/* 点击下钻 */
await page.click('[data-day="' + TOOLTIP_DAY + '"]');
await page.waitForSelector('.thm-detail', { timeout: 5000 });
const detail = await page.evaluate(() => {
	const d = document.querySelector('.thm-detail');
	return {
		head: d.querySelector('.thm-h3').textContent,
		kpis: [...d.querySelectorAll('.thm-kpi dt')].map((x) => x.textContent),
		rows: d.querySelectorAll('.thm-table tbody tr').length,
		total: d.querySelector('.thm-kpi dd').textContent,
	};
});
check('③ 点击下钻：明细标题 = 2026年9月24日', detail.head === '2026年9月24日', detail.head);
check('③ 明细保留原 KPI（计费总量=450,000,000）', detail.kpis.includes('计费总量') && detail.total === '450,000,000', detail);
check('③ 明细含 v2 的轮消息', detail.kpis.includes('轮消息'), detail.kpis);
check('③ 明细有分模型表格', detail.rows === 4, detail.rows);
await page.click('.thm-clear');
await page.waitForSelector('.thm-detail', { state: 'detached' });
check('③ 清除选择后明细收起', (await page.locator('.thm-detail').count()) === 0);

/* mode 分段控件：每周 / 累计 */
await page.click('[data-seg="mode"] [data-value="week"]');
await page.waitForSelector('.thm-activity[data-mode="week"]');
await page.waitForFunction(() => window.__CALLS.length > 1);
const weekLevels = await page.evaluate((days) => {
	/* 「同周同档」只对**有数据的日子**成立：空白天在宿主侧不出行、在页面上恒为 0 档 */
	const set = new Set(days);
	const cells = [...document.querySelectorAll('.thm-cell[data-day]')].filter((c) => set.has(c.dataset.day));
	const byWeek = {};
	for (const c of cells) {
		const d = c.dataset.day;
		const t = Date.parse(d + 'T00:00:00.000Z');
		const mon = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
		(byWeek[mon] = byWeek[mon] || []).push(c.dataset.level);
	}
	const groups = Object.values(byWeek);
	return {
		groups: groups.length,
		sameInWeek: groups.every((g) => new Set(g).size === 1),
		distinct: new Set(groups.map((g) => g[0])).size,
		peakWeek: byWeek['2026-10-12'] ? byWeek['2026-10-12'][0] : null,
		calls: window.__CALLS.slice(-1)[0],
	};
}, [...FIXTURE_DAYSET]);
check('③ 切「每周」保留同周同档（只算有数据的日子）', weekLevels.sameInWeek === true && weekLevels.groups === WEEKS, weekLevels);
check('③ 切「每周」后仍有分档（不是一片同色）', weekLevels.distinct >= 3, weekLevels.distinct);
check('③ 峰周（含 10/15）落在第 6 档', weekLevels.peakWeek === '6', weekLevels.peakWeek);
check('③ 切 mode 会带上 mode 查询参数（宿主半可复用缓存）', weekLevels.calls && weekLevels.calls.mode === 'week', weekLevels.calls);

/* B（每周）：浮层两行 = `日期 当周` / 整周（周一–周日）合计 · 该周轮消息 */
await page.waitForFunction(() => window.__CALLS.slice(-1)[0] && window.__CALLS.slice(-1)[0].mode === 'week');
await page.waitForFunction(() => document.querySelector('.thm-activity').getAttribute('aria-busy') === 'false');
await page.hover('[data-day="2026-09-30"]');
await page.waitForSelector('.thm-tip', { timeout: 5000 });
const weekTip = await page.evaluate(() => {
	const el = document.querySelector('.thm-tip');
	return { lines: el.querySelectorAll('.thm-tipDay, .thm-tipMeta').length, day: el.querySelector('.thm-tipDay').textContent, meta: el.querySelector('.thm-tipMeta').textContent, text: el.innerText };
});
const WK_DAY = '2026-09-30';
const wkRows = FIXTURE.days.filter((d) => mondayOf(d.day) === mondayOf(WK_DAY));
const wkTotal = wkRows.reduce((s2, d) => s2 + d.total, 0);
const wkRounds = wkRows.reduce((s2, d) => s2 + (d.rounds || 0), 0);
check('B 每周浮层 = 两行：`日期 当周` / `整周合计 tokens · 该周轮消息`', weekTip.lines === 2 && weekTip.day === '2026年9月30日 当周' && weekTip.meta === fmtCompact(wkTotal) + ' tokens · ' + wkRounds.toLocaleString('en-US') + ' 轮消息' && !/本周合计|窗口累计/.test(weekTip.text), { ...weekTip, wkTotal, wkRounds });
await page.mouse.move(5, 5);

await page.click('[data-seg="mode"] [data-value="cum"]');
await page.waitForSelector('.thm-activity[data-mode="cum"]');
const cum = await page.evaluate((days) => {
	const set = new Set(days);
	const all = [...document.querySelectorAll('.thm-cell[data-day]')];
	const cells = all.filter((c) => set.has(c.dataset.day)).sort((a, b) => (a.dataset.day < b.dataset.day ? -1 : 1));
	const levels = cells.map((c) => Number(c.dataset.level));
	let mono = true;
	for (let i = 1; i < levels.length; i++) if (levels[i] < levels[i - 1]) mono = false;
	const empty = all.filter((c) => !set.has(c.dataset.day));
	return { mono, last: levels[levels.length - 1], first: levels[0], emptyCount: empty.length, emptyZero: empty.every((c) => c.dataset.level === '0') };
}, [...FIXTURE_DAYSET]);
check('③ 切「累计」后档位单调不降（只算有数据的日子）', cum.mono === true, cum);
check('③ 累计口径下最后一天是第 6 档', cum.last === 6, cum);
check('③ 累计口径下窗口首日是最浅档', cum.first === 1, cum);
check('③ 累计口径下空白天仍是无用量档（0）', cum.emptyCount > 0 && cum.emptyZero === true, cum);

/* B（累计）：浮层两行 = `截至 日期 累计` / 窗口起点→该日累计 · 累计轮消息
 * 刻意偏离官方「当周累计」：录屏里 KPI 累计 25.5亿 ≠ 截至 10/24 当周累计 25.6亿，证明它是从窗口起点
 * 累加，「当周」是官方文案串了。这里用「截至 X 累计」。 */
await page.waitForFunction(() => window.__CALLS.slice(-1)[0] && window.__CALLS.slice(-1)[0].mode === 'cum');
await page.waitForFunction(() => document.querySelector('.thm-activity').getAttribute('aria-busy') === 'false');
await page.hover('[data-day="2026-09-30"]');
await page.waitForSelector('.thm-tip', { timeout: 5000 });
const cumTip = await page.evaluate(() => {
	const el = document.querySelector('.thm-tip');
	return { lines: el.querySelectorAll('.thm-tipDay, .thm-tipMeta').length, day: el.querySelector('.thm-tipDay').textContent, meta: el.querySelector('.thm-tipMeta').textContent, text: el.innerText };
});
const cumRows = FIXTURE.days.filter((d) => d.day >= FIXTURE.window.from && d.day <= '2026-09-30');
const cumTotal = cumRows.reduce((s2, d) => s2 + d.total, 0);
const cumRounds = cumRows.reduce((s2, d) => s2 + (d.rounds || 0), 0);
check('B 累计浮层 = 两行：`截至 日期 累计` / `窗口起点到该日累计 tokens · 累计轮消息`（不写「当周累计」）', cumTip.lines === 2 && cumTip.day === '截至 2026年9月30日 累计' && cumTip.meta === fmtCompact(cumTotal) + ' tokens · ' + cumRounds.toLocaleString('en-US') + ' 轮消息' && !/当周累计/.test(cumTip.text), { ...cumTip, cumTotal, cumRounds });
await page.mouse.move(5, 5);
await page.click('[data-seg="mode"] [data-value="day"]');
await page.waitForSelector('.thm-activity[data-mode="day"]');

/* B（每日空格子）：照常两行，第二行 0 tokens · 0 轮消息 */
await page.waitForFunction(() => window.__CALLS.slice(-1)[0] && window.__CALLS.slice(-1)[0].mode === 'day');
await page.waitForFunction(() => document.querySelector('.thm-activity').getAttribute('aria-busy') === 'false');
await page.hover('[data-day="2026-09-16"]');
await page.waitForSelector('.thm-tip', { timeout: 5000 });
const emptyTip = await page.evaluate(() => {
	const el = document.querySelector('.thm-tip');
	return { lines: el.querySelectorAll('.thm-tipDay, .thm-tipMeta').length, day: el.querySelector('.thm-tipDay').textContent, meta: el.querySelector('.thm-tipMeta').textContent };
});
check('B 空格子浮层 = 两行、第二行 `0 tokens · 0 轮消息`', emptyTip.lines === 2 && emptyTip.day === '2026年9月16日' && emptyTip.meta === '0 tokens · 0 轮消息', emptyTip);
await page.mouse.move(5, 5);
const hostLevels = await page.evaluate(() => {
	const cells = [...document.querySelectorAll('.thm-cell[data-day]')];
	return cells.filter((c) => c.dataset.day === '2026-10-15' || c.dataset.day === '2026-09-24').map((c) => [c.dataset.day, c.dataset.level]);
});
check('③ 回到「每日」用宿主给的 level（尖峰=6）', JSON.stringify(hostLevels) === JSON.stringify([['2026-09-24', '6'], ['2026-10-15', '6']]), hostLevels);

/* ④ 分析区间行（P1-2）：回到卡片内容轨道（0 14px）+ 标签「分析区间」+ 区间只在环形图卡头写一次 */
const rangeRow = await page.evaluate(() => {
	const row = document.querySelector('.thm-rangeRow');
	const foot = document.querySelector('.thm-footRow');
	const label = row.querySelector('.thm-rangeLabel');
	const h3 = document.querySelector('.thm-activity .thm-h3');
	const btns = [...row.querySelectorAll('[data-seg="range"] button')];
	const trendHead = document.querySelector('.thm-card[aria-label="每日 Token 趋势图"] .thm-cardHead');
	const donutHead = document.querySelector('.thm-card[aria-label="模型用量"] .thm-cardHead');
	const now = donutHead.querySelector('.thm-rangeNow');
	const cs = getComputedStyle(label);
	return {
		label: label.textContent,
		labels: btns.map((b) => b.textContent),
		pressed: btns.map((b) => b.getAttribute('aria-pressed')),
		padRow: getComputedStyle(row).paddingLeft + '/' + getComputedStyle(row).paddingRight,
		padFoot: getComputedStyle(foot).paddingLeft,
		alignDelta: Math.round(Math.abs(label.getBoundingClientRect().left - h3.getBoundingClientRect().left) * 100) / 100,
		font: parseFloat(cs.fontSize),
		weight: cs.fontWeight,
		trendHead: trendHead.textContent.trim(),
		trendH3: trendHead.querySelector('.thm-h3').textContent.trim(),
		scaleNote: trendHead.querySelector('.thm-scaleNote') ? trendHead.querySelector('.thm-scaleNote').textContent.trim() : null,
		trendHeadHasRange: /近\s*\d+\s*日/.test(trendHead.textContent),
		donutNow: now ? now.textContent : null,
		donutNowFont: now ? parseFloat(getComputedStyle(now).fontSize) : null,
		donutNowColor: now ? getComputedStyle(now).color : null,
	};
});
check('④ 分析区间行：左标签 + 近 7 日/近 30 日', rangeRow.label === '分析区间' && JSON.stringify(rangeRow.labels) === JSON.stringify(['近 7 日', '近 30 日']), rangeRow);
check('④ 默认近 7 日', JSON.stringify(rangeRow.pressed) === JSON.stringify(['true', 'false']), rangeRow.pressed);
check('④ 行内边距回到卡片内容轨道（.thm-rangeRow / .thm-footRow = 14px）', rangeRow.padRow === '14px/14px' && rangeRow.padFoot === '14px', rangeRow);
check('④ 标签与卡片标题同一条竖线（Δ ≤ 1px）', rangeRow.alignDelta <= 1, rangeRow.alignDelta);
check('④ 标签 12–13px / 600', rangeRow.font >= 12 && rangeRow.font <= 13 && rangeRow.weight === '600', { font: rangeRow.font, weight: rangeRow.weight });
check('④ 趋势卡头 = 标题 + 「对数刻度」注记（不重复「近 N 日」），区间改挂在环形图卡头（12.5px label-secondary）', !rangeRow.trendHeadHasRange && rangeRow.trendH3 === '每日 Token 趋势图' && rangeRow.scaleNote === '对数刻度' && rangeRow.donutNow === '近 7 日' && rangeRow.donutNowFont === 12.5 && rangeRow.donutNowColor === 'rgb(91, 91, 102)', rangeRow);

/* ⑤ 趋势图（对数纵轴 + 多系列平滑曲线）：几何全部从真实 path d 解析，不读实现元数据 */
const DATES7 = [...Array(7)].map((_, i) => addDays('2026-10-12', i));
/** 趋势序列的期望值：与 rangeAggregate 同源（窗口内 top-3 + 「其他」），fixture 是唯一数据源。 */
function expectedTrend(dates, rowsOverride) {
	const source = rowsOverride || FIXTURE.days;
	const rows = dates.map((d) => source.find((x) => x.day === d));
	const totals = {};
	for (const r of rows) if (r) for (const m of r.models) totals[m.model] = (totals[m.model] || 0) + m.total;
	const names = Object.keys(totals).sort((a, b) => totals[b] - totals[a]);
	const series = names.slice(0, 3).map((name) => ({ name, values: rows.map((r) => { const m = r && r.models.find((x) => x.model === name); return m ? m.total : 0; }) }));
	const rest = names.slice(3);
	if (rest.length) series.push({ name: '其他', values: rows.map((r) => (r ? rest.reduce((s, n) => { const m = r.models.find((x) => x.model === n); return s + (m ? m.total : 0); }, 0) : 0)) });
	return series;
}
const TREND7 = expectedTrend(DATES7);
const TREND_TOTAL = '每日合计';
/** 每日合计（= 所有模型之和 = days[].total）——趋势图现在只画这一条线。 */
const dailyTotalsOf = (dates, rows) =>
	dates.map((d) => {
		const r = (rows || FIXTURE.days).find((x) => x.day === d);
		return r ? r.total : 0;
	});
const TOTALS7 = dailyTotalsOf(DATES7);
const cnNum = (s) => {
	const m = /^([\d.]+)([万亿]?)$/.exec(String(s).trim());
	return m ? Number(m[1]) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1) : NaN;
};
const trend7 = await page.evaluate(() => {
	const svg = document.querySelector('.thm-trend');
	const dom = (svg.getAttribute('data-log') || '').split(',').map(Number);
	const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
	const chunks = (d) => d.match(/[MC][^MCZ]*/g) || [];
	const nums = (c) => (c.slice(1).trim().match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
	const paths = [...svg.querySelectorAll('.thm-trendLine')].map((p) => {
		const segs = chunks(p.getAttribute('d'));
		const days = (p.getAttribute('data-days') || '').split(',').map(Number);
		const pts = [];
		let ctrlOut = 0;
		let prev = null;
		for (const c of segs) {
			const n = nums(c);
			if (c[0] === 'M') {
				prev = { x: n[0], y: n[1] };
				pts.push({ x: n[0], y: n[1] });
			} else {
				const low = Math.min(prev.y, n[5]) - 0.01;
				const high = Math.max(prev.y, n[5]) + 0.01;
				if (n[1] < low || n[1] > high || n[3] < low || n[3] > high) ctrlOut++;
				prev = { x: n[4], y: n[5] };
				pts.push({ x: n[4], y: n[5] });
			}
		}
		return { series: p.getAttribute('data-series'), days, pts, segs: segs.filter((c) => c[0] === 'M').length, ctrlOut, d: p.getAttribute('d'), fill: getComputedStyle(p).fill, stroke: getComputedStyle(p).stroke, width: parseFloat(getComputedStyle(p).strokeWidth) };
	});
	const xByDay = {};
	for (const p of paths) p.pts.forEach((pt, k) => { const day = p.days[k]; (xByDay[day] = xByDay[day] || []).push(pt.x); });
	return {
		dom,
		plot,
		paths,
		pathCount: paths.length,
		pointCount: paths.reduce((s, p) => s + p.pts.length, 0),
		series: [...new Set(paths.map((p) => p.series))],
		seriesPoints: paths.reduce((m, p) => ((m[p.series] = (m[p.series] || 0) + p.pts.length), m), {}),
		segsPerSeries: paths.reduce((m, p) => ((m[p.series] = (m[p.series] || 0) + p.segs), m), {}),
		xSpread: Object.entries(xByDay).map(([day, xs]) => [Number(day), Math.round((Math.max(...xs) - Math.min(...xs)) * 1000) / 1000]),
		allInside: paths.every((p) => p.pts.every((pt) => pt.y >= plot[1] - 0.02 && pt.y <= plot[1] + plot[3] + 0.02)),
		ctrlOut: paths.reduce((s, p) => s + p.ctrlOut, 0),
		fills: [...new Set(paths.map((p) => p.fill))],
		strokes: [...new Set(paths.map((p) => p.stroke))],
		strokeWidths: [...new Set(paths.map((p) => p.width))],
		dots: svg.querySelectorAll('.thm-hoverDot').length,
		bars: svg.querySelectorAll('.thm-barSeg').length,
		breakMarks: svg.querySelectorAll('.thm-breakWave, .thm-breakNote').length,
		bridges: svg.querySelectorAll('.thm-trendBridge').length,
		grid: svg.querySelectorAll('.thm-trendGrid').length,
		ticks: (svg.getAttribute('data-ticks') || '').split(',').filter(Boolean).length,
		note: (document.querySelector('.thm-card[aria-label="每日 Token 趋势图"] .thm-scaleNote') || {}).textContent || '',
		axis: [...svg.querySelectorAll('.thm-axisY')].map((t) => t.textContent),
		axisX: [...svg.querySelectorAll('.thm-axisX')].map((t) => t.textContent),
		right: svg.querySelectorAll('.thm-axisY2').length,
		legend: [...document.querySelectorAll('.thm-card[aria-label="每日 Token 趋势图"] .thm-legend .thm-legendPart')].map((l) => l.textContent),
		hint: (document.querySelector('.thm-card[aria-label="每日 Token 趋势图"] .thm-legendHint') || {}).textContent || null,
		aria: svg.getAttribute('aria-label'),
		svgW: Number(svg.getAttribute('width')),
	};
});
const yOfLog = (v, dom, padT, plotH) =>
	padT + plotH * (1 - (Math.log10(v) - Math.log10(dom[0])) / (Math.log10(dom[1]) - Math.log10(dom[0])));
const logSamples = [
	['deepseek/deepseek-v4.1-flash', 3],
	['group/auto', 0],
	['其他', 6],
].map(([name, day]) => {
	const s = TREND7.find((x) => x.name === name);
	const v = s.values[day];
	const p = trend7.paths.find((q) => q.series === name);
	const k = p.days.indexOf(day);
	return { name, day, v, y: p.pts[k].y, want: yOfLog(v, trend7.dom, trend7.plot[1], trend7.plot[3]) };
});
check('⑤ 曲线 = 4 条（top-3 + 「其他」），系列名/顺序与环形图一致', trend7.pathCount === 4 && JSON.stringify(trend7.series) === JSON.stringify(TREND7.map((s) => s.name)), { paths: trend7.pathCount, series: trend7.series });
check('⑤ 曲线点数 = 窗口天数 × 系列数（7 天 × 4 系列 = 28；每个系列每天都有一个点）', trend7.pointCount === 28 && trend7.series.every((s) => trend7.seriesPoints[s] === 7), { points: trend7.pointCount, perSeries: trend7.seriesPoints });
check('⑤ 每条曲线只有 1 个 M（中间不断开），同一天各系列点 x 相同', trend7.paths.every((p) => (String(p.d).match(/M/g) || []).length === 1) && trend7.xSpread.every(([, d]) => d <= 0.001), { m: trend7.paths.map((p) => (String(p.d).match(/M/g) || []).length), xSpread: trend7.xSpread });
check('⑤ 每条曲线的左右两端都到绘图区左右边界（不是从中间才开始）', trend7.paths.every((p) => Math.abs(p.pts[0].x - trend7.plot[0]) <= 0.02 && Math.abs(p.pts[p.pts.length - 1].x - (trend7.plot[0] + trend7.plot[2])) <= 0.02), trend7.paths.map((p) => [p.series, Math.round(p.pts[0].x), Math.round(p.pts[p.pts.length - 1].x), Math.round(trend7.plot[0] + trend7.plot[2])]));
check('⑤ 所有点 y 落在绘图区内', trend7.allInside === true, { plot: trend7.plot, dom: trend7.dom });
check('⑤ y 与 log10(value) 线性对应（3 个样本：峰值模型 / 最小系列 / 「其他」；偏差 ≤ 0.02px）', logSamples.every((s) => Math.abs(s.y - s.want) <= 0.02), logSamples.map((s) => [s.name, s.day, s.v, Math.round(s.y * 100) / 100, Math.round(s.want * 100) / 100]));
check('⑤ 平滑曲线不 overshoot：所有 C 控制点都夹在相邻端点区间内（0 个越界）', trend7.ctrlOut === 0, { ctrlOut: trend7.ctrlOut });
check('⑤ 曲线无面积填充（fill:none）、线宽 2px、4 种颜色两两不同', JSON.stringify(trend7.fills) === JSON.stringify(['none']) && JSON.stringify(trend7.strokeWidths) === JSON.stringify([2]) && trend7.strokes.length === 4 && trend7.strokes[0] === 'rgb(59, 130, 246)', { fills: trend7.fills, widths: trend7.strokeWidths, strokes: trend7.strokes });
check('⑤ 静止时没有任何圆点（圆点只在悬停时出现），也没有柱/断轴/虚线桥残留', trend7.dots === 0 && trend7.bars === 0 && trend7.breakMarks === 0 && trend7.bridges === 0, { dots: trend7.dots, bars: trend7.bars, breaks: trend7.breakMarks, bridges: trend7.bridges });
check('⑤ 左侧纵轴刻度文字已删（.thm-axisY = 0 个），「对数刻度」注记仍在', trend7.axis.length === 0 && /对数刻度/.test(trend7.note || ''), { yLabels: trend7.axis.length });
check('⑤ 对数 domain：下限 = 最小非零值向下取整到整十次幂（13.5万 → 10万），上限 = ≥ 峰值/0.95 的 nice 值（10.21亿 → 20亿）', trend7.dom[0] === 1e5 && trend7.dom[1] === 2e9, trend7.dom);
check('⑤ 横向虚线网格保留（≥3 条、横跨绘图区）且没有右侧百分比轴', trend7.grid >= 3 && trend7.grid === trend7.ticks && trend7.right === 0, { grid: trend7.grid, ticks: trend7.ticks, right: trend7.right });
check('⑤ 底部日期轴 = 近 7 日 7 个刻度', trend7.axisX.length === 7 && trend7.axisX[6] === '10月18日', trend7.axisX);
check('⑤ 图例 = 4 个系列（短名）、不含「缓存命中率」', trend7.legend.length === 4 && !trend7.legend.includes('缓存命中率'), trend7.legend);
check('⑤ 绘图区贴齐卡片内容左缘（padL = 0）+ 宽高比 ≈ 4.3:1（4.0–4.6）；aria 写明「按模型曲线 · 对数刻度」', trend7.plot[0] === 0 && (() => { const r = trend7.plot[2] / trend7.plot[3]; return r >= 4.0 && r <= 4.6; })() && /曲线/.test(trend7.aria) && /对数刻度/.test(trend7.aria), { plot: trend7.plot, ratio: Math.round((trend7.plot[2] / trend7.plot[3]) * 100) / 100, aria: trend7.aria });


await page.locator('.thm-trend').hover({ position: { x: 700, y: 100 } });
await page.waitForSelector('.thm-trendTip', { timeout: 5000 });
const trendTip = await page.evaluate(() => {
	const el = document.querySelector('.thm-trendTip');
	const wrap = el.parentElement.getBoundingClientRect();
	const box = el.getBoundingClientRect();
	return {
		rows: [...el.querySelectorAll('.thm-trendRow')].map((r) => r.textContent),
		rowTitles: [...el.querySelectorAll('.thm-trendRow .thm-trendRowName')].map((r) => r.getAttribute('title') || ''),
		day: el.querySelector('.thm-trendTipDay').textContent,
		bar: document.querySelectorAll('.thm-hoverGuide').length,
		inside: box.left >= wrap.left - 1 && box.right <= wrap.right + 1,
	};
});
check('⑤ 悬停出现竖线 + 浮层', trendTip.bar === 1 && trendTip.rows.length >= 1, trendTip);
check('⑤ 浮层写清展示名（去公共前缀）+ 值（全名在 title）', /tokens$/.test(trendTip.rows[0]) && trendTip.rows[0].indexOf('v4.1-flash') >= 0 && trendTip.rowTitles[0].indexOf('deepseek/deepseek-v4.1-flash') >= 0, { row: trendTip.rows[0], title: trendTip.rowTitles[0] });
check('⑤ 浮层带当天日期且不出图', /^\d{4}年\d{1,2}月\d{1,2}日$/.test(trendTip.day) && trendTip.inside, trendTip);
await page.mouse.move(5, 5);
await page.waitForSelector('.thm-trendTip', { state: 'detached' });

/* ④续：切近 30 日 —— 纯前端聚合，不该再打远端 */
const callsBeforeRange = await page.evaluate(() => window.__CALLS.length);
await page.click('[data-seg="range"] [data-value="30"]');
await page.waitForFunction(() => {
	const t = document.querySelector('.thm-trend .thm-axisX');
	return t && t.textContent === '9月19日';
});
/* 等 7/30 过渡（280ms）结束：图例/x 轴的新旧两层在过渡期内并存，几何断言要在终态上量 */
await page.waitForTimeout(420);
const after30 = await page.evaluate(() => ({
	axis: [...document.querySelectorAll('.thm-trend .thm-axisX')].map((t) => t.textContent),
	labels: window.__CALLS.length,
	scrollW: document.querySelector('.thm-scroll').scrollWidth,
	clientW: document.querySelector('.thm-scroll').clientWidth,
	donutNow: (document.querySelector('.thm-card[aria-label="模型用量"] .thm-rangeNow') || {}).textContent || null,
	paths: document.querySelectorAll('.thm-trend .thm-trendLine').length,
	scaleNote: (document.querySelector('.thm-card[aria-label="每日 Token 趋势图"] .thm-scaleNote') || {}).textContent || null,
	breakMarks: document.querySelectorAll('.thm-trend .thm-breakWave, .thm-trend .thm-breakNote').length,
}));
check('④ 切近 30 日：横轴等距抽稀（端点是 9月19日/10月18日）', after30.axis.length >= 4 && after30.axis.length <= 15 && after30.axis[0] === '9月19日' && after30.axis[after30.axis.length - 1] === '10月18日', after30.axis);
check('④ 切近 30 日不打远端（区间聚合在浏览器半）', after30.labels === callsBeforeRange, [callsBeforeRange, after30.labels]);
check('④ 切近 30 日后环形图卡头的区间跟着变', after30.donutNow === '近 30 日', after30.donutNow);
/* 30 日窗口同样是对数轴：1 条合计曲线（每天都有量、段数 1）+ 卡头注记不变，旧断轴标记必须为 0 */
check('④ 近 30 日仍是对数刻度：4 条模型曲线、注记在、旧断轴标记 0 处', after30.paths === 4 && after30.scaleNote === '对数刻度' && after30.breakMarks === 0, { paths: after30.paths, note: after30.scaleNote, breaks: after30.breakMarks });
const axis30 = await page.evaluate(() => {
	const xs = [...document.querySelectorAll('.thm-trend .thm-axisX')];
	const rects = xs.map((t) => t.getBoundingClientRect());
	let overlap = 0;
	for (let i = 1; i < rects.length; i++) if (rects[i].left < rects[i - 1].right - 1) overlap++;
	const svgBox = document.querySelector('.thm-trend').getBoundingClientRect();
	const g = document.querySelector('.thm-trendGrid');
	const left = svgBox.left + Number(g.getAttribute('x1'));
	const right = svgBox.left + Number(g.getAttribute('x2'));
	const lines = [...document.querySelectorAll('.thm-trendGrid')];
	const plotW = Math.max(...lines.map((l) => Number(l.getAttribute('x2')))) - Math.min(...lines.map((l) => Number(l.getAttribute('x1'))));
	/* 相邻标签的**中心距**（等距判据）；端点贴边所以首/末两段的中心距会少半个标签宽（±1 step 容差） */
	const centers = rects.map((b) => b.left + b.width / 2);
	const gaps = centers.slice(1).map((c, i) => Math.round((c - centers[i]) * 100) / 100);
	return {
		n: xs.length, overlap,
		inside: rects.every((b) => b.left >= left - 1.5 && b.right <= right + 1.5),
		first: xs[0].textContent,
		last: xs[xs.length - 1].textContent,
		plotW: Math.round(plotW),
		labelW: Math.round(Math.max(...rects.map((b) => b.width))),
		days: 30,
		gaps,
	};
});
check('④ 近 30 日：日期抽稀后不重叠、首尾不裁、端点是 9月19日/10月18日', axis30.overlap === 0 && axis30.inside === true && axis30.first === '9月19日' && axis30.last === '10月18日', axis30);
/* 等距判据（P1-6）：抽稀后的下标必须正好是 stride 序列（首尾保留 + 末位冲突丢倒数第二个），
 * 相邻中心距必须全部落在 ±1 step 内。旧版贪心会给出 9/21/22/23/25… 这种忽宽忽窄的序列。 */
const dates30 = [...Array(30)].map((_, i) => addDays('2026-09-19', i));
const picks30 = expectedAxisPicks(30, axis30.plotW, axis30.labelW);
const wantAxis30 = picks30.map((i) => Number(dates30[i].slice(5, 7)) + '月' + Number(dates30[i].slice(8, 10)) + '日');
const step30 = axis30.plotW / 29;
const uni30 = axisUniform(axis30.gaps, step30, axis30.labelW);
check('④ 近 30 日：标签 = 等距 stride 序列（首尾保留、末位冲突丢倒数第二个）', JSON.stringify(after30.axis) === JSON.stringify(wantAxis30), { got: after30.axis, want: wantAxis30, picks: picks30 });
check('④ 近 30 日：相邻标签等距（中段 = stride·step ±1.5px；首末段贴边少/多半个标签宽）', uni30.ok, { ...uni30, step: Math.round(step30 * 100) / 100 });
check('④ 热力图可横向滚动（52 周窗口）', after30.scrollW >= after30.clientW, after30);

/* ⑥ 模型用量环形图 */
const donut = await page.evaluate(() => {
	const card = document.querySelector('.thm-card[aria-label="模型用量"]');
	const segs = card.querySelectorAll('.thm-donutSeg');
	const rows = [...card.querySelectorAll('.thm-modelRow')];
	const track = card.querySelector('.thm-donutTrack');
	return {
		segs: segs.length,
		center: card.querySelector('.thm-donutVal').textContent,
		unit: card.querySelector('.thm-donutUnit').textContent,
		names: rows.map((r) => r.querySelector('.thm-modelName').textContent),
		pcts: rows.map((r) => r.querySelector('.thm-modelPct').textContent),
		vals: rows.map((r) => r.querySelector('.thm-modelVal').textContent),
		firstStroke: getComputedStyle(segs[0]).stroke,
		hasTrack: !!track,
		svgRotate: segs[0].getAttribute('transform'),
	};
});
check('⑥ 环形图有 4 段（3 模型 + 其他）+ 底环', donut.segs === 4 && donut.hasTrack, donut);
check('⑥ 环心显示区间总量 + tokens', /亿|万/.test(donut.center) && donut.unit === 'tokens', [donut.center, donut.unit]);
check('⑥ 右侧列表：色点 + 模型名 + 占比 + token 数', donut.names.length === 4 && donut.names[3] === '其他' && /^\d+(\.\d)?%$/.test(donut.pcts[0]) && /tokens$/.test(donut.vals[0]), donut);
const pctSum = donut.pcts.reduce((s, p) => s + parseFloat(p), 0);
check('⑥ 占比合计 ≈ 100%', Math.abs(pctSum - 100) < 0.6, pctSum);
check('⑥ 首段色 = 固定数据色板蓝 #3b82f6', donut.firstStroke === 'rgb(59, 130, 246)', donut.firstStroke);
/* 用户反馈的回归点：热力图整条色阶必须是**蓝**，不能跟品牌色（真宿主品牌色是单色深灰）。 */
const palette = await page.evaluate(() => {
	/* Chrome 对 color-mix() 的结果按 `rgb(0.64 0.76 0.95)`（0–1 浮点）序列化，普通色按 `rgb(59,130,246)`；
	 * 这里统一归一到 0–255，否则比较会错位。 */
	const rgb = (el, prop) => {
		const nums = (getComputedStyle(el)[prop].match(/[\d.]+/g) || []).slice(0, 3).map(Number);
		const scale = nums.length === 3 && nums.every((n) => n <= 1) ? 255 : 1;
		return nums.map((n) => Math.round(n * scale));
	};
	/* 蓝主导 = b 最大 **且** 领先至少 20（近中性灰 rgb(232,232,234) 这种「b 大 2」必须判否，
	 * 否则单色主题下这条断言会假通过）。 */
	const blue = (a) => a[2] > a[0] && a[2] > a[1] && a[2] - Math.max(a[0], a[1]) >= 20;
	const deep = rgb(document.querySelector('.thm-cell[data-level="6"]'), 'backgroundColor');
	const mid = rgb(document.querySelector('.thm-cell[data-level="3"]'), 'backgroundColor');
	const legend = rgb(document.querySelector('.thm-legend .thm-l6'), 'backgroundColor');
	const series = rgb(document.querySelector('.thm-donutSeg'), 'stroke');
	return {
		deep, mid, legend, series,
		brand: getComputedStyle(document.documentElement).getPropertyValue('--dsw-alias-brand-primary').trim(),
		ok: blue(deep) && blue(mid) && blue(legend) && blue(series),
		selfTest: !blue([232, 232, 234]) && !blue([43, 43, 43]) && blue([59, 130, 246]),
	};
});
check('色板：最深档/中间档/图例/系列色都是蓝主导（b 最大且领先 ≥20），与品牌色无关', palette.ok && palette.brand === '#2b2b2b', palette);
check('蓝主导判定本身有牙齿（近中性灰/纯灰必须判否）', palette.selfTest === true, palette);
check('⑥ 段从 12 点方向起画', /rotate\(-90 /.test(donut.svgRotate || ''), donut.svgRotate);

/* ⑤/⑥ 系列一致性（P0-3）：趋势图与环形图必须是同一套 top-3 + 灰「其他」，且同一模型同一种颜色。 */
const seriesMap = await page.evaluate(() => {
	const card = (label) => document.querySelector('.thm-card[aria-label="' + label + '"]');
	const norm = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map((x) => Math.round(Number(x)));
	const trend = [...card('每日 Token 趋势图').querySelectorAll('.thm-legend .thm-legendPart')].map((p) => ({
		name: p.textContent.trim(),
		color: norm(getComputedStyle(p.querySelector('.thm-dot')).backgroundColor),
	}));
	const donutRows = [...card('模型用量').querySelectorAll('.thm-modelRow')].map((r) => ({
		name: r.querySelector('.thm-modelName').textContent.trim(),
		color: norm(getComputedStyle(r.querySelector('.thm-dot')).backgroundColor),
	}));
	const segColors = [...card('模型用量').querySelectorAll('.thm-donutSeg')].map((s) => norm(getComputedStyle(s).stroke));
	return { trend, donutRows, segColors };
});
check(
	'⑤/⑥ 两张图的 name → color 映射完全一致（同名同色、同序）',
	seriesMap.trend.length === 4 && JSON.stringify(seriesMap.trend) === JSON.stringify(seriesMap.donutRows),
	seriesMap,
);
check(
	'⑥ 「其他」= 中性灰（切片/圆点/图表同色，不再抢占真实模型的橙色）',
	seriesMap.donutRows[3].name === '其他' &&
		seriesMap.donutRows[3].color.every((v) => Math.abs(v - 154) <= 2) &&
		hslSat(seriesMap.donutRows[3].color) <= 0.03 &&
		JSON.stringify(seriesMap.segColors[3]) === JSON.stringify(seriesMap.donutRows[3].color),
	{ other: seriesMap.donutRows[3], segColors: seriesMap.segColors },
);

/* ⑦ 底部：刷新 + 扫描统计小字 */
const foot = await page.evaluate(() => ({
	text: document.querySelector('.thm-foot').textContent,
	btn: document.querySelector('.thm-refresh').textContent,
	align: getComputedStyle(document.querySelector('.thm-footRow')).justifyContent,
}));
check('⑦ 扫描小字含文件数/调用数/路径', /扫描 47 个会话日志/.test(foot.text) && /只读本地/.test(foot.text), foot.text);
check('⑦ 右下有刷新按钮', foot.btn.includes('刷新') && foot.align === 'space-between', foot);
const callsBeforeRefresh = await page.evaluate(() => window.__CALLS.length);
await page.click('.thm-refresh');
await page.waitForFunction((n) => window.__CALLS.length > n, callsBeforeRefresh);
const lastCall = await page.evaluate(() => window.__CALLS.slice(-1)[0]);
check('⑦ 刷新按钮带 refresh:true 重查', lastCall.refresh === true, lastCall);

/* 无 NaN / undefined 文案 */
const bodyText = await inner(page);
check('全页无 NaN/undefined/null 文案', !/NaN|undefined|Infinity/.test(bodyText), bodyText.match(/NaN|undefined|Infinity/g));

/* 截图留证（先切回参考图用的近 7 日） */
await page.click('[data-seg="range"] [data-value="7"]');
await page.waitForFunction(() => {
	const t = document.querySelector('.thm-trend .thm-axisX');
	return t && t.textContent === '10月12日';
});
await page.waitForTimeout(420); // 等过渡结束再截图（否则会截到 crossfade 中间态）
await page.locator('.thm-root').screenshot({ path: SHOTS + 'ui-stats-heatmap.png' });
await page.hover('[data-day="' + TOOLTIP_DAY + '"]');
await page.waitForSelector('.thm-tip');
await page.locator('.thm-activity').screenshot({ path: SHOTS + 'ui-heatmap-tooltip.png' });
await page.mouse.move(5, 5);
await page.locator('.thm-card[aria-label="每日 Token 趋势图"]').scrollIntoViewIfNeeded();
await page.screenshot({ path: SHOTS + 'ui-trend-donut.png' });
await page.locator('.thm-trend').hover({ position: { x: 436, y: 90 } });
await page.waitForSelector('.thm-trendTip');
await page.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-tooltip.png' });
check('场景 1 全程无 pageerror / console.error', page.__errors.length === 0, page.__errors);

/* ============================ 场景 2：v1 宿主（缺 allTime / rounds / mode） ============================ */
console.log('\n— 场景 2：v1 宿主半（旧 payload，防御式降级；桩也忽略 mode）');
const legacy = await mount({ payloads: { day: FIXTURE_LEGACY }, ignoreMode: true });
await legacy.waitForSelector('.thm-kpibar', { timeout: 10000 });
const v1 = await legacy.evaluate(() => ({
	kpis: [...document.querySelectorAll('.thm-kpiVal')].map((v) => v.textContent),
	subs: document.querySelectorAll('.thm-kpiSub').length,
	cells: document.querySelectorAll('.thm-cell[data-day]').length,
	bands: new Set([...document.querySelectorAll('.thm-cell[data-day]')].map((c) => c.dataset.level)).size,
	trend: document.querySelectorAll('.thm-trendLine').length,
	donut: document.querySelectorAll('.thm-donutSeg').length,
	text: document.body.innerText,
}));
check('v1：5 列 KPI 全部降级成「—」且无副标题', v1.kpis.length === 5 && v1.kpis.every((v) => v === '—') && v1.subs === 0, v1.kpis);
check('v1：热力图照常渲染且 0 档 + 六档齐全', v1.cells === expectCells && v1.bands === 7, v1);
check('v1：趋势图（4 条模型曲线）/ 环形图照常（用 days[].models 聚合）', v1.trend === 4 && v1.donut === 4, [v1.trend, v1.donut]);
check('v1：全页无 NaN/undefined', !/NaN|undefined|Infinity/.test(v1.text));
await legacy.hover('[data-day="' + TOOLTIP_DAY + '"]');
await legacy.waitForSelector('.thm-tip');
const v1tip = await legacy.evaluate(() => document.querySelector('.thm-tip').innerText);
check('v1：浮层缺 rounds 时只显示 tokens（不出现 undefined）', v1tip.includes('4.5亿 tokens') && !v1tip.includes('轮消息'), v1tip);
await legacy.click('[data-day="' + TOOLTIP_DAY + '"]');
await legacy.waitForSelector('.thm-detail');
check('v1：明细不出现空的「轮消息」项', !(await legacy.evaluate(() => [...document.querySelectorAll('.thm-detail .thm-kpi dt')].map((d) => d.textContent))).includes('轮消息'));
check('场景 2 无 pageerror / console.error', legacy.__errors.length === 0, legacy.__errors);

/* ============================ 场景 3：空数据 ============================ */
console.log('\n— 场景 3：窗口内没有任何用量');
const empty = await mount({ mode: 'empty' });
await empty.waitForSelector('.thm-kpibar', { timeout: 10000 });
const emptyView = await empty.evaluate(() => ({
	cells: document.querySelectorAll('.thm-cell[data-day]').length,
	status: [...document.querySelectorAll('.thm-status')].map((s) => s.textContent),
	kpis: [...document.querySelectorAll('.thm-kpiVal')].map((v) => v.textContent),
	donutSegs: document.querySelectorAll('.thm-donutSeg').length,
	axisParts: document.querySelectorAll('.thm-trend .thm-axisX, .thm-trend .thm-axisY').length,
	center: document.querySelector('.thm-donutVal').textContent,
	text: document.body.innerText,
}));
check('空数据：格子仍在（全 0 档）', emptyView.cells === expectCells, emptyView.cells);
check('空数据：热力图卡 / 趋势卡 / 环形图都有落点', emptyView.status.some((s) => s.includes('还没有任何用量记录')) && emptyView.status.some((s) => s.includes('该区间没有用量记录')) && emptyView.status.some((s) => s.includes('没有模型用量记录')), emptyView.status);
check('空数据：环心是 0 而不是 NaN', emptyView.center === '0' && emptyView.donutSegs === 0, [emptyView.center, emptyView.donutSegs]);
check('空数据：无 NaN/undefined', !/NaN|undefined|Infinity/.test(emptyView.text));
check('空数据：趋势图不画空白坐标轴，只给一句说明', emptyView.axisParts === 0 && emptyView.status.some((s) => s.includes('该区间没有用量记录')), emptyView.axisParts);
check('场景 3 无 pageerror / console.error', empty.__errors.length === 0, empty.__errors);

/* ============================ 场景 4：失败态 ============================ */
console.log('\n— 场景 4：远端失败');
const fail = await mount({ mode: 'error' });
await fail.waitForSelector('[role="alert"]', { timeout: 10000 });
const failView = await fail.evaluate(() => ({
	alert: document.querySelector('[role="alert"]').textContent,
	retry: !!document.querySelector('.thm-retry'),
	hasKpi: !!document.querySelector('.thm-kpibar'),
	calls: window.__CALLS.length,
}));
check('失败态：role=alert 带原因', failView.alert.includes('读取用量失败') && failView.alert.includes('扫描失败（测试桩）'), failView.alert);
check('失败态：保留重试按钮、不渲染 KPI 条', failView.retry === true && failView.hasKpi === false, failView);
await fail.click('.thm-retry');
await fail.waitForFunction((n) => window.__CALLS.length > n, failView.calls);
check('失败态：重试会重新发起远端调用', (await fail.evaluate(() => window.__CALLS.length)) > failView.calls);
check('场景 4 无 pageerror / console.error', fail.__errors.length === 0, fail.__errors);

/* ============================ 场景 5：真宿主半 → 真浏览器半（联调） ============================ */
console.log('\n— 场景 5：真宿主半（src/cordis.js）产出的 payload');
let realDay = null;
let realWeek = null;
let realPayloads = null;
try {
	const host = await import('../src/cordis.js');
	const svc = new host.TokenHeatmapService({ reflect: { provide() {} }, logger: {} }, { weeks: 52, ttlMs: 0 });
	const base = { weeks: 52, tzOffsetMinutes: -new Date().getTimezoneOffset() };
	realPayloads = {};
	for (const m of ['day', 'week', 'cum']) realPayloads[m] = await svc.heatmap(Object.assign({}, base, { mode: m }));
	realDay = realPayloads.day;
	realWeek = realPayloads.week; // 契约 §1 性能硬要求：暖缓存换 mode 不得重新解压
	console.log(
		'  info 真 payload：days=' + realDay.days.length +
		' mode=' + realDay.mode +
		' allTime=' + (realDay.allTime ? '有' : '缺') +
		' rounds=' + (realDay.days[0] && realDay.days[0].rounds !== undefined ? '有' : '缺') +
		' scaleMode=' + realDay.scale.mode +
		' 暖缓存换 mode reusedFiles/files=' + realWeek.stats.reusedFiles + '/' + realWeek.stats.files,
	);
} catch (e) {
	console.log('  info 真宿主半不可用，跳过联调：' + String((e && e.message) || e));
}
if (realDay && realDay.days && realDay.days.length > 0 && realDay.window && realDay.window.from) {
	const real = await mount({ payloads: realPayloads });
	await real.waitForSelector('.thm-kpibar', { timeout: 20000 });
	const realView = await real.evaluate(() => ({
		kpis: [...document.querySelectorAll('.thm-kpiVal')].map((v) => v.textContent),
		subs: [...document.querySelectorAll('.thm-kpiSub')].map((v) => v.textContent),
		cells: document.querySelectorAll('.thm-cell[data-day]').length,
		levels: new Set([...document.querySelectorAll('.thm-cell[data-day]')].map((c) => c.dataset.level)).size,
		trend: document.querySelectorAll('.thm-trendLine').length,
		donut: document.querySelectorAll('.thm-donutSeg').length,
		center: document.querySelector('.thm-donutVal').textContent,
		text: document.body.innerText,
	}));
	check('联调：真 payload 下 5 列 KPI 全有真值（allTime 已在线上）', realView.kpis.length === 5 && realView.kpis.every((v) => v !== '—'), realView.kpis);
	check('联调：副标题是真峰值日', realView.subs.length === 1 && /^峰值日 \d{1,2}月\d{1,2}日$/.test(realView.subs[0]), realView.subs);
	check('联调：格子数 = 真窗口天数', realView.cells === diffDays(realDay.window.from, realDay.window.to) + 1, [realView.cells, realDay.window]);
	check('联调：真数据有多档深浅', realView.levels >= 4, realView.levels);
	check('联调：趋势图曲线 / 环形图用真 days[].models 聚合', realView.trend >= 1 && realView.donut >= 1 && realView.center !== '0', realView);
	check('联调：全页无 NaN/undefined', !/NaN|undefined|Infinity/.test(realView.text));

	const lastDataDay = realDay.days[realDay.days.length - 1].day;
	await real.hover('[data-day="' + lastDataDay + '"]');
	await real.waitForSelector('.thm-tip', { timeout: 5000 });
	const realTip = await real.evaluate(() => document.querySelector('.thm-tip').innerText);
	check('联调：真 rounds 出现在浮层（X 轮消息）', /轮消息/.test(realTip) && /tokens/.test(realTip), realTip);

	if (realWeek) {
		const hostLevels = {};
		for (const d of realWeek.days) hostLevels[d.day] = String(d.level);
		await real.click('[data-seg="mode"] [data-value="week"]');
		await real.waitForFunction(() => document.querySelector('.thm-activity[data-mode="week"]'));
		await real.waitForFunction(() => window.__CALLS.length > 1, null, { timeout: 15000 });
		const cmp = await real.evaluate((arg) => {
			const set = new Set(arg.days);
			const cells = [...document.querySelectorAll('.thm-cell[data-day]')].filter((c) => set.has(c.dataset.day));
			const bad = cells.filter((c) => arg.map[c.dataset.day] !== undefined && c.dataset.level !== arg.map[c.dataset.day]);
			const byWeek = {};
			for (const c of cells) {
				const t = Date.parse(c.dataset.day + 'T00:00:00.000Z');
				const mon = new Date(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000).toISOString().slice(0, 10);
				(byWeek[mon] = byWeek[mon] || []).push(c.dataset.level);
			}
			return { bad: bad.slice(0, 4).map((c) => [c.dataset.day, c.dataset.level, arg.map[c.dataset.day]]), sameInWeek: Object.values(byWeek).every((g) => new Set(g).size === 1) };
		}, { map: hostLevels, days: realDay.days.map((d) => d.day) });
		check('联调：切「每周」后档位与宿主半给的 level 逐格一致', cmp.bad.length === 0, cmp.bad);
		check('联调：每周口径下有数据的日子同周同档', cmp.sameInWeek === true, cmp);
		await real.click('[data-seg="mode"] [data-value="day"]');
		await real.waitForFunction(() => document.querySelector('.thm-activity[data-mode="day"]'));
	}
	await real.mouse.move(5, 5);
	await real.locator('.thm-root').screenshot({ path: SHOTS + 'ui-real-host.png' });
	check('联调：全程无 pageerror / console.error', real.__errors.length === 0, real.__errors);
} else {
	console.log('  info 本机窗口内没有用量数据，跳过联调场景（不算失败）');
}

/* ============================ 场景 6：旧宿主半忽略 mode → 客户端降级自算 ============================ */
console.log('\n— 场景 6：桩忽略 query.mode（旧宿主半），客户端必须按宿主口径自算');
if (!hostScan) {
	console.log('  info 无法 import src/scan.js，跳过降级口径断言');
} else {
	const old = await mount({ payloads: { day: FIXTURE }, ignoreMode: true });
	await old.waitForSelector('.thm-kpibar', { timeout: 10000 });
	const allCells = (map) =>
		old.evaluate((m) => {
			const cells = [...document.querySelectorAll('.thm-cell[data-day]')];
			const bad = cells.filter((c) => m[c.dataset.day] !== undefined && c.dataset.level !== m[c.dataset.day]);
			return { badCount: bad.length, bad: bad.slice(0, 6).map((c) => [c.dataset.day, c.dataset.level, m[c.dataset.day]]) };
		}, map);
	check('降级：每日口径直接采用宿主给的 level', (await allCells(hostLevelsOf(FIXTURE, 'day').levels)).badCount === 0);

	/* 每周：期望值 = 宿主算法（src/scan.js modeValues over「有数据的日子」） */
	const expectWeek = hostLevelsOf(FIXTURE, 'week');
	await old.click('[data-seg="mode"] [data-value="week"]');
	await old.waitForFunction(() => document.querySelector('.thm-activity[data-mode="week"]'));
	await old.waitForFunction(() => window.__CALLS.length > 1, null, { timeout: 10000 });
	const degWeek = await allCells(expectWeek.levels);
	check('降级：每周档位仍与宿主口径逐格一致（这条能失败）', degWeek.badCount === 0, degWeek);

	/* 反例口径（修复前的「窗口内每一天」取样）必须真的不同，证明上面那条不是空转 */
	const wrongWeek = windowWideWeekLevels(FIXTURE);
	const diff = FIXTURE.days.filter((d) => wrongWeek[d.day] !== expectWeek.levels[d.day]);
	check('降级：两种取样口径确实不同（证明上面那条能失败）', diff.length > 0, { diffCount: diff.length, sample: diff.slice(0, 4).map((d) => [d.day, wrongWeek[d.day], expectWeek.levels[d.day]]) });

	/* 累计：同样对齐，且空白天不能给分位数多塞样本 */
	const expectCum = hostLevelsOf(FIXTURE, 'cum');
	await old.click('[data-seg="mode"] [data-value="cum"]');
	await old.waitForFunction(() => document.querySelector('.thm-activity[data-mode="cum"]'));
	const degCum = await allCells(expectCum.levels);
	check('降级：累计档位与宿主口径逐格一致', degCum.badCount === 0, degCum);
	check(
		'降级：窗口内空白天仍是无用量档（0）',
		(await old.evaluate((days) => {
			const set = new Set(days);
			const empty = [...document.querySelectorAll('.thm-cell[data-day]')].filter((c) => !set.has(c.dataset.day));
			return empty.length > 0 && empty.every((c) => c.dataset.level === '0');
		}, [...FIXTURE_DAYSET])) === true,
	);
	check(
		'降级：图例区间与宿主 cuts 一致',
		await old.evaluate((want) => {
			const titles = [...document.querySelectorAll('.thm-activity .thm-legend .thm-legendPart')].map((p) => p.getAttribute('title') || '');
			return want.every((t) => titles.includes(t));
		}, expectCum.legend.map((b) => '第 ' + b.level + ' 档：' + bandText(b) + ' tokens')),
	);
	check('场景 6 无 pageerror / console.error', old.__errors.length === 0, old.__errors);
}

/* ============================ 场景 7：宽度鲁棒性 ============================ */
console.log('\n— 场景 7：宽度鲁棒性 380 / 420 / 500 / 560 / 662 / 720 / 860 / 1000 / 1141 / 1200（等比缩放，不允许内部横滚）');
const WIDTHS = [380, 420, 500, 560, 662, 720, 860, 1000, 1141, 1200];
/* 近 7 日 fixture 的日期串（等距抽稀的期望值按它算） */
const NEAR7 = [...Array(7)].map((_, i) => addDays('2026-10-12', i));
const fmtAxisDay = (day) => Number(day.slice(5, 7)) + '月' + Number(day.slice(8, 10)) + '日';
const widthReport = [];
for (const w of WIDTHS) {
	const p = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: w, viewport: { width: w, height: 1500 } });
	await p.waitForSelector('.thm-kpibar', { timeout: 15000 });
	/* 热力图窗口按容器宽自适应：等防抖 + 重新请求落地 ——
	 * 判据是「格子 ≥10.5px 且最后一次请求的 weeks == 画出来的列数」（状态与载荷一致） */
	const ready7 = await settle(p, () => {
		const c = document.querySelector('.thm-cell[data-day]');
		const g = document.querySelector('.thm-grid');
		if (!c || !g || c.getBoundingClientRect().width < 10.4) return false;
		const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
		const calls = window.__CALLS;
		return cols > 0 && calls.length > 0 && calls[calls.length - 1].weeks === cols;
	}, 12000);
	if (!ready7) {
		console.log('  debug settle-fail w=' + w + ' ' + JSON.stringify(await p.evaluate(() => {
			const c = document.querySelector('.thm-cell[data-day]');
			const g = document.querySelector('.thm-grid');
			const s2 = document.querySelector('.thm-scroll');
			return { cells: document.querySelectorAll('.thm-cell[data-day]').length, cols: g ? getComputedStyle(g).gridTemplateColumns.split(' ').length : null, cellW: c ? Math.round(c.getBoundingClientRect().width * 100) / 100 : null, calls: window.__CALLS.map((x) => x.weeks), clientW: s2 ? s2.clientWidth : null, skel: document.querySelectorAll('.thm-heatSkel').length };
		})));
	}
	await p.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
	const m = await p.evaluate(() => {
		const de = document.documentElement;
		const root = document.querySelector('.thm-root');
		const rr = root.getBoundingClientRect();
		const over = [];
		for (const el of root.querySelectorAll('*')) {
			if (el.closest('.thm-scroll')) continue; // 热力图在极窄容器下允许内部横滚
			const b = el.getBoundingClientRect();
			if (b.width === 0 && b.height === 0) continue;
			const cls = el.className && el.className.baseVal !== undefined ? el.className.baseVal : el.className;
			if (b.right > rr.right + 1 || b.left < rr.left - 1) over.push([String(cls || el.tagName).slice(0, 32), Math.round(b.left), Math.round(b.right)]);
		}
		const cells = [...root.querySelectorAll('.thm-kpiCell')];
		/* KPI 补格（P0-1）：按行聚合实测宽度，判「每行是否铺满整行」+ 行首不出竖线 */
		const kpiBar = root.querySelector('.thm-kpibar');
		const kb = getComputedStyle(kpiBar);
		const kpiPadL = parseFloat(kb.paddingLeft);
		const kpiContentW = kpiBar.clientWidth - kpiPadL - parseFloat(kb.paddingRight);
		const kpiRowsArr = [];
		for (const c of cells) {
			const r = c.getBoundingClientRect();
			let row = kpiRowsArr.find((x) => Math.abs(x.top - r.top) <= 1);
			if (!row) kpiRowsArr.push((row = { top: r.top, cells: [] }));
			row.cells.push({ w: r.width, left: r.left, right: r.right, border: getComputedStyle(c).borderLeftWidth });
		}
		const kpi = {
			cols: kb.gridTemplateColumns.split(' ').length,
			rows: kpiRowsArr.length,
			contentW: Math.round(kpiContentW * 100) / 100,
			rowSpanFull: kpiRowsArr.every((x) => Math.abs(x.cells.reduce((s, c) => s + c.w, 0) - kpiContentW) <= 1.5),
			rowStartAligns: kpiRowsArr.every((x) => Math.abs(Math.min(...x.cells.map((c) => c.left)) - (kpiBar.getBoundingClientRect().left + kpiPadL)) <= 1.5),
			rowStartBorder: kpiRowsArr.map((x) => x.cells[0].border),
			widths: cells.map((c) => Math.round(c.getBoundingClientRect().width * 100) / 100),
			/* 「没显示全」的守卫：副标题只要 scrollWidth > clientWidth 就是被截断了 */
			subClipped: cells
				.map((c) => c.querySelector('.thm-kpiSub'))
				.filter(Boolean)
				.some((el) => el.scrollWidth > el.clientWidth + 1),
			valClipped: cells.some((c) => {
				const el = c.querySelector('.thm-kpiVal');
				return el && el.scrollWidth > el.clientWidth + 1;
			}),
		};
		const grid = root.querySelector('.thm-grid');
		const months = root.querySelector('.thm-months');
		const scroll = root.querySelector('.thm-scroll');
		const cell0 = root.querySelector('.thm-cell[data-day]');
		const cb = cell0.getBoundingClientRect();
		const firstMonth = [...months.querySelectorAll('.thm-month')].find((s) => s.textContent);
		const donut = root.querySelector('.thm-donutWrap').getBoundingClientRect();
		const list = root.querySelector('.thm-modelList').getBoundingClientRect();
		const labels = [...root.querySelectorAll('.thm-trend .thm-axisX')].map((t) => t.getBoundingClientRect());
		let overlap = 0;
		for (let i = 1; i < labels.length; i++) if (labels[i].left < labels[i - 1].right - 1) overlap++;
		let minGap = Infinity;
		for (let i = 1; i < labels.length; i++) minGap = Math.min(minGap, Math.round(labels[i].left - labels[i - 1].right));
		/* 纵轴：刻度数 / 文案 / 单调性 / 绘图区高度 / 纵轴列宽 */
		const svg = root.querySelector('.thm-trend');
		const svgBox = svg.getBoundingClientRect();
		const yTexts = [...svg.querySelectorAll('.thm-axisY')].map((t) => t.textContent);
		const parseCn = (s) => {
			const mm = /^([\d.]+)([万亿]?)$/.exec(s);
			return mm ? Number(mm[1]) * (mm[2] === '亿' ? 1e8 : mm[2] === '万' ? 1e4 : 1) : NaN;
		};
		const yVals = yTexts.map(parseCn);
		let yMono = yVals.length >= 3;
		for (let i = 1; i < yVals.length; i++) if (!(yVals[i] > yVals[i - 1])) yMono = false;
		const glines = [...svg.querySelectorAll('.thm-trendGrid')];
		const gx1 = Number(glines[0].getAttribute('x1'));
		const gx2 = Number(glines[0].getAttribute('x2'));
		/* 对数轴的上限不一定是整十次幂（10.21亿 → 20亿），最后一条网格线可能不在绘图区顶端；
		 * 绘图区几何从产品写进 DOM 的 data-plot 读（与画曲线用的是同一组数） */
		const plotAttr = (svg.getAttribute('data-plot') || '').split(',').map(Number);
		const plotH = Math.round(plotAttr[3]);
		const yLabels = [...svg.querySelectorAll('.thm-axisY')].map((t) => t.getBoundingClientRect());
		const yLabelClipped = yLabels.filter((b) => b.left < svgBox.left - 0.5).length;
		const inside = labels.every((b) => b.left >= svgBox.left + gx1 - 1.5 && b.right <= svgBox.left + gx2 + 1.5);
		const axisCenters = labels.map((b) => b.left + b.width / 2);
		const axisGaps = axisCenters.slice(1).map((c, i) => Math.round((c - axisCenters[i]) * 100) / 100);
		const axisPlotW = Math.round((gx2 - gx1) * 100) / 100;
		const axisLabelW = Math.round(Math.max(...labels.map((b) => b.width)) * 100) / 100;
		/* 图例（P1-1）：6 个 swatch、无 l0、窄面板隐藏区间文字、整行高度 */
		const legendBox = root.querySelector('.thm-activity .thm-legend');
		const legendText = legendBox.querySelector('.thm-legendText');
		const legend = {
			swatches: legendBox.querySelectorAll('.thm-swatch').length,
			hasL0: !!legendBox.querySelector('.thm-l0'),
			textDisplay: legendText ? getComputedStyle(legendText).display : null,
			height: Math.round(legendBox.getBoundingClientRect().height * 100) / 100,
		};
		return {
			doc: [de.scrollWidth, de.clientWidth],
			root: [root.scrollWidth, root.clientWidth],
			cards: [...root.querySelectorAll('.thm-card')].map((c) => [c.scrollWidth, c.clientWidth]),
			over: over.slice(0, 5),
			overCount: over.length,
			kpi,
			legend,
			gridCol: getComputedStyle(grid).gridTemplateColumns.split(' ')[0],
			monthCol: getComputedStyle(months).gridTemplateColumns.split(' ')[0],
			monthLabels: [...months.querySelectorAll('.thm-month')].map((x) => x.textContent).filter(Boolean),
			cols: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
			align: Math.round(months.getBoundingClientRect().left - grid.getBoundingClientRect().left),
			monthOffsets: [...months.querySelectorAll('.thm-month')].filter((x) => x.textContent && !x.classList.contains('thm-monthEnd')).map((x) => ({ col: Number(x.dataset.col), left: Math.round((x.getBoundingClientRect().left - months.getBoundingClientRect().left) * 100) / 100 })),
			cell: [Math.round(cb.width * 100) / 100, Math.round(cb.height * 100) / 100],
			weekdays: document.querySelectorAll('.thm-weekdays').length,
			gridLeft: Math.round(grid.getBoundingClientRect().left * 100) / 100,
			titleLeft: Math.round(document.querySelector('.thm-activity .thm-h3').getBoundingClientRect().left * 100) / 100,
			cells: document.querySelectorAll('.thm-cell[data-day]').length,
			scroll: [scroll.scrollWidth, scroll.clientWidth],
			scrollH: scroll.scrollHeight,
			clientH: scroll.clientHeight,
			overflowY: getComputedStyle(scroll).overflowY,
			stacked: list.top >= donut.bottom - 1,
			axis: labels.length,
			axisOverlap: overlap,
			axisInside: inside,
			axisTexts: [...root.querySelectorAll('.thm-trend .thm-axisX')].map((t) => t.textContent),
			axisGaps,
			axisPlotW,
			axisLabelW,
			minGap: minGap === Infinity ? null : minGap,
			yTicks: yTexts.length,
			yTexts,
			yVals,
			yMono,
			gridLines: glines.length,
			aspect: plotAttr[2] > 0 && plotAttr[3] > 0 ? Math.round((plotAttr[2] / plotAttr[3]) * 1000) / 1000 : 0,
			plotW: plotAttr[2],
			plotH,
			padL: plotAttr[0],
			yLabelClipped,
			/* 热力图窗口：周数 / 是否精确撑满 / 最后一次请求的 weeks */
			weeks: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
			fillW: Math.round((grid.getBoundingClientRect().right - scroll.getBoundingClientRect().left) * 100) / 100,
			availW: scroll.clientWidth,
			reqWeeks: window.__CALLS.length ? window.__CALLS[window.__CALLS.length - 1].weeks : null,
			win: window.__LASTWIN,
			calls: window.__CALLS.map((c) => c.weeks),
			kpiFont: getComputedStyle(root.querySelector('.thm-kpiVal')).fontSize,
		};
	});
	widthReport.push({ w, doc: m.doc.join('/'), root: m.root.join('/'), cell: m.cell[0] + '×' + m.cell[1], kpi: m.kpi.cols + '×' + m.kpi.rows, scroll: m.scroll.join('/'), font: m.kpiFont, grid: m.gridLines, plotW: Math.round(m.plotW), plotH: m.plotH, aspect: m.aspect, dates: m.axis, minGap: m.minGap, weeks: m.weeks, reqWeeks: m.reqWeeks, calls: m.calls.join(',') });
	const tag = 'w' + w;
	check(
		`${tag} ① 无水平溢出（document / .thm-root / 每张卡）`,
		m.doc[0] <= m.doc[1] + 1 && m.root[0] <= m.root[1] + 1 && m.cards.every(([s, c]) => s <= c + 1),
		{ doc: m.doc, root: m.root, cards: m.cards },
	);
	check(`${tag} ② 无元素越出 .thm-root 边界`, m.overCount === 0, m.over);
	check(`${tag} ②b 左侧星期标签列已删除（无 .thm-weekdays、无 一…日 文本节点）`, m.weekdays === 0, m.weekdays);
	check(`${tag} ②c 网格首列左边缘 == 卡片标题左边缘（±1px，去掉标签列后直接贴内容左缘）`, Math.abs(m.gridLeft - m.titleLeft) <= 1, { gridLeft: m.gridLeft, titleLeft: m.titleLeft });
	check(`${tag} ②d 单元格总数 == 列数 × 7`, m.cells === m.cols * 7, { cells: m.cells, cols: m.cols });
	check(`${tag} ③ 月份轴与网格同列宽、同起点（列数 = 窗口列数）`, m.gridCol === m.monthCol && m.cols === m.weeks && m.align === 0, { gridCol: m.gridCol, monthCol: m.monthCol, cols: m.cols, weeks: m.weeks, align: m.align });
	check(`${tag} ③a 每个月份标签都正好落在自己的列 x 上（±0.5px，含首月隐藏后的偏移）`, m.monthOffsets.every((o) => Math.abs(o.left - o.col * (m.cell[0] + gapFor(m.scroll[1]))) <= 0.5), m.monthOffsets.slice(0, 4));
	/* 固定 52 周：月份轴必须跨满 12 个月（首月 → 12 个月后又是同一个月份） */
	const monthNums = m.monthLabels.map((x) => Number(String(x).replace('月', '')));
	/* 月份轴跨满 12 个月：首→末跨 11 个月（或首末同月 = 整整一年）；极窄列下可能让掉 1 个标签以免叠字 */
	check(`${tag} ③b 月份轴覆盖满 12 个月（首末跨 12 个月、逐月递增、不叠字；极窄时可能少 1 个标签）`, (() => {
		if (monthNums.length < 10) return false;
		const span = (monthNums[monthNums.length - 1] - monthNums[0] + 12) % 12;
		const inc = monthNums.every((n, i) => i === 0 || ((n - monthNums[i - 1] + 12) % 12) >= 1);
		return (span === 11 || span === 0) && inc;
	})(), m.monthLabels);
	/* KPI 补格（P0-1）：**每行宽度之和 == 内容宽**（旧 5 列 3+2 时第二行只占 2/3 → 空洞） */
	check(`${tag} ④ KPI 无空洞：每行铺满整行、行首无断线`, m.kpi.rowSpanFull && m.kpi.rowStartAligns && m.kpi.rowStartBorder.every((d) => d === '0px'), m.kpi);
	check(
		`${tag} ④b KPI 跨列：≥720 五等分；≥460 五等分单行（无空洞）；≤459 两列 + 第 5 项整行`,
		(() => {
			const c = m.kpi.contentW;
			const near = (a, b) => Math.abs(a - b) <= 1.5;
			/* ≥460：五等分单行（旧 520–719 的「6 列 3+2」错位、≤519 的「2+2+1 孤儿行」都已废弃） */
			if (w >= 460) return m.kpi.cols === 5 && m.kpi.rows === 1 && m.kpi.widths.every((x) => near(x, c / 5));
			return m.kpi.cols === 2 && m.kpi.rows === 3 && m.kpi.widths.slice(0, 4).every((x) => near(x, c / 2)) && near(m.kpi.widths[4], c);
		})(),
		m.kpi,
	);
	check(`${tag} ④c KPI 文本不许被截断（数值与「峰值日」副标题 scrollWidth ≤ clientWidth）`, !m.kpi.subClipped && !m.kpi.valClipped, { subClipped: m.kpi.subClipped, valClipped: m.kpi.valClipped });
	check(
		`${tag} ⑤ 热力图：格子正方（|Δ| ≤ 0.5px）且无内部横滚（scrollWidth ≤ clientWidth）`,
		Math.abs(m.cell[0] - m.cell[1]) <= 0.5 && m.scroll[0] <= m.scroll[1],
		{ scroll: m.scroll, cell: m.cell },
	);
	/* 环形图 200 + gap 16 + 列表最小 200 = 416；卡片内容列 = 容器宽 - 28（卡片内边距） */
	check(`${tag} ⑥ 环形图与占比列表：放不下才竖排`, m.stacked === (w - 28 < 416), { stacked: m.stacked, contentW: w - 28 });
	check(`${tag} ⑤b 热力图无竖向滚动条：overflow-y = clip/hidden 且 scrollHeight ≤ clientHeight + 0.5`, (m.overflowY === 'clip' || m.overflowY === 'hidden') && m.scrollH <= m.clientH + 0.5, { overflowY: m.overflowY, scrollH: m.scrollH, clientH: m.clientH });
	check(`${tag} ⑦ x 轴日期标签 ≥2、不重叠、首尾不裁`, m.axis >= 2 && m.axisOverlap === 0 && m.axisInside === true, { axis: m.axis, overlap: m.axisOverlap, minGap: m.minGap });
	/* 纵轴刻度文字已删：轴列消失（padL=0），只剩横向网格线；量级说明靠「对数刻度」注记 */
	check(`${tag} ⑧ 纵轴刻度文字已删（0 个 .thm-axisY）、轴列宽 padL = 0、横向网格线 ≥3 条`, m.yTicks === 0 && m.padL === 0 && m.gridLines >= 3, { yTicks: m.yTicks, padL: m.padL, grid: m.gridLines });
	/* 参考图那种「宽而扁」：plotH = clamp(plotW/4.3, 130, 240)；被 clamp 卡住时宽高比会偏离 4.3 */
	check(
		`${tag} ⑨ 绘图区宽高比 ≈ 4.3（未触发 clamp 时落在 4.0–4.6；触发时明示是 130/240 的下/上限）`,
		m.aspect > 0 && (m.plotH > 130 && m.plotH < 240 ? m.aspect >= 4.0 && m.aspect <= 4.6 : Math.abs(m.plotH - (m.plotH <= 130 ? 130 : 240)) <= 0.6),
		{ plotW: m.plotW, plotH: m.plotH, ratio: m.aspect, clamped: m.plotH <= 130 || m.plotH >= 240 },
	);
	/* 热力图固定 52 周：请求恒 52；列数 = ceil(窗口天数/7)（52/53）；格子按公式精确撑满（允许 <10.5px） */
	const winDays = m.win ? diffDays(m.win.from, m.win.to) + 1 : 0;
	const winCols = winDays ? Math.ceil(winDays / 7) : 0;
	const expCell = (m.scroll[1] - (m.cols - 1) * gapFor(m.scroll[1]) - 2) / m.cols;
	check(
		`${tag} ⑩ 请求 weeks 恒 52、绘制列数 = ceil(窗口天数/7)、格子 == (avail−22−4−(列数−1)·gap−2)/列数（±0.02px）`,
		m.reqWeeks === 52 && m.cols === winCols && Math.abs(m.cell[0] - expCell) <= 0.02,
		{ cols: m.cols, winDays, winCols, req: m.reqWeeks, cell: m.cell[0], expCell: Math.round(expCell * 100) / 100 },
	);
	check(`${tag} ⑪ 网格 + 周标签列撑满 .thm-scroll（预留 2px 安全余量：0 ≤ avail−fill ≤ 3）`, m.fillW <= m.availW + 0.5 && m.availW - m.fillW <= 3, { fillW: m.fillW, availW: m.availW });
	/* x 轴等距（P1-6）：下标必须正好是 stride 序列（首尾保留、末位冲突丢倒数第二个） */
	const picks7 = expectedAxisPicks(7, m.axisPlotW, m.axisLabelW);
	const wantAxis7 = picks7.map((i) => fmtAxisDay(NEAR7[i]));
	const step7 = m.axisPlotW / 6;
	const uni7 = axisUniform(m.axisGaps, step7, m.axisLabelW);
	check(`${tag} ⑫ x 轴 = 等距 stride 序列（首尾保留、末位冲突丢倒数第二个）`, JSON.stringify(m.axisTexts) === JSON.stringify(wantAxis7), { got: m.axisTexts, want: wantAxis7, picks: picks7 });
	check(`${tag} ⑬ 相邻标签等距（中段 = stride·step ±1.5px；首末段贴边少/多半个标签宽）`, uni7.ok, { ...uni7, step: Math.round(step7 * 100) / 100 });
	/* 图例（P1-1）：6 个 swatch + 少/多；≤719 隐藏区间文字 → 整行 ≤22px */
	check(
		`${tag} ⑭ 热力图图例：6 swatch、无 l0；≤719 只留 swatch（1 行 ≤22px）、≥720 显示区间文字`,
		m.legend.swatches === 6 &&
			!m.legend.hasL0 &&
			(w <= 719 ? m.legend.textDisplay === 'none' && m.legend.height <= 22 : m.legend.textDisplay !== 'none'),
		m.legend,
	);
	await p.locator('.thm-root').screenshot({ path: SHOTS + 'ui-' + tag + '-fixed.png' });
	if (w === 380 || w === 420 || w === 500 || w === 662 || w === 720) await p.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-' + tag + '-trend.png' });
	if (w === 380 || w === 500 || w === 662 || w === 720) await p.locator('.thm-card.thm-activity').screenshot({ path: SHOTS + 'ui-' + tag + '-heat.png' });
	check(`${tag} 全程无 pageerror / console.error`, p.__errors.length === 0, p.__errors);
}
const plotHs = widthReport.map((r) => r.plotH);
let plotMono = true;
for (let i = 1; i < plotHs.length; i++) if (plotHs[i] < plotHs[i - 1]) plotMono = false;
check('绘图区高度随容器宽单调不减', plotMono, plotHs);
/* 旧口径「请求周数随宽度单调不减」已作废：固定 52 周后请求与宽度无关 */
check('十个宽度的 heatmap() 请求 weeks 恒为 52（且每个宽度只请求一次）', widthReport.every((r) => r.calls === '52'), widthReport.map((r) => [r.w, r.calls]));
const r380 = widthReport.find((r) => r.w === 380);
const r1200 = widthReport.find((r) => r.w === 1200);
const r662 = widthReport.find((r) => r.w === 662);
check('标签密度：1200px 的日期标签数 > 380px（近 7 日）', r1200.dates > r380.dates, { w380: r380.dates, w1200: r1200.dates });
check('标签密度：380px 明显抽稀（≤5 个）、1200px 满 7 个', r380.dates >= 2 && r380.dates <= 5 && r1200.dates === 7, { w380: r380.dates, w1200: r1200.dates });
check('KPI 补格：662px 走 5 列单行（不再是 3+2 错位布局）', r662 && r662.kpi === '5×1', r662 && r662.kpi);
console.log('  info 十个宽度实测（doc/root = scrollWidth/clientWidth，cell = 格子宽×高，kpi = 列×行，inner = 内部滚动）');
for (const r of widthReport) console.log(`       ${String(r.w).padStart(4)}px  doc=${r.doc}  root=${r.root}  cell=${r.cell}  kpi=${r.kpi}  inner=${r.scroll}  font=${r.font}  | 趋势图: 网格=${r.grid} 绘图区=${r.plotW}×${r.plotH}(比 ${r.aspect}) 日期标签=${r.dates} 最小间距=${r.minGap} 列数=${r.weeks}(请求=${r.reqWeeks})`);

/* 真机形态两张截图：720px 内容列 / 1141×726 窗口（左导航 188px + 弹窗内容列 ≈ 672px） */
const panelPage = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: 720, viewport: { width: 1000, height: 1500 } });
await panelPage.waitForSelector('.thm-kpibar', { timeout: 15000 });
await panelPage.evaluate(() => {
	const root = document.getElementById('root');
	root.style.cssText = 'width:720px;padding:20px;margin-left:180px;box-sizing:content-box;border-left:.5px solid var(--dsw-alias-border-l2)';
	const nav = document.createElement('div');
	nav.style.cssText = 'position:fixed;left:0;top:0;bottom:0;width:180px;background:var(--dsw-alias-bg-layer-2)';
	document.body.insertBefore(nav, root);
});
await panelPage.waitForTimeout(150);
await panelPage.locator('.thm-root').screenshot({ path: SHOTS + 'ui-w720-panel.png' });
const panelM = await panelPage.evaluate(() => {
	const root = document.querySelector('.thm-root');
	return { w: Math.round(root.getBoundingClientRect().width), doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth], root: [root.scrollWidth, root.clientWidth] };
});
check('内容列 720px：无水平溢出', panelM.w === 720 && panelM.doc[0] <= panelM.doc[1] + 1 && panelM.root[0] <= panelM.root[1] + 1, panelM);

const winPage = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: 672, viewport: { width: 1141, height: 726 } });
await winPage.waitForSelector('.thm-kpibar', { timeout: 15000 });
await winPage.evaluate(() => {
	document.body.style.cssText = 'margin:0;background:var(--dsw-alias-bg-base)';
	const root = document.getElementById('root');
	const shell = document.createElement('div');
	shell.style.cssText = 'display:flex;justify-content:center;padding:24px 0';
	const dialog = document.createElement('div');
	dialog.style.cssText = 'display:flex;width:900px;height:678px;border:.5px solid var(--dsw-alias-border-l2);border-radius:12px;overflow:hidden;background:var(--dsw-alias-bg-base)';
	const nav = document.createElement('div');
	nav.style.cssText = 'width:188px;flex:none;background:var(--dsw-alias-bg-layer-2);border-right:.5px solid var(--dsw-alias-border-l2)';
	const body = document.createElement('div');
	body.style.cssText = 'flex:1;min-width:0;overflow:auto;padding:20px';
	document.body.insertBefore(shell, root);
	shell.appendChild(dialog);
	dialog.appendChild(nav);
	dialog.appendChild(body);
	body.appendChild(root);
});
await winPage.waitForTimeout(150);
await winPage.screenshot({ path: SHOTS + 'ui-w1141-window.png' });
await winPage.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-w1141-trend.png' });
await winPage.locator('.thm-card.thm-activity').screenshot({ path: SHOTS + 'ui-w1141-heat.png' });
const winM = await winPage.evaluate(() => {
	const root = document.querySelector('.thm-root');
	return { w: Math.round(root.getBoundingClientRect().width), doc: [document.documentElement.scrollWidth, document.documentElement.clientWidth], root: [root.scrollWidth, root.clientWidth] };
});
check('真机形态 1141×726（内容列 ≈672px）：无水平溢出', winM.w > 600 && winM.w < 720 && winM.doc[0] <= winM.doc[1] + 1 && winM.root[0] <= winM.root[1] + 1, winM);

/* ============================ 场景 8：主题令牌审计（亮 / 暗） ============================ */
console.log('\n— 场景 8：主题令牌审计');
const clientSrc = readFileSync(CLIENT, 'utf8');
const usedTokens = [...new Set(clientSrc.match(/--dsw-[a-z0-9-]+/g) || [])].sort();
const unknownTokens = usedTokens.filter((t) => !AUTHORITATIVE_TOKENS.includes(t));
check('审计：只引用 Theme.listTokens 里存在的令牌', unknownTokens.length === 0, unknownTokens);
check('审计：确实用上了主题令牌（≥8 个）', usedTokens.length >= 8, usedTokens);
const themeVals = await page.evaluate((names) => {
	const cs = getComputedStyle(document.documentElement);
	const out = {};
	for (const n of names) out[n] = cs.getPropertyValue(n).trim();
	return out;
}, AUTHORITATIVE_TOKENS);
check('亮色：14 个令牌全部解析出非空值', Object.values(themeVals).every((v) => v.length > 0), themeVals);
const follow = await page.evaluate(() => {
	const rgb = (el, prop) => {
		const nums = (getComputedStyle(el)[prop].match(/[\d.]+/g) || []).slice(0, 3).map(Number);
		const scale = nums.length === 3 && nums.every((n) => n <= 1) ? 255 : 1;
		return nums.map((n) => Math.round(n * scale));
	};
	const blue = (a) => a[2] > a[0] && a[2] > a[1] && a[2] - Math.max(a[0], a[1]) >= 20;
	const seg = document.querySelector('.thm-donutSeg');
	const deep = document.querySelector('.thm-cell[data-level="6"]');
	const before = getComputedStyle(seg).stroke;
	const beforeCell = getComputedStyle(deep).backgroundColor;
	/* 把品牌色改成刺眼的红绿蓝：数据色板**不应该**有任何反应（真宿主品牌色是单色，跟随它就变灰） */
	document.documentElement.style.setProperty('--dsw-alias-brand-primary', 'rgb(1, 2, 3)');
	const after = getComputedStyle(seg).stroke;
	const afterCell = getComputedStyle(deep).backgroundColor;
	document.body.classList.add('dark');
	const darkSeg = getComputedStyle(seg).stroke;
	const darkCell = getComputedStyle(deep).backgroundColor;
	const darkCard = getComputedStyle(document.querySelector('.thm-card')).backgroundColor;
	const darkText = getComputedStyle(document.querySelector('.thm-intro')).color;
	document.documentElement.style.removeProperty('--dsw-alias-brand-primary');
	document.body.classList.remove('dark');
	return {
		before, after, beforeCell, afterCell, darkSeg, darkCell, darkCard, darkText,
		lightBlue: blue(rgb(seg, 'stroke')) && blue(rgb(deep, 'backgroundColor')),
		overrideSame: after === before && afterCell === beforeCell,
		darkBlue: blue(rgb(seg, 'stroke')) && blue(rgb(deep, 'backgroundColor')),
	};
});
check('亮色：数据色板蓝主导，且**不跟品牌色**（改 --dsw-alias-brand-primary 后系列色/格子完全不变）', follow.lightBlue && follow.overrideSame, follow);
check('暗色：数据色板仍蓝主导；卡片底色/次要文字跟随主题令牌', follow.darkBlue && follow.darkCard === 'rgb(27, 27, 32)' && follow.darkText === 'rgb(168, 168, 179)', follow);
await page.evaluate(() => document.body.classList.add('dark'));
await page.locator('.thm-root').screenshot({ path: SHOTS + 'ui-dark-fixed.png' });
await page.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-dark-trend.png' });
const darkShot = await page.evaluate(() => ({
	card: getComputedStyle(document.querySelector('.thm-card')).backgroundColor,
	secondary: getComputedStyle(document.querySelector('.thm-intro')).color,
	l0: getComputedStyle(document.querySelector('.thm-l0')).backgroundColor,
}));
check('暗色：卡片底色/次要文字来自主题令牌', darkShot.card === 'rgb(27, 27, 32)' && darkShot.secondary === 'rgb(168, 168, 179)', darkShot);
	/* 无用量格必须**看得见**。旧断言只验「等于某个令牌」（darkShot.l0 === 'rgb(38,38,45)'），
	 * 而真实主题里那个令牌与卡片底色过近 —— 真机上整年日历因此看不见格子（用户报的 bug）。
	 * 改成验「与卡片底色的相对亮度比 ≥1.10」，这条才抓得住。 */
	check('暗色：无用量格与卡片底色有可辨对比（防「看不见网格」回归）', (() => {
		const nums = (v) => { const m = String(v).match(/-?[\d.]+/g); return m ? m.slice(0, 3).map(Number) : null; };
		const scale = (v) => { const n2 = nums(v); if (!n2) return null; return String(v).trim().startsWith('color(') ? n2.map((x) => x * 255) : n2; };
		const lum = (v) => { const s2 = v / 255; return s2 <= 0.03928 ? s2 / 12.92 : Math.pow((s2 + 0.055) / 1.055, 2.4); };
		const L = (x) => 0.2126 * lum(x[0]) + 0.7152 * lum(x[1]) + 0.0722 * lum(x[2]);
		const a1 = scale(darkShot.l0), b1 = scale(darkShot.card);
		if (!a1 || !b1) return false;
		const la = L(a1), lb = L(b1);
		return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05) >= 1.10;
	})(), darkShot);
await page.evaluate(() => document.body.classList.remove('dark'));

/* ============================ 场景 10：上游参考两项（自适应窗口 / 对数轴纯函数） ============================ */
console.log('\n— 场景 10：热力图窗口自适应 + 对数轴纯函数');

try {
	const csrc = readFileSync(CLIENT, 'utf8');
	const fns = new Function(
		['isNum', 'trimZero', 'fmtCompact', 'compactExact', 'niceLogCeil', 'logDomain', 'logTicks', 'logY'].map((n) => grabFn(csrc, n)).join('\n') +
			'\nreturn { logDomain: logDomain, logTicks: logTicks, logY: logY, fmtCompact: fmtCompact };',
	)();
	const d1 = fns.logDomain(1020782001, 135060);
	const d2 = fns.logDomain(15000000, 12000000);
	const a0 = fns.logDomain(0, 0);
	const t1 = fns.logTicks(d1, 6);
	const t2 = fns.logTicks(d2, 4);
	const gy = [1e5, 1e6, 1e7, 1e8, 1e9].map((v) => fns.logY(v, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }));
	const gDiffs = gy.slice(1).map((y, i) => Math.abs(y - gy[i]));
	check('logDomain：峰值 10.21亿 / 最小非零 13.5万 → 10万…20亿（下整十次幂 + nice 上界）', d1.lo === 1e5 && d1.hi === 2e9, d1);
	check('logDomain：窄跨度（1200万…1500万）→ 1000万…2000万', d2.lo === 1e7 && d2.hi === 2e7, d2);
	check('logDomain：全零/缺值安全（回落 1…10，绝不出 0 / Infinity）', a0.lo === 1 && a0.hi === 10, a0);
	check('logTicks：10万…10亿 5 条、比恒 10、标签精确（fmtCompact 往返）', t1.length === 5 && t1[0].v === 1e5 && t1[4].v === 1e9 && t1.every((t, i) => (i === 0 || Math.abs(t.v / t1[i - 1].v - 10) <= 1e-6) && fns.fmtCompact(t.v) === t.label), t1);
	check('logTicks：窄跨度退回 1/2/5 半步（1000万/2000万），仍严格递增 + 标签精确', t2.length >= 2 && t2.every((t, i) => (i === 0 || t.v > t2[i - 1].v) && fns.fmtCompact(t.v) === t.label) && t2[0].label === '1000万' && t2[t2.length - 1].label === '2000万', t2);
	check('logY：在 5 个整十次幂上等距（y 与 log10(v) 线性）、v=lo 落底 v=hi 落顶', Math.abs(gy[0] - 232) <= 1e-9 && Math.abs(fns.logY(2e9, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) - 12) <= 1e-9 && gDiffs.every((d) => Math.abs(d - 220 / (Math.log10(2e9) - 5)) <= 1e-9), { gy, gDiffs });
	check('logY：0 / 缺值 → null（对数轴上 0 = −∞，不画点）', fns.logY(0, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) === null && fns.logY(null, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) === null);
} catch (e) {
	check('对数轴纯函数能从产品源码里抠出来跑', false, String(e && e.message));
}

/* 10.2 resize 序列：防抖 + 请求次数 ≤ 周数变化次数 + 1 */
const rz = await mount({ payloads: MODE_PAYLOADS, bare: true, viewport: { width: 1200, height: 1200 } });
await rz.waitForSelector('.thm-kpibar', { timeout: 15000 });
await settle(rz, () => { const c = document.querySelector('.thm-cell[data-day]'); return c && c.getBoundingClientRect().width > 3; }, 10000);
const rz0 = await rz.evaluate(() => window.__CALLS.length);
for (const w of [1100, 1000, 900, 800, 700, 640]) {
	await rz.setViewportSize({ width: w, height: 1200 });
	await rz.waitForTimeout(25);
}
await rz.waitForTimeout(700);
const rzBurst = await rz.evaluate(() => window.__CALLS.length);
for (const w of [520, 400, 1200]) {
	await rz.setViewportSize({ width: w, height: 1200 });
	await rz.waitForTimeout(600);
}
await rz.waitForTimeout(700);
const rzTotal = await rz.evaluate(() => window.__CALLS.length);
check('resize 序列里 heatmap() 只调用 1 次（抖动 + 换宽都不再重请求）', rzTotal === 1 && rzBurst === rz0, { total: rzTotal, burstAdded: rzBurst - rz0 });
check(
	'resize 落地后仍撑满（预留 2px）、格子 == 公式',
	await rz.evaluate(() => {
		const s = document.querySelector('.thm-scroll');
		const g = document.querySelector('.thm-grid');
		const c = document.querySelector('.thm-cell[data-day]');
		const used = g.getBoundingClientRect().right - s.getBoundingClientRect().left;
		const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
		const gap = s.clientWidth <= 520 ? 1.5 : s.clientWidth <= 740 ? 2 : 3;
		const exp = (s.clientWidth - (cols - 1) * gap - 2) / cols;
		return used <= s.clientWidth + 0.5 && s.clientWidth - used <= 3 && Math.abs(c.getBoundingClientRect().width - exp) <= 0.02;
	}),
);

/* 10.3 极端标签宽（measureText ×5）：仍然保留首尾两个日期 */
const wide = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: 500, measureScale: 5, viewport: { width: 500, height: 1400 } });
await wide.waitForSelector('.thm-kpibar', { timeout: 15000 });
await wide.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
const wideLbl = await wide.evaluate(() => [...document.querySelectorAll('.thm-trend .thm-axisX')].map((t) => t.textContent));
check('极端标签宽（实测 ×5）：仍保留首尾两个日期', wideLbl.length >= 2 && wideLbl[0] === '10月12日' && wideLbl[wideLbl.length - 1] === '10月18日', wideLbl);
check('场景 10.3 无 pageerror / console.error', wide.__errors.length === 0, wide.__errors);

/* 10.4 空白天：曲线在该天断开（不是画到轴底）、当天没有点 */
const GAP_DAY = '2026-10-14';
const GAP_IDX = DATES7.indexOf(GAP_DAY);
const gapPayload = JSON.parse(JSON.stringify(MODE_PAYLOADS.day));
gapPayload.days = gapPayload.days.filter((d) => d.day !== GAP_DAY);
const gapP = await mount({ payloads: { day: gapPayload }, ignoreMode: true, bare: true, containerWidth: 900, viewport: { width: 900, height: 1500 } });
await gapP.waitForSelector('.thm-trend', { timeout: 15000 });
const gapM = await gapP.evaluate((gapIdx) => {
	const svg = document.querySelector('.thm-trend');
	const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
	const nums = (c) => (c.slice(1).trim().match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
	const paths = [...svg.querySelectorAll('path.thm-trendLine')].map((p) => {
		const d = p.getAttribute('d') || '';
		const chunks = d.match(/[MC][^MCZ]*/g) || [];
		const pts = chunks.map((c) => {
			const n = nums(c);
			return c[0] === 'M' ? { x: n[0], y: n[1] } : { x: n[4], y: n[5] };
		});
		const days = (p.getAttribute('data-days') || '').split(',').map(Number);
		return { series: p.getAttribute('data-series'), days, pts, m: (d.match(/M/g) || []).length, fill: getComputedStyle(p).fill };
	});
	return {
		plot,
		bottom: plot[1] + plot[3],
		paths: paths.length,
		allM: paths.map((p) => p.m),
		points: paths.reduce((s2, p) => s2 + p.pts.length, 0),
		daysPerPath: paths.map((p) => p.days.length),
		gapYs: paths.map((p) => p.pts[p.days.indexOf(gapIdx)].y),
		firstXs: paths.map((p) => p.pts[0].x),
		lastXs: paths.map((p) => p.pts[p.pts.length - 1].x),
		fills: [...new Set(paths.map((p) => p.fill))],
		dots: svg.querySelectorAll('.thm-trendDot, .thm-hoverDot').length,
	};
}, GAP_IDX);
check('空白天：4 条曲线各只有 1 个 M、每系列 7 个点（该天 4 个点全部落在绘图区底部，±0.5px）', gapM.paths === 4 && gapM.allM.every((m) => m === 1) && gapM.daysPerPath.every((n) => n === 7) && gapM.points === 28 && gapM.gapYs.every((y) => Math.abs(y - gapM.bottom) <= 0.5), { allM: gapM.allM, days: gapM.daysPerPath, points: gapM.points, gapYs: gapM.gapYs, bottom: gapM.bottom });
check('空白天：左右两端都到绘图区边界、无面积填充、无单点圆点', gapM.firstXs.every((x) => Math.abs(x - gapM.plot[0]) <= 0.02) && gapM.lastXs.every((x) => Math.abs(x - (gapM.plot[0] + gapM.plot[2])) <= 0.02) && JSON.stringify(gapM.fills) === JSON.stringify(['none']) && gapM.dots === 0, gapM);
/* 悬停空白天：浮层写「无用量」，且不出现任何圆点 */
const gapXY = await gapP.evaluate((gapIdx) => {
	const svg = document.querySelector('.thm-trend');
	const b = svg.getBoundingClientRect();
	const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
	return { x: b.left + plot[0] + (gapIdx * plot[2]) / 6, y: b.top + plot[1] + plot[3] * 0.5 };
}, GAP_IDX);
await gapP.mouse.move(gapXY.x, gapXY.y);
await gapP.waitForSelector('.thm-trendTip', { timeout: 5000 });
const gapTip = await gapP.evaluate(() => ({
	text: document.querySelector('.thm-trendTip').textContent,
	dots: document.querySelectorAll('.thm-hoverDot').length,
	guide: document.querySelectorAll('.thm-hoverGuide').length,
}));
check('空白天：悬停浮层写「无用量」、不出圆点，竖参考线仍在', /无用量/.test(gapTip.text) && gapTip.dots === 0 && gapTip.guide === 1, gapTip);

/* 10.5 12 个模型：趋势图与环形图都只取 top-3 + 「其他」= 4 个系列；色板本身仍两两可区分 */
const manyPayload = JSON.parse(JSON.stringify(MODE_PAYLOADS.day));
manyPayload.days = manyPayload.days.map((d) => {
	const models = [];
	for (let k = 0; k < 12; k++) {
		models.push({ model: 'model-' + String(k + 1).padStart(2, '0'), total: Math.round((d.total * (12 - k)) / 78), input: 0, output: 0, cacheRead: 0, requests: 1 });
	}
	return Object.assign({}, d, { models });
});
const manyP = await mount({ payloads: { day: manyPayload }, ignoreMode: true, bare: true, containerWidth: 900, viewport: { width: 900, height: 1600 } });
await manyP.waitForSelector('.thm-trend', { timeout: 15000 });
const manyM = await manyP.evaluate(() => {
	const svg = document.querySelector('.thm-trend');
	const paths = [...svg.querySelectorAll('.thm-trendLine')];
	const perSeries = {};
	for (const p of paths) {
		const name = p.getAttribute('data-series');
		perSeries[name] = (perSeries[name] || 0) + (p.getAttribute('data-days') || '').split(',').length;
	}
	const strokes = [...new Set(paths.map((p) => getComputedStyle(p).stroke))];
	const rgb = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
	let minDist = Infinity;
	for (let i = 0; i < strokes.length; i++) {
		for (let j = i + 1; j < strokes.length; j++) {
			const a = rgb(strokes[i]);
			const b = rgb(strokes[j]);
			minDist = Math.min(minDist, Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)));
		}
	}
	/* 分类色板本体（.thm-root 上的 --thm-c1…--thm-c10 + --thm-cOther）仍要两两可区分 ——
	 * 这是「色板本身」的断言，与当前只画 top-3 无关 */
	const root = document.querySelector('.thm-root');
	const cs = getComputedStyle(root);
	const hexRgb = (s) => {
		const h = String(s).trim().replace(/^#/, '');
		if (h.length === 3) return [0, 1, 2].map((i) => parseInt(h[i] + h[i], 16));
		if (h.length === 6) return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));
		return null;
	};
	const pal = ['--thm-c1', '--thm-c2', '--thm-c3', '--thm-c4', '--thm-c5', '--thm-c6', '--thm-c7', '--thm-c8', '--thm-c9', '--thm-c10', '--thm-cOther'].map((n) => hexRgb(cs.getPropertyValue(n)));
	let palMin = Infinity;
	for (let i = 0; i < pal.length; i++) {
		for (let j = i + 1; j < pal.length; j++) {
			const a = pal[i];
			const b = pal[j];
			palMin = Math.min(palMin, Math.round(Math.sqrt((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2)));
		}
	}
	const legend = [...document.querySelectorAll('.thm-card[aria-label="每日 Token 趋势图"] .thm-legend .thm-legendPart')].map((l) => l.textContent);
	const donutRows = [...document.querySelectorAll('.thm-card[aria-label="模型用量"] .thm-modelRow')].map((r) => r.querySelector('.thm-modelName').textContent.trim());
	const otherPath = paths.find((p) => p.getAttribute('data-series') === '其他');
	const otherRow = [...document.querySelectorAll('.thm-card[aria-label="模型用量"] .thm-modelRow')].find((r) => r.querySelector('.thm-modelName').textContent.trim() === '其他');
	return {
		series: Object.keys(perSeries),
		perSeries,
		strokes: strokes.length,
		minDist,
		pal,
		palMin,
		legend,
		donutRows,
		otherDot: otherRow ? getComputedStyle(otherRow.querySelector('.thm-dot')).backgroundColor : null,
		otherStroke: otherPath ? getComputedStyle(otherPath).stroke : null,
	};
});
check('12 模型：趋势图仍只画 top-3 +「其他」（4 条曲线、每条 7 点）；环形图 4 项', manyM.series.length === 4 && Object.values(manyM.perSeries).every((n) => n === 7) && manyM.donutRows.length === 4, { perSeries: manyM.perSeries, donut: manyM.donutRows });
check('4 条曲线 4 种颜色，两两可区分（最小 RGB 距离 ≥40）', manyM.strokes === 4 && manyM.minDist >= 40, { strokes: manyM.strokes, minDist: manyM.minDist });
check('分类色板 11 色两两可区分（最小 RGB 距离 ≥40，取自 CSS 变量本体）', manyM.pal.length === 11 && manyM.pal.every((a) => a.length === 3) && manyM.palMin >= 40, { palMin: manyM.palMin, pal: manyM.pal });
check('图例含「其他」且只列 4 个模型系列（无缓存命中率）', manyM.legend.includes('其他') && !manyM.legend.includes('缓存命中率') && manyM.legend.length === 4, manyM.legend);
/* 「其他」必须是**中性灰**（判定见文件头的 hslSat）：蓝灰 slate(#94a3b8, HSL 饱和度 ≈20%) 会被读成
 * 「一种颜色」而不是无色 */
const otherRgb = manyM.otherStroke ? (manyM.otherStroke.match(/[\d.]+/g) || []).slice(0, 3).map(Number) : null;
check('「其他」曲线是中性灰（HSL 饱和度 ≈ 0，不是带色的灰）', otherRgb !== null && hslSat(otherRgb) <= 0.03, { stroke: manyM.otherStroke, sat: otherRgb ? +hslSat(otherRgb).toFixed(3) : null });

/* ============================ 场景 11：四种 today 形态 × 八个宽度 ============================
 * 之前的八宽度 fixture 把 today 写死成周日（窗口正好 52×7 天），于是「cell ≥ minCell」在测试里**永远成立**；
 * 真机今天若是周一/周四/周六，宿主会把 window.from 回退到 to 所在周的周一 → 列数 = weeks + 1 → 格子被压小。
 * 这个矩阵是唯一能抓住这类「假绿」的东西：周日 / 周一 / 周四 / 周六 覆盖回退偏移 k = 0/1/4/6。 */
function payloadForToday(today) {
	const weeks = 52;
	const from = mondayOf(addDays(today, -(weeks * 7 - 1)));
	const days = [];
	for (let d = from; d <= today; d = addDays(d, 1)) {
		const k = diffDays(d, today);
		const total = k % 3 === 0 ? 12000000 + (k % 5) * 3000000 : 0;
		days.push({
			day: d,
			total,
			newTokens: Math.round(total * 0.1),
			input: Math.round(total * 0.4),
			output: Math.round(total * 0.1),
			cacheRead: Math.round(total * 0.5),
			cacheWrite: 0,
			requests: total ? 3 : 0,
			rounds: total ? 2 : 0,
			hitRate: total ? 0.972 : null,
			level: 0,
			value: total,
			models: total ? [{ model: 'm1', total, input: Math.round(total * 0.4), output: Math.round(total * 0.1), cacheRead: Math.round(total * 0.5), requests: 3 }] : [],
		});
	}
	const cuts = hostScan.levelThresholds(days.map((d) => d.total));
	const withLevel = days.map((d) => Object.assign({}, d, { level: hostScan.levelOf(d.total, cuts) }));
	const sum = (k) => withLevel.reduce((s, d) => s + d[k], 0);
	return {
		generatedAt: today + 'T00:00:00.000Z',
		tzOffsetMinutes: 480,
		sessionsRoot: 'C:\\x',
		weeks,
		mode: 'day',
		window: { from, to: today },
		stats: { files: 1, reusedFiles: 1, usageEvents: withLevel.length, parsedLines: withLevel.length, badLines: 0, scanMs: 1 },
		scale: { metric: 'total', mode: 'day', cuts, legend: legendOf(cuts), max: Math.max(...withLevel.map((d) => d.total), 0) },
		totals: {
			total: sum('total'),
			newTokens: sum('newTokens'),
			input: sum('input'),
			output: sum('output'),
			cacheRead: sum('cacheRead'),
			cacheWrite: 0,
			requests: sum('requests'),
			rounds: sum('rounds'),
			days: withLevel.length,
			hitRate: 0.972,
		},
		days: withLevel,
		allTime: {
			total: sum('total'),
			activeDays: withLevel.filter((d) => d.total > 0).length,
			rounds: sum('rounds'),
			peak: { day: today, total: 27000000 },
			currentStreak: 2,
			longestStreak: 3,
			longestSpanMs: 1200000,
		},
		cached: false,
	};
}
const TODAYS = [
	{ label: '周日', day: '2026-10-18' },
	{ label: '周一', day: '2026-10-19' },
	{ label: '周四', day: '2026-10-22' },
	{ label: '周六', day: '2026-10-24' },
];
console.log('\n— 场景 11：四种 today 形态 × 八个宽度');
const todayReport = [];
for (const t of TODAYS) {
	for (const w of [380, 420, 500, 560, 720, 860, 1000, 1200]) {
		const p = await mount({ payloads: { day: payloadForToday(t.day) }, ignoreMode: true, bare: true, containerWidth: w, viewport: { width: w, height: 1400 } });
		await p.waitForSelector('.thm-kpibar', { timeout: 15000 });
		await settle(p, () => {
			const c = document.querySelector('.thm-cell[data-day]');
			const g = document.querySelector('.thm-grid');
			if (!c || !g) return false;
			const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
			const calls = window.__CALLS;
			const pad = window.__LASTWIN && new Date(window.__LASTWIN.to + 'T00:00:00.000Z').getUTCDay() === 0 ? 0 : 1;
			return cols > 0 && calls.length > 0 && calls[calls.length - 1].weeks === cols - pad;
		}, 12000);
		const m = await p.evaluate(() => {
			const c = document.querySelector('.thm-cell[data-day]');
			const g = document.querySelector('.thm-grid');
			const s = document.querySelector('.thm-scroll');
			const r = c.getBoundingClientRect();
			return {
				cell: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100],
				cols: getComputedStyle(g).gridTemplateColumns.split(' ').length,
				win: window.__LASTWIN,
				// 固定 52 周后格子按公式撑满（允许 <10.5px）
				req: window.__CALLS.length ? window.__CALLS[window.__CALLS.length - 1].weeks : null,
				fill: Math.round((g.getBoundingClientRect().right - s.getBoundingClientRect().left) * 100) / 100,
				avail: s.clientWidth,
			};
		});
		const winDays = m.win ? diffDays(m.win.from, m.win.to) + 1 : 0;
		const winCols = winDays ? Math.ceil(winDays / 7) : 0;
		const colPad = m.win && new Date(m.win.to + 'T00:00:00.000Z').getUTCDay() === 0 ? 0 : 1;
		todayReport.push({ today: t.label, w, days: winDays, cols: m.cols, winCols, req: m.req, pad: colPad, cell: m.cell[0] });
		const expCellT = (m.avail - (m.cols - 1) * gapFor(m.avail) - 2) / m.cols;
		check(`${t.label}今天 / ${w}px：格子 == (avail−22−4−(列数−1)·gap−2)/列数（±0.02px）`, Math.abs(m.cell[0] - expCellT) <= 0.02, { cell: m.cell[0], exp: Math.round(expCellT * 100) / 100, w });
		check(`${t.label}今天 / ${w}px：绘制列数 = ceil(窗口天数/7)`, m.cols === winCols && winDays >= m.req * 7 && winDays <= m.req * 7 + 6, { cols: m.cols, winCols, winDays, req: m.req });
		check(`${t.label}今天 / ${w}px：请求 weeks 恒为 52`, m.req === 52, { req: m.req });
		check(`${t.label}今天 / ${w}px：撑满 .thm-scroll（预留 2px：0 ≤ avail−fill ≤ 3）`, m.fill <= m.avail + 0.5 && m.avail - m.fill <= 3, { fill: m.fill, avail: m.avail });
		check(`${t.label}今天 / ${w}px：无 pageerror`, p.__errors.length === 0, p.__errors);
	}
}

/* ============================ 场景 12：首帧不闪（固定 52 周） ============================
 * 固定 52 周后不存在「先画 N 周压缩格再换宽度」的问题：只发一次请求（weeks=52），
 * 首帧起列数就应当等于最终列数（52/53），格子宽度恒定。 */
console.log('\n— 场景 12：首帧防闪烁');
const firstFrameReport = [];
for (const w of [500, 380, 720]) {
	const p = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: w, viewport: { width: w, height: 1400 } });
	await p.waitForSelector('.thm-kpibar', { timeout: 15000 });
	await settle(p, () => {
		const c = document.querySelector('.thm-cell[data-day]');
		const g = document.querySelector('.thm-grid');
		if (!c || !g) return false;
		const cols = getComputedStyle(g).gridTemplateColumns.split(' ').length;
		const calls = window.__CALLS;
		return cols > 0 && calls.length > 0 && calls[calls.length - 1].weeks === 52;
	}, 12000);
	const fr = await p.evaluate(() => ({
		frames: window.__FRAMES,
		calls: window.__CALLS.map((c) => c.weeks),
		cols: getComputedStyle(document.querySelector('.thm-grid')).gridTemplateColumns.split(' ').length,
		cell: Math.round(document.querySelector('.thm-cell[data-day]').getBoundingClientRect().width * 100) / 100,
		skel: document.querySelectorAll('.thm-heatSkel[data-skel]').length,
		avail: document.querySelector('.thm-scroll').clientWidth,
		lastwin: window.__LASTWIN || null,
	}));
	firstFrameReport.push({ w, frames: fr.frames, calls: fr.calls, cols: fr.cols, cell: fr.cell });
	const unstable = fr.frames.filter((f) => f.cols !== fr.cols || Math.abs(f.w - fr.cell) > 0.01);
	check(`首帧起列数与格子就恒定（不再先画别的窗口再换）（${w}px）`, fr.frames.length > 0 && unstable.length === 0, { frames: fr.frames.slice(0, 5), unstable: unstable.slice(0, 4) });
	check(`只发一次请求且 weeks=52（${w}px）`, fr.calls.length === 1 && fr.calls[0] === 52, fr.calls);
	const winDays12 = fr.lastwin ? diffDays(fr.lastwin.from, fr.lastwin.to) + 1 : 0;
	check(`稳定后列数 = ceil(窗口天数/7)、无骨架（${w}px）`, fr.cols > 0 && fr.skel === 0 && fr.cols === Math.ceil(winDays12 / 7) && Math.abs(fr.cell - (fr.avail - (fr.cols - 1) * gapFor(fr.avail) - 2) / fr.cols) <= 0.02, { cols: fr.cols, cell: fr.cell, skel: fr.skel, winDays: winDays12 });
}

/* ============================ 场景 13：趋势图曲线（圆点只在悬停 / 光标恒定 / 悬停不改几何） ============================ */
console.log('\n— 场景 13：趋势图曲线 + 悬停稳定');
const p13 = await mount({ payloads: MODE_PAYLOADS, viewport: { width: 1180, height: 1600 } });
await p13.waitForSelector('.thm-trend', { timeout: 15000 });
const g13 = await p13.evaluate(() => {
	const svg = document.querySelector('.thm-trend');
	const paths = [...svg.querySelectorAll('.thm-trendLine')];
	return {
		paths: paths.length,
		dots: svg.querySelectorAll('.thm-hoverDot').length,
		right: svg.querySelectorAll('.thm-axisY2').length,
		cursor: getComputedStyle(svg).cursor,
		ticks: [...svg.querySelectorAll('.thm-axisY')].map((t) => t.textContent),
		aria: svg.getAttribute('aria-label'),
	};
});
check('A 4 条模型曲线、静止时 0 个圆点（圆点只在悬停时出现）、无纵轴刻度文字、没有右侧百分比轴', g13.paths === 4 && g13.dots === 0 && g13.ticks.length === 0 && g13.right === 0, g13);
check('A 图表表面默认光标（不是 pointer/crosshair）', ['auto', 'default'].includes(g13.cursor), g13.cursor);

/* C. 横向扫过全宽：光标恒定、rect/viewBox 不变、曲线 d 不变；悬停出现竖线/浮层/当天圆点 */
await p13.locator('.thm-trend').scrollIntoViewIfNeeded();
const box13 = await p13.locator('.thm-trend').boundingBox();
const sweep = [];
for (let i = 0; i <= 8; i++) {
	await p13.mouse.move(box13.x + 4 + (i * (box13.width - 8)) / 8, box13.y + box13.height * 0.45);
	if (i === 4) await p13.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-hover.png' });
	sweep.push(
		await p13.evaluate(() => {
			const svg = document.querySelector('.thm-trend');
			const r = svg.getBoundingClientRect();
			const plot = svg.querySelector('rect[style]');
			return {
				cursor: getComputedStyle(svg).cursor,
				cursorRect: plot ? getComputedStyle(plot).cursor : null,
				box: [Math.round(r.width * 100) / 100, Math.round(r.height * 100) / 100, Math.round(r.left * 100) / 100, Math.round(r.top * 100) / 100].join(','),
				vb: svg.getAttribute('viewBox'),
				d: [...document.querySelectorAll('.thm-trendLine')].map((p) => p.getAttribute('d')).join('|'),
				guides: document.querySelectorAll('.thm-hoverGuide').length,
				dots: document.querySelectorAll('.thm-hoverDot').length,
				tips: document.querySelectorAll('.thm-trendTip').length,
			};
		}),
	);
}
/* 图表表面必须是**默认光标**：只要出现 pointer / crosshair 就算「鼠标变了」 */
const SOFT = ['auto', 'default'];
check(
	'C 横移全程光标恒定且是默认光标（不是 pointer/crosshair）',
	new Set(sweep.map((s) => s.cursor)).size === 1 &&
		SOFT.includes(sweep[0].cursor) &&
		new Set(sweep.map((s) => s.cursorRect)).size === 1 &&
		(sweep[0].cursorRect === null || SOFT.includes(sweep[0].cursorRect)),
	{ svg: [...new Set(sweep.map((s) => s.cursor))], rect: [...new Set(sweep.map((s) => s.cursorRect))] },
);
check('C 横移全程 SVG rect 与 viewBox 完全不变（±0.5px）', new Set(sweep.map((s) => s.box + '|' + s.vb)).size === 1, sweep[0].box + ' | ' + sweep[0].vb);
check('C 横移全程曲线 path d 不变（悬停只加圆点，不改图形）', new Set(sweep.map((s) => s.d)).size === 1);
check(
	'C 悬停生效：竖参考线 + 浮层 + 当天圆点；移开时圆点归零（圆点只在悬停时出现）',
	sweep.some((s) => s.guides === 1) && sweep.some((s) => s.tips === 1) && sweep.some((s) => s.dots === 4) && sweep.every((s) => (s.guides ? s.dots >= 1 : s.dots === 0)),
	{ guides: [...new Set(sweep.map((s) => s.guides))], dots: [...new Set(sweep.map((s) => s.dots))], tips: [...new Set(sweep.map((s) => s.tips))] },
);
check('场景 13 无 pageerror / console.error', p13.__errors.length === 0, p13.__errors);

/* ============================ 场景 14：趋势图对数轴（domain / 刻度 / 映射 / 注记 / 旧机制残留） ============================
 * 真实数据峰值日 10.21亿、次高 3808万（26.8×）：线性轴上其余 6 天只有 6–39px 高；曲线不能像柱那样跨断轴
 * 裁成两截（会碎成多段、峰值变孤点），所以整条轴换 log10。这里在 500px 容器上逐条实测：domain、
 * 刻度比值、三个样本值的百分比映射、零值断线（场景 10.4）与「对数刻度」注记。 */
console.log('\n— 场景 14：趋势图对数轴');
const PEAK_MAX = 1020782001;
const pLog = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: 500, viewport: { width: 500, height: 1500 } });
await pLog.waitForSelector('.thm-trend', { timeout: 15000 });
await pLog.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
const logM = await pLog.evaluate(() => {
	const svg = document.querySelector('.thm-trend');
	const dom = (svg.getAttribute('data-log') || '').split(',').map(Number);
	const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
	const parseCn = (s) => {
		const m = /^([\d.]+)([万亿]?)$/.exec(s);
		return m ? Number(m[1]) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1) : NaN;
	};
	const paths = [...svg.querySelectorAll('.thm-trendLine')].map((p) => {
		const chunks = (p.getAttribute('d') || '').match(/[MC][^MCZ]*/g) || [];
		const nums = (c) => (c.slice(1).trim().match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
		const pts = [];
		for (const c of chunks) {
			const n = nums(c);
			if (c[0] === 'M') pts.push({ x: n[0], y: n[1] });
			else pts.push({ x: n[4], y: n[5] });
		}
		const days = (p.getAttribute('data-days') || '').split(',').map(Number);
		return { series: p.getAttribute('data-series'), pts: pts.map((pt, k) => ({ x: pt.x, y: pt.y, day: days[k] })) };
	});
	const axis = [...svg.querySelectorAll('.thm-axisY')];
	const tickLabels = (svg.getAttribute('data-ticks') || '').split(',').filter(Boolean);
	const note = document.querySelector('.thm-card[aria-label="每日 Token 趋势图"] .thm-scaleNote');
	const noteCs = note ? getComputedStyle(note) : null;
	const points = paths.flatMap((p) => p.pts.map((pt) => ({ x: pt.x, y: pt.y, day: pt.day, series: p.series })));
	return {
		dom,
		plot,
		labels: tickLabels,
		vals: tickLabels.map(parseCn),
		yCount: axis.length,
		note: note ? note.textContent : null,
		noteSize: noteCs ? parseFloat(noteCs.fontSize) : null,
		noteColor: noteCs ? noteCs.color : null,
		breaks: svg.querySelectorAll('.thm-breakWave, .thm-breakNote').length,
		paths: paths.length,
		points,
		inside: points.every((pt) => pt.y >= plot[1] - 0.02 && pt.y <= plot[1] + plot[3] + 0.02),
		height: plot[3],
		padL: plot[0],
		width: Number(svg.getAttribute('width')),
		text: document.body.innerText,
	};
});
const logOk = (() => {
	const v = logM.vals;
	if (v.length < 3 || v.length > 6 || v.some((x) => !isFinite(x))) return false;
	for (let i = 1; i < v.length; i++) {
		if (!(v[i] > v[i - 1])) return false;
		if (Math.abs(v[i] / v[i - 1] - 10) > 1e-6) return false;
	}
	return logM.labels.every((s, i) => fmtCompact(v[i]) === s);
})();
const logSamples2 = [
	['deepseek/deepseek-v4.1-flash', 3],
	['group/auto', 0],
	['其他', 6],
].map(([series, day]) => {
	const value = TREND7.find((s) => s.name === series).values[day];
	const pt = logM.points.find((p) => p.series === series && p.day === day);
	const span = Math.log10(logM.dom[1]) - Math.log10(logM.dom[0]);
	const want = logM.plot[1] + logM.plot[3] - (logM.plot[3] * (Math.log10(value) - Math.log10(logM.dom[0]))) / span;
	const pct = Math.round(((logM.plot[1] + logM.plot[3] - pt.y) / logM.plot[3]) * 1000) / 10;
	const wantPct = Math.round(((Math.log10(value) - Math.log10(logM.dom[0])) / span) * 1000) / 10;
	return { series, day, value, y: pt.y, want, pct, wantPct };
});
check('① 500px domain：下限 10万（最小非零 13.5万 → 整十次幂）、上限 20亿（10.21亿 → nice）', logM.dom[0] === 1e5 && logM.dom[1] === 2e9 && logM.width >= 460 && logM.width <= 480, logM.dom);
check('② 网格刻度严格递增、相邻比恒定 10（±1e-6）、标签逐条 fmtCompact 精确往返（10万…10亿）；纵轴不再画刻度文字（0 个 .thm-axisY）', logOk && logM.yCount === 0, { labels: logM.labels, vals: logM.vals, yCount: logM.yCount });
check('③ 三个样本值 y 与 log10(value) 线性对应（百分比偏差 ≤ 0.1%、像素偏差 ≤ 0.02px）', logSamples2.every((s) => Math.abs(s.pct - s.wantPct) <= 0.1 && Math.abs(s.y - s.want) <= 0.02), logSamples2.map((s) => [s.series, s.day, s.value, s.pct + '%', s.wantPct + '%']));
check('④ 所有曲线点都落在绘图区内（下限装得下最小的点、上限装得下峰值）', logM.inside === true, { dom: logM.dom, plot: logM.plot });
check('⑤ 「对数刻度」注记存在：11px、label-secondary、在卡头右侧', logM.note === '对数刻度' && logM.noteSize === 11 && logM.noteColor === 'rgb(91, 91, 102)', { note: logM.note, size: logM.noteSize, color: logM.noteColor });
check('⑥ 断轴标记与「断轴」注记数 == 0（元素 0 处、页面文案 0 处）', logM.breaks === 0 && !/断轴/.test(logM.text), { breaks: logM.breaks });

/* 纯函数：源码里抠出来直接跑（不经过浏览器也能证明 domain/刻度/映射的规则） */
try {
	const csrc = readFileSync(CLIENT, 'utf8');
	const fns = new Function(
		['isNum', 'trimZero', 'fmtCompact', 'compactExact', 'niceLogCeil', 'logDomain', 'logTicks', 'logY'].map((n) => grabFn(csrc, n)).join('\n') +
			'\nreturn { logDomain: logDomain, logTicks: logTicks, logY: logY, fmtCompact: fmtCompact };',
	)();
	const d = fns.logDomain(PEAK_MAX, 135060);
	const tk = fns.logTicks(d, 6);
	const ys = [1e5, 1e6, 1e7, 1e8, 1e9].map((v) => fns.logY(v, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }));
	const yDiff = ys.slice(1).map((y, i) => Math.abs(y - ys[i]));
	const yOk = Math.abs(ys[0] - 232) <= 1e-9 && Math.abs(fns.logY(2e9, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) - 12) <= 1e-9 && yDiff.every((d) => Math.abs(d - 220 / (Math.log10(2e9) - 5)) <= 1e-9);
	check('纯函数：logDomain(10.21亿, 13.5万) = {1e5, 2e9}；logTicks 5 条且比恒 10；logY 在 5 个整十次幂上等距', d.lo === 1e5 && d.hi === 2e9 && tk.length === 5 && tk.every((t, i) => i === 0 || Math.abs(t.v / tk[i - 1].v - 10) <= 1e-6) && yOk, { dom: d, ticks: tk.map((t) => t.label), ys });
	check('纯函数：logY(0) / logY(缺值) = null（对数轴上 0 = −∞，不画点）', fns.logY(0, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) === null && fns.logY(null, { padT: 12, plotH: 220, lo: 1e5, hi: 2e9 }) === null);
} catch (e) {
	check('纯函数：能从产品源码里抠出来跑', false, String(e && e.message));
}

/* 窄跨度（12M…15M，只跨半个数量级）：对数轴退化，刻度退回 1/2/5 半步；0 值天断成孤岛点 */
const linPayload = payloadForToday('2026-10-18');
const pLin = await mount({ payloads: { day: linPayload }, ignoreMode: true, bare: true, containerWidth: 900, viewport: { width: 900, height: 1500 } });
await pLin.waitForSelector('.thm-trend', { timeout: 15000 });
await pLin.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
const lin = await pLin.evaluate(() => {
	const svg = document.querySelector('.thm-trend');
	const parseCn = (s) => {
		const m = /^([\d.]+)([万亿]?)$/.exec(s);
		return m ? Number(m[1]) * (m[2] === '亿' ? 1e8 : m[2] === '万' ? 1e4 : 1) : NaN;
	};
	const axis = [...svg.querySelectorAll('.thm-axisY')];
	const paths = [...svg.querySelectorAll('.thm-trendLine')];
	const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
	return {
		dom: (svg.getAttribute('data-log') || '').split(',').map(Number),
		labels: axis.map((t) => t.textContent),
		vals: axis.map((t) => parseCn(t.textContent)),
		grid: svg.querySelectorAll('.thm-trendGrid').length,
		plot,
		ratio: plot[2] / plot[3],
		paths: paths.length,
		points: paths.reduce((s, p) => s + (p.getAttribute('data-days') || '').split(',').length, 0),
		dots: svg.querySelectorAll('.thm-hoverDot').length,
		breaks: svg.querySelectorAll('.thm-breakWave, .thm-breakNote').length,
		text: document.body.innerText,
	};
});
check('窄跨度：domain 1000万…2500万 不变；刻度文字已删（0 个）、横向网格线保留、绘图区贴左缘', lin.dom[0] === 1e7 && lin.dom[1] === 2.5e7 && lin.labels.length === 0 && lin.grid >= 3 && lin.plot[0] === 0, { dom: lin.dom, grid: lin.grid, plot: lin.plot });
check('窄跨度：1 条连续曲线、7 个点（3 个有量日 + 4 个底部日），无断轴标记', lin.paths === 1 && lin.points === 7 && lin.breaks === 0, { paths: lin.paths, points: lin.points, breaks: lin.breaks });
check('窄跨度：无 NaN/undefined 文案', !/NaN|undefined|Infinity/.test(lin.text));

/* 旧机制残留：源码里 0 处 */
const FINAL_SRC = readFileSync(CLIENT, 'utf8');
check('源码 0 处旧断轴/柱状残留（BREAK_MIN_RATIO / breakB / breakDivisions / thm-breakWave / thm-breakNote / thm-barSeg / data-clip / 「断轴」）', !/BREAK_MIN_RATIO|breakB|breakDivisions|thm-breakWave|thm-breakNote|thm-barSeg|data-clip|断轴/.test(FINAL_SRC));
check('源码保留对数轴与单调插值（logDomain / logTicks / logY / monotonePath 各恰好 1 处定义）', ['function logDomain(', 'function logTicks(', 'function logY(', 'function monotonePath('].every((m) => FINAL_SRC.split(m).length === 2));
console.log(`  info 500px 实测：domain=${logM.dom[0]}…${logM.dom[1]}  纵轴刻度文字=${logM.labels.length} 个  plot=${logM.plot[2]}×${logM.plot[3]}（比 ${Math.round((logM.plot[2] / logM.plot[3]) * 100) / 100}）  padL=${logM.padL}px  样本=${logSamples2.map((s) => s.value + '→' + s.pct + '%').join(' / ')}`);


/* ============================ 场景 15：近 7 日 ↔ 近 30 日 平滑过渡 ============================
 * 官方录屏里是硬切：图例从 3 项变 6 项、绘图区被顶下去、曲线瞬间换掉。这一场要求：
 *   ① 绘图区矩形 / viewBox / data-plot 在切换前后与动画期间完全不变（图例区固定 2 行高）；
 *   ② 曲线 ~280ms 按归一化索引逐点插值，≥3 帧中间态；
 *   ③ 图例与 x 轴标签 crossfade（旧层淡出、新层淡入）；
 *   ④ prefers-reduced-motion 直接切（无中间态）；
 *   ⑤ 系列集合按 30 日窗口固定，7/30 图例同名同色同序（窄窗口没数据的模型线断开、不掉出图例）。
 * fixture 特意让两档的 top-3 不同：spike-model 只在 8–30 天前有量 → 7 日窗口里它没有点。
 */
console.log('\n— 场景 15：7/30 切换过渡');
const SWITCH_PAYLOAD = (() => {
	const p = JSON.parse(JSON.stringify(MODE_PAYLOADS.day));
	const to = p.window.to;
	for (const d of p.days) {
		const k = diffDays(d.day, to);
		if (k >= 7 && k <= 29) {
			const spike = 500000000 + (29 - k) * 1000000;
			d.models = [{ model: 'spike-model', total: spike, input: 0, output: 0, cacheRead: 0, requests: 1 }].concat(d.models.map((m) => Object.assign({}, m)));
			d.total = d.models.reduce((s, m) => s + m.total, 0);
			d.value = d.total;
		}
	}
	return p;
})();
const legendOfTrend = (p) =>
	p.evaluate(() => {
		const card = document.querySelector('.thm-card[aria-label="每日 Token 趋势图"]');
		const norm = (s) => (s.match(/[\d.]+/g) || []).slice(0, 3).map((x) => Math.round(Number(x)));
		return {
			items: [...card.querySelectorAll('.thm-legend .thm-legendPart')].map((part) => ({ name: part.textContent.trim(), color: norm(getComputedStyle(part.querySelector('.thm-dot')).backgroundColor) })),
			boxH: Math.round(card.querySelector('.thm-trendLegendBox').getBoundingClientRect().height * 100) / 100,
			paths: [...card.querySelectorAll('path[data-series]')].map((p) => p.getAttribute('data-series')),
		};
	});
const readPlot = (p) =>
	p.evaluate(() => {
		const svg = document.querySelector('.thm-trend');
		const r = svg.getBoundingClientRect();
		return {
			vb: svg.getAttribute('viewBox'),
			plot: svg.getAttribute('data-plot'),
			rect: [r.width, r.height, r.left, r.top].map((v) => Math.round(v * 100) / 100).join(','),
			cursor: getComputedStyle(svg).cursor,
		};
	});
const SERIES_KEY = 'deepseek/deepseek-v4.1-flash';

const pMorph = await mount({ payloads: { day: SWITCH_PAYLOAD }, ignoreMode: true, bare: true, containerWidth: 500, viewport: { width: 500, height: 1500 } });
await pMorph.waitForSelector('.thm-trend', { timeout: 15000 });
await pMorph.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
const legend7 = await legendOfTrend(pMorph);
const plot7 = await readPlot(pMorph);
await pMorph.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-7d.png' });
/* 逐帧采样：viewBox / 绘图区 rect / 图例高 / cursor / 每条曲线的 d / crossfade 的层与透明度 */
await pMorph.evaluate(() => {
	window.__MORPH = { frames: [], done: false };
	const t0 = performance.now();
	const snap = () => {
		const svg = document.querySelector('.thm-trend');
		if (!svg) return null;
		const r = svg.getBoundingClientRect();
		const box = document.querySelector('.thm-trendLegendBox');
		const ds = {};
		[...svg.querySelectorAll('path[data-series]')].forEach((p) => {
			ds[p.getAttribute('data-series')] = p.getAttribute('d');
		});
		const gOld = svg.querySelector('.thm-axisXOld');
		const gNew = svg.querySelector('.thm-axisXNew');
		return {
			t: Math.round(performance.now() - t0),
			vb: svg.getAttribute('viewBox'),
			plot: svg.getAttribute('data-plot'),
			rect: [r.width, r.height, r.left, r.top].map((v) => Math.round(v * 100) / 100).join(','),
			boxH: box ? Math.round(box.getBoundingClientRect().height * 100) / 100 : null,
			cursor: getComputedStyle(svg).cursor,
			ds,
			opOld: gOld ? Number(gOld.getAttribute('opacity')) : null,
			opNew: gNew ? Number(gNew.getAttribute('opacity')) : null,
			layers: box ? [...box.querySelectorAll('.thm-trendLegendLayer')].map((el) => Math.round(Number(getComputedStyle(el).opacity) * 1000) / 1000) : [],
		};
	};
	const tick = () => {
		const s = snap();
		if (s) window.__MORPH.frames.push(s);
		if (performance.now() - t0 < 700) requestAnimationFrame(tick);
		else window.__MORPH.done = true;
	};
	requestAnimationFrame(tick);
});
await pMorph.click('[data-seg="range"] [data-value="30"]');
await pMorph.waitForTimeout(110);
await pMorph.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-morph.png' });
await pMorph.waitForFunction(() => window.__MORPH && window.__MORPH.done, null, { timeout: 5000 });
const morph = await pMorph.evaluate(() => window.__MORPH.frames);
const legend30 = await legendOfTrend(pMorph);
const plot30 = await readPlot(pMorph);
await pMorph.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-30d.png' });
const finalD30 = await pMorph.evaluate((k) => document.querySelector('path[data-series="' + k + '"]').getAttribute('d'), SERIES_KEY);
await pMorph.waitForTimeout(250);
const laterD30 = await pMorph.evaluate((k) => document.querySelector('path[data-series="' + k + '"]').getAttribute('d'), SERIES_KEY);
const frameDs = morph.map((f) => f.ds[SERIES_KEY]).filter((d) => typeof d === 'string');
const uniqD = [...new Set(frameDs)];
const crossFade = morph.some((f) => f.opOld !== null && f.opOld > 0 && f.opOld < 1 && f.opNew !== null && f.opNew > 0 && f.opNew < 1);
/* 取动画开始后最早的三帧（不按固定时刻抓，避免点击/rAF 抖动导致前两帧还在旧形态），三帧 d 必须互不相同 */
const firstD = morph.length ? morph[0].ds[SERIES_KEY] : null;
const animFrames = morph.filter((f) => typeof f.ds[SERIES_KEY] === 'string' && f.ds[SERIES_KEY] !== firstD);
/* rAF 采样可能落在同一次 React 渲染之间（相邻两帧 d 相同）→ 去重后再取前 3 个不同形态 */
const seenD = new Set();
const midFrames = [];
for (const f of animFrames) {
	const d0 = f.ds[SERIES_KEY];
	if (seenD.has(d0)) continue;
	seenD.add(d0);
	midFrames.push(f);
	if (midFrames.length === 3) break;
}
const midDs = midFrames.map((f) => f.ds[SERIES_KEY]);
check('A 过渡中间态可分帧：动画开始后的前 3 帧 d 互不相同（同一次 morph 的逐帧形态）', midDs.length === 3 && new Set(midDs).size === 3, midDs.map((d) => String(d).slice(0, 40)));
console.log('  info 过渡三帧 d（' + SERIES_KEY + '，动画开始后前 3 帧）：');
midFrames.forEach((f) => console.log('       t=' + f.t + 'ms  d=' + String(f.ds[SERIES_KEY] || '').slice(0, 200) + '…'));

check('A 切换前：7 日图例 = 4 项（按 30 日排序固定的 top-3 + 其他，spike-model 在列）', legend7.items.length === 4 && legend7.items.some((i) => i.name === 'spike-model'), legend7);
check('A 切换后：30 日图例与 7 日完全一致（name + color + 顺序）', JSON.stringify(legend30.items) === JSON.stringify(legend7.items), { d7: legend7.items, d30: legend30.items });
check('A 系列稳定：7 日里没有数据的 spike-model 只是线断开（3 条路径），仍留在图例；30 日 4 条路径', legend7.paths.length === 3 && !legend7.paths.includes('spike-model') && legend30.paths.length === 4 && legend30.paths.includes('spike-model'), { p7: legend7.paths, p30: legend30.paths });
check('A 图例区固定 2 行高（42px）：7 日 / 30 日 / 动画帧内都相同', legend7.boxH === 42 && legend30.boxH === 42 && morph.every((f) => f.boxH === null || f.boxH === 42), { b7: legend7.boxH, b30: legend30.boxH, frames: [...new Set(morph.map((f) => f.boxH))] });
check('A 绘图区矩形 / viewBox / data-plot 切换前后与动画期间完全不变', plot7.vb === plot30.vb && plot7.plot === plot30.plot && plot7.rect === plot30.rect && morph.every((f) => f.vb === plot7.vb && f.plot === plot7.plot && f.rect === plot7.rect), { plot7, plot30, vb: [...new Set(morph.map((f) => f.vb))], plots: [...new Set(morph.map((f) => f.plot))], rects: [...new Set(morph.map((f) => f.rect))] });
check('A 曲线真的在过渡：同一 path 的 d 出现 ≥3 个不同值（≥3 帧中间态）', uniqD.length >= 3, { frames: frameDs.length, uniq: uniqD.length });
check('A ~400ms 后 d 稳定在终态（最后一帧 = 400ms 后 = 再等 250ms 仍不变）', frameDs[frameDs.length - 1] === finalD30 && finalD30 === laterD30 && !!finalD30, { len: String(finalD30 || '').length, same: finalD30 === laterD30 });
check('A x 轴标签 crossfade：过渡中出现新旧两层、透明度都在 0–1 之间；终态只剩新层', crossFade && morph.some((f) => f.opNew !== null && f.opNew < 1) && (await pMorph.evaluate(() => document.querySelectorAll('.thm-axisXOld').length)) === 0, { crossFade, opOld: [...new Set(morph.map((f) => f.opOld))].slice(0, 6), opNew: [...new Set(morph.map((f) => f.opNew))].slice(0, 6) });
check('A 图例 crossfade：过渡中同时存在两层、终态一层', morph.some((f) => f.layers.length === 2 && f.layers.every((o) => o > 0 && o <= 1)) && legend30.boxH === 42, { layers: [...new Set(morph.map((f) => f.layers.join('/')))].slice(0, 6) });
check('A 动画期间 cursor 恒定 = default、无 pageerror', morph.every((f) => f.cursor === plot7.cursor) && plot7.cursor === 'default' && pMorph.__errors.length === 0, { cursors: [...new Set(morph.map((f) => f.cursor))], errors: pMorph.__errors });

/* ④ prefers-reduced-motion：直接切（没有中间态、没有 crossfade 的旧层） */
const pReduce = await mount({ payloads: { day: SWITCH_PAYLOAD }, ignoreMode: true, bare: true, containerWidth: 500, viewport: { width: 500, height: 1500 } });
await pReduce.waitForSelector('.thm-trend', { timeout: 15000 });
await pReduce.emulateMedia({ reducedMotion: 'reduce' });
const rm7 = await readPlot(pReduce);
await pReduce.evaluate(() => {
	window.__RM = { frames: [], done: false };
	const t0 = performance.now();
	const tick = () => {
		const svg = document.querySelector('.thm-trend');
		if (svg) {
			const ds = {};
			[...svg.querySelectorAll('path[data-series]')].forEach((p) => {
				ds[p.getAttribute('data-series')] = p.getAttribute('d');
			});
			window.__RM.frames.push({ ds, olds: svg.querySelectorAll('.thm-axisXOld').length });
		}
		if (performance.now() - t0 < 450) requestAnimationFrame(tick);
		else window.__RM.done = true;
	};
	requestAnimationFrame(tick);
});
await pReduce.click('[data-seg="range"] [data-value="30"]');
await pReduce.waitForFunction(() => window.__RM && window.__RM.done, null, { timeout: 5000 });
const rm = await pReduce.evaluate(() => window.__RM.frames);
const rmUniq = [...new Set(rm.map((f) => f.ds[SERIES_KEY]).filter((d) => typeof d === 'string'))];
const reduceD = await pReduce.evaluate((k) => document.querySelector('path[data-series="' + k + '"]').getAttribute('d'), SERIES_KEY);
check('D prefers-reduced-motion：直接切（中间态 < 3、没有 crossfade 旧层），终态与动画版一致', rmUniq.length < 3 && rm.every((f) => f.olds === 0) && reduceD === finalD30, { uniq: rmUniq.length, olds: [...new Set(rm.map((f) => f.olds))], sameFinal: reduceD === finalD30, vb: rm7.vb });
check('场景 15 无 pageerror / console.error', pMorph.__errors.length === 0 && pReduce.__errors.length === 0, { a: pMorph.__errors, b: pReduce.__errors });

/* 真实 fixture 的 7 日 / 过渡中间态 / 30 日截图（合成 spike fixture 只用于证伪系列稳定性） */
const pShot = await mount({ payloads: MODE_PAYLOADS, bare: true, containerWidth: 500, viewport: { width: 500, height: 1500 } });
await pShot.waitForSelector('.thm-trend', { timeout: 15000 });
await pShot.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-7d.png' });
await pShot.click('[data-seg="range"] [data-value="30"]');
await pShot.waitForTimeout(110);
await pShot.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-morph.png' });
await pShot.waitForTimeout(450);
await pShot.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-30d.png' });
check('场景 15 截图页无 pageerror', pShot.__errors.length === 0, pShot.__errors);



/* ============================ 场景 16：每一天都有点（没用量的日子落在绘图区底部，无断口） ============================
 * 用户原话：「就算那一天没用，曲线的部分在最低，也不要断」。规则：每个系列遍历窗口内**每一天**，
 * 有量按 log10 映射、0/缺值固定在绘图区底部；于是每条 path 只有一个 M、点数 == 窗口天数，
 * 左右两端天然到绘图区边界；窗口内全零的系列不画线（唯一例外）。
 * fixture：窗口 2026-09-01…09-25（25 天）——
 *   far-model 只有 9/1 与 9/25（9/2–9/24 必须全部落在底部）；one-model 只有 9/10；
 *   filler-a/b/c 每天都有量。7 日视图里 one-model 全零 → 不画线（但仍在图例里）。 */
console.log('\n— 场景 16：每一天都有点（无用量落底部、无断口）');
const EDGE = (() => {
	const p = JSON.parse(JSON.stringify(MODE_PAYLOADS.day));
	const from = '2026-09-01';
	const to = '2026-09-25';
	const days = [];
	for (let d = from; d <= to; d = addDays(d, 1)) {
		const k = diffDays(d, to);
		const models = [
			{ model: 'filler-a/deepseek-v4.1-flash', total: Math.round(8e6 + (25 - k) * 3e5), input: 0, output: 0, cacheRead: 0, requests: 1 },
			{ model: 'filler-b/deepseek-v4.1-pro', total: 5000000, input: 0, output: 0, cacheRead: 0, requests: 1 },
			{ model: 'filler-c/group-auto', total: 4000000, input: 0, output: 0, cacheRead: 0, requests: 1 },
		];
		if (d === '2026-09-01' || d === '2026-09-25') models.push({ model: 'far-model/deepseek-v4.1-flash', total: 600000000, input: 0, output: 0, cacheRead: 0, requests: 1 });
		if (d === '2026-09-10') models.push({ model: 'one-model/deepseek-v4.1-pro', total: 500000000, input: 0, output: 0, cacheRead: 0, requests: 1 });
		const total = models.reduce((s2, m) => s2 + m.total, 0);
		days.push({ day: d, total, newTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 1, rounds: 1, hitRate: 0.97, level: 3, value: total, models });
	}
	p.window = { from, to };
	p.days = days;
	p.totals = { total: days.reduce((s2, d) => s2 + d.total, 0), newTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: days.length, rounds: days.length, days: days.length, hitRate: 0.97 };
	p.scale = { metric: 'total', mode: 'day', cuts: null, legend: [1, 2, 3, 4, 5, 6].map((level) => ({ level, min: null, max: null })), max: Math.max(...days.map((d) => d.total)) };
	return p;
})();
const EDGE_TOP = ['far-model/deepseek-v4.1-flash', 'one-model/deepseek-v4.1-pro', 'filler-a/deepseek-v4.1-flash', '其他'];
const readTrend = (p) =>
	p.evaluate(() => {
		const svg = document.querySelector('.thm-trend');
		const plot = (svg.getAttribute('data-plot') || '').split(',').map(Number);
		const nums = (c) => (c.slice(1).trim().match(/-?[\d.]+(?:e-?\d+)?/g) || []).map(Number);
		const paths = [...svg.querySelectorAll('path.thm-trendLine')].map((el) => {
			const d = el.getAttribute('d') || '';
			const chunks = d.match(/[MC][^MCZ]*/g) || [];
			const pts = chunks.map((c) => {
				const n = nums(c);
				return c[0] === 'M' ? { x: n[0], y: n[1] } : { x: n[4], y: n[5] };
			});
			const days = (el.getAttribute('data-days') || '').split(',').map(Number);
			return { series: el.getAttribute('data-series'), d, m: (d.match(/M/g) || []).length, days, pts, dash: getComputedStyle(el).strokeDasharray };
		});
		return {
			plot,
			bottom: plot[1] + plot[3],
			paths,
			dots: svg.querySelectorAll('.thm-trendDot').length,
			bridges: svg.querySelectorAll('.thm-trendBridge, .thm-trendDash').length,
			legend: [...document.querySelectorAll('.thm-card[aria-label="每日 Token 趋势图"] .thm-legend .thm-legendPart')].map((x) => x.textContent),
			dom: (svg.getAttribute('data-log') || '').split(',').map(Number),
			nan: /NaN|Infinity/.test(svg.innerHTML),
		};
	});
const pEdge = await mount({ payloads: { day: EDGE }, ignoreMode: true, bare: true, viewport: { width: 500, height: 1500 } });
await pEdge.waitForSelector('.thm-trend', { timeout: 15000 });
await pEdge.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
/* 7 日视图（9/19–9/25）：one-model 在这 7 天全零 → 不画线，但仍在图例里 */
const edge7 = await readTrend(pEdge);
check('④ 全零系列不画线：7 日视图里 one-model 全零 → 没有 path，但图例仍有 4 项', edge7.legend.length === 4 && !edge7.paths.some((p) => p.series === 'one-model/deepseek-v4.1-pro') && edge7.paths.length === 3, { legend: edge7.legend, paths: edge7.paths.map((p) => p.series) });
await pEdge.click('[data-seg="range"] [data-value="30"]');
await pEdge.waitForTimeout(500);
await pEdge.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-longgap.png' });
const edge30 = await readTrend(pEdge);
const far = edge30.paths.find((p) => p.series === 'far-model/deepseek-v4.1-flash');
const one = edge30.paths.find((p) => p.series === 'one-model/deepseek-v4.1-pro');
check('① 4 个非全零系列 = 4 条 path，每条 d 里只有 1 个 M', edge30.paths.length === 4 && edge30.paths.every((p) => p.m === 1) && JSON.stringify(edge30.paths.map((p) => p.series)) === JSON.stringify(EDGE_TOP), { paths: edge30.paths.map((p) => p.series), m: edge30.paths.map((p) => p.m) });
check('② 每个系列的点数 == 窗口天数（25 天 × 4 系列，逐系列断言）', edge30.paths.every((p) => p.pts.length === 25 && p.days.length === 25) && edge30.paths[0].days[0] === 0 && edge30.paths[0].days[24] === 24, edge30.paths.map((p) => [p.series, p.pts.length]));
check('③ 长缺口（9/1 与 9/25）之间每天都在底部：far-model 第 1–23 天 y == 绘图区底部（±0.5px），整条仍是一条连续 C 曲线、无任何虚线段', (() => {
	if (!far) return false;
	const gapYs = far.pts.slice(1, 24).map((pt) => pt.y);
	return gapYs.every((y) => Math.abs(y - edge30.bottom) <= 0.5) && far.m === 1 && far.dash === 'none' && edge30.bridges === 0 && /C/.test(far.d);
})(), { bottom: edge30.bottom, farGapYs: far ? far.pts.slice(1, 24).map((pt) => Math.round(pt.y * 100) / 100) : null });
check('③b one-model（只有 9/10 有量）：25 个点、其余 24 天全部在底部、9/10 的点按 log10 抬高', (() => {
	if (!one) return false;
	return one.pts.length === 25 && one.pts.every((pt, i) => (i === 9 ? pt.y < edge30.bottom - 1 : Math.abs(pt.y - edge30.bottom) <= 0.5)) && one.m === 1;
})(), one ? one.pts.map((pt) => Math.round(pt.y * 100) / 100) : null);
check('⑥ 任何一条线的左右两端都到达绘图区左右边界（不出现从中间开始的线）', edge30.paths.every((p) => Math.abs(p.pts[0].x - edge30.plot[0]) <= 0.02 && Math.abs(p.pts[p.pts.length - 1].x - (edge30.plot[0] + edge30.plot[2])) <= 0.02), edge30.paths.map((p) => [p.series, p.pts[0].x, p.pts[p.pts.length - 1].x, edge30.plot[0] + edge30.plot[2]]));
check('⑤ 有量日的 y 仍与 log10(v) 对应（filler-a 3 个样本，≤0.02px）', (() => {
	const yOf = (v, dom, padT, plotH) => padT + plotH * (1 - (Math.log10(v) - Math.log10(dom[0])) / (Math.log10(dom[1]) - Math.log10(dom[0])));
	const fa = edge30.paths.find((p) => p.series === 'filler-a/deepseek-v4.1-flash');
	const samples = [0, 12, 24].map((i) => {
		const row = EDGE.days.find((d) => d.day === addDays('2026-09-01', i));
		const m = row.models.find((x) => x.model === 'filler-a/deepseek-v4.1-flash');
		return { i, v: m ? m.total : 0 };
	});
	return fa && samples.every((s) => Math.abs(fa.pts[s.i].y - yOf(s.v, edge30.dom, edge30.plot[1], edge30.plot[3])) <= 0.02);
})(), { dom: edge30.dom, plot: edge30.plot });
check('无 NaN/Infinity、无单点圆点、无虚线元素', edge30.nan === false && edge30.dots === 0 && edge30.bridges === 0 && edge30.paths.every((p) => p.dash === 'none'), { nan: edge30.nan, dots: edge30.dots, bridges: edge30.bridges });
check('场景 16 无 pageerror / console.error', pEdge.__errors.length === 0, pEdge.__errors);

/* ============================ 场景 17：长模型名的图例省略（500px / 400px） ============================ */
console.log('\n— 场景 17：图例展示名与溢出');
const LONG = (() => {
	const p = JSON.parse(JSON.stringify(MODE_PAYLOADS.day));
	const map = {
		'group/auto-deepseek-v4-1-flash': 'workbuddy-ai/deepseek-v4.1-flash',
		'group/auto': 'commandcode/deepseek/deepseek-v4.1-flash',
		'deepseek/deepseek-v4.1-pro': 'some-very-long-provider/deepseek-v4.1-pro',
	};
	p.days = p.days.map((d) => Object.assign({}, d, { models: d.models.map((m) => Object.assign({}, m, { model: map[m.model] || m.model })) }));
	return p;
})();
const LONG_FULL = ['deepseek/deepseek-v4.1-flash', 'workbuddy-ai/deepseek-v4.1-flash', 'commandcode/deepseek/deepseek-v4.1-flash'];
const LONG_SHORT = ['v4.1-flash', 'workbuddy-ai/v4.1-flash', 'commandcode/v4.1-flash'];
for (const wLegend of [500, 400]) {
	const pL = await mount({ payloads: { day: LONG }, ignoreMode: true, bare: true, containerWidth: wLegend, viewport: { width: wLegend, height: 1500 } });
	await pL.waitForSelector('.thm-trend', { timeout: 15000 });
	await pL.waitForFunction(() => document.querySelectorAll('.thm-trend .thm-axisX').length > 0, null, { timeout: 10000 });
	const L = await pL.evaluate(() => {
		const card = document.querySelector('.thm-card[aria-label="每日 Token 趋势图"]');
		const box = card.querySelector('.thm-trendLegendBox');
		const legend = box.querySelector('.thm-legend');
		const parts = [...box.querySelectorAll('.thm-legendPart')];
		const boxRect = box.getBoundingClientRect();
		const rects = parts.map((el) => {
			const r = el.getBoundingClientRect();
			return { left: r.left, right: r.right, top: r.top, bottom: r.bottom };
		});
		let overlap = 0;
		for (let i = 0; i < rects.length; i++) {
			for (let j = i + 1; j < rects.length; j++) {
				const a = rects[i];
				const b = rects[j];
				const vOv = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
				const hOv = Math.min(a.right, b.right) - Math.max(a.left, b.left);
				if (vOv > 1 && hOv > 0.5) overlap++;
			}
		}
		return {
			names: parts.map((p) => (p.querySelector('.thm-legendName') || {}).textContent || ''),
			titles: parts.map((p) => p.getAttribute('title') || ''),
			boxH: Math.round(boxRect.height * 100) / 100,
			overflow: legend.scrollWidth - legend.clientWidth,
			legendScrollW: legend.scrollWidth,
			legendClientW: legend.clientWidth,
			maxRightDelta: Math.round((Math.max(...rects.map((r) => r.right)) - boxRect.right) * 100) / 100,
			rows: new Set(rects.map((r) => Math.round(r.top))).size,
			overlap,
			donut: [...document.querySelectorAll('.thm-card[aria-label="模型用量"] .thm-modelName')].map((el) => el.textContent),
			donutTitles: [...document.querySelectorAll('.thm-card[aria-label="模型用量"] .thm-modelName')].map((el) => el.getAttribute('title')),
			hint: (box.querySelector('.thm-legendHint') || {}).textContent || null,
			trendCardW: Math.round(card.getBoundingClientRect().width),
		};
	});
	check(`${wLegend}px 图例：展示名去公共前缀（v4.1-flash / workbuddy-ai/v4.1-flash / commandcode/v4.1-flash / 其他）`, JSON.stringify(L.names) === JSON.stringify(LONG_SHORT.concat(['其他'])), L.names);
	check(`${wLegend}px 图例：全名进 title`, LONG_FULL.every((full, i) => (L.titles[i] || '').indexOf(full) === 0), L.titles);
	check(`${wLegend}px 图例：容器不横向溢出（scrollWidth ≤ clientWidth）、每项不越出图例区右缘`, L.overflow <= 0 && L.maxRightDelta <= 0.5, L);
	check(`${wLegend}px 图例：相邻项不重叠、≤2 行（42px 固定高度内）`, L.overlap === 0 && L.rows <= 2 && L.boxH === 42, { overlap: L.overlap, rows: L.rows, boxH: L.boxH });
	check(`${wLegend}px 图例：环形图列表共用同一套展示名（顺序一致）`, JSON.stringify(L.donut) === JSON.stringify(LONG_SHORT.concat(['其他'])) && LONG_FULL.every((full, i) => (L.donutTitles[i] || '').indexOf(full) === 0), { donut: L.donut, titles: L.donutTitles });
	if (wLegend === 500) {
		/* 趋势浮层也用展示名（全名在 title） */
		await pL.locator('.thm-trend').hover({ position: { x: 300, y: 120 } });
		await pL.waitForSelector('.thm-trendTip', { timeout: 5000 });
		const tipNames = await pL.evaluate(() => [...document.querySelectorAll('.thm-trendTip .thm-trendRowName')].map((el) => ({ text: el.textContent, title: el.getAttribute('title') || '' })));
		check('500px 趋势浮层：模型名同样是展示名（全名进 title）', tipNames.some((t) => LONG_SHORT.indexOf(t.text) >= 0) && tipNames.every((t) => t.text === '合计' || t.text === '缓存命中率' || t.text === '无用量' || t.text === '其他' || LONG_FULL.some((full) => t.title.indexOf(full) === 0)), tipNames);
	}
	await pL.locator('.thm-card[aria-label="每日 Token 趋势图"]').screenshot({ path: SHOTS + 'ui-trend-legend-' + wLegend + '.png' });
	console.log(`  info ${wLegend}px 图例：卡片=${L.trendCardW}px  容器 scrollW/clientW=${L.legendScrollW}/${L.legendClientW}  行数=${L.rows}  盒高=${L.boxH}  最右项距右缘=${Math.abs(L.maxRightDelta)}px  名称=${JSON.stringify(L.names)}`);
	check(`场景 17（${wLegend}px）无 pageerror / console.error`, pL.__errors.length === 0, pL.__errors);
}

/* ============================ 场景 18：强制竖向滚动条下热力图不得出现内部横滚 ============================
 * 真机的横向滚动条根因：量宽用了 getBoundingClientRect().width（含滚动条/边框占位）。这里用**不隐藏滚动条**
 * 的浏览器 + 给 .thm-scroll 强加 overflow-y:scroll，制造 rect − clientWidth = 15px 的真实差；
 * 量宽必须走 clientWidth，网格还要留 2px 余量，才能保证 scrollWidth ≤ clientWidth。 */
console.log('\n— 场景 18：强制竖向滚动条');
const sbBrowser = await chromium.launch({ executablePath: CHROME, ignoreDefaultArgs: ['--hide-scrollbars'] });
const sbPage = await mount({
	browserOverride: sbBrowser,
	payloads: MODE_PAYLOADS,
	bare: true,
	viewport: { width: 960, height: 1200 },
	extraCss: 'html{overflow-y:scroll}#root{width:900px}.thm-scroll{overflow-y:scroll !important}',
});
await sbPage.waitForSelector('.thm-cell[data-day]', { timeout: 20000 });
await sbPage.screenshot({ path: SHOTS + 'ui-scrollbar-heat.png' });
const sb = await sbPage.evaluate(() => {
	const s = document.querySelector('.thm-scroll');
	const r = s.getBoundingClientRect();
	const months = [...document.querySelectorAll('.thm-month')].filter((m) => m.textContent);
	const last = months.length ? months[months.length - 1].getBoundingClientRect() : null;
	const cell = document.querySelector('.thm-cell[data-day]');
	return {
		rectW: Math.round(r.width * 100) / 100,
		clientW: s.clientWidth,
		scrollW: s.scrollWidth,
		gutter: Math.round((r.width - s.clientWidth) * 100) / 100,
		monthsInside: last ? last.right <= r.right + 0.5 : null,
		cellW: cell ? Math.round(cell.getBoundingClientRect().width * 100) / 100 : null,
		cols: document.querySelector('.thm-grid') ? getComputedStyle(document.querySelector('.thm-grid')).gridTemplateColumns.split(' ').length : null,
		pageGutter: window.innerWidth - document.documentElement.clientWidth,
	};
});
check('强制竖向滚动条真的占位（rect − clientWidth ≥ 10px，页面竖滚动条 ' + sb.pageGutter + 'px）', sb.gutter >= 10, sb);
check('强制竖向滚动条：.thm-scroll 无内部横向滚动（scrollWidth ≤ clientWidth + 0.5）', sb.scrollW <= sb.clientW + 0.5, sb);
check('强制竖向滚动条：月份轴最后一条标签不越界', sb.monthsInside === true, sb);
check('强制竖向滚动条：格子仍按公式撑满（±0.02px）', sb.cols > 0 && Math.abs(sb.cellW - (sb.clientW - (sb.cols - 1) * gapFor(sb.clientW) - 2) / sb.cols) <= 0.02, sb);
await sbPage.close();
await sbBrowser.close();


/* ============================ 场景 20：鲸元券（Token Bank · 原版 canvas 票面） ============================
 * 移植自 zhu1090093659/dsh-web/packages/dsh-usage（Apache-2.0）：真钞底图 1984×992 + canvas 文字。
 * 口径：1 鲸元 = 1e6 tokens；面额整数（至少 1）；序列号 = 面额%1e9 零填 9 位；
 * 印章红序列号行 `NO.<9 位> <from> - <to>`；票面只含拉丁/数字；保存走 canvas.toBlob('image/png')；
 * 分享仅当 navigator.canShare({files}) 为真；空数据只显示空状态。 */
console.log('\n— 场景 20：鲸元券（canvas 原版）');
const vSrc = readFileSync(CLIENT, 'utf8');
const vRateDecl = (/var TOKENS_PER_WHALE_YUAN = \d+;/.exec(vSrc) || ['var TOKENS_PER_WHALE_YUAN = 1000000;'])[0];
const vfns = new Function(
	vRateDecl + '\n' + grabFn(vSrc, 'isNum') + '\n' + grabFn(vSrc, 'faceValue') + '\n' + grabFn(vSrc, 'voucherSerial') + '\n' + grabFn(vSrc, 'formatDenomination') + '\nreturn { faceValue: faceValue, voucherSerial: voucherSerial, formatDenomination: formatDenomination };',
)();
const VOC = MODE_PAYLOADS.day;
const VOC_TOTAL = VOC.totals.total;
const VOC_FACE = vfns.faceValue(VOC_TOTAL);
const VOC_SERIAL = vfns.voucherSerial(VOC_FACE);
const SPY = () => {
	window.__DRAWS = { image: 0, texts: [] };
	const oi = CanvasRenderingContext2D.prototype.drawImage;
	window.__DRAWS.args = [];
	CanvasRenderingContext2D.prototype.drawImage = function () {
		window.__DRAWS.image++;
		window.__DRAWS.args.push(Array.prototype.slice.call(arguments, 1));
		return oi.apply(this, arguments);
	};
	const of = CanvasRenderingContext2D.prototype.fillText;
	CanvasRenderingContext2D.prototype.fillText = function (t) {
		window.__DRAWS.texts.push(String(t));
		return of.apply(this, arguments);
	};
};
check('① faceValue：1234567890→1235、1086000000000→1086000、42→1、999999→1、1000000→1（整数、至少 1）', vfns.faceValue(1234567890) === 1235 && vfns.faceValue(1086000000000) === 1086000 && vfns.faceValue(42) === 1 && vfns.faceValue(999999) === 1 && vfns.faceValue(1000000) === 1, [vfns.faceValue(1234567890), vfns.faceValue(1086000000000), vfns.faceValue(42), vfns.faceValue(999999), vfns.faceValue(1000000)]);
check('③ voucherSerial：42→"000000042"、123456789→"123456789"、1000000000→"000000000"、1000000042→"000000042"（9 位零填）', vfns.voucherSerial(42) === '000000042' && vfns.voucherSerial(123456789) === '123456789' && vfns.voucherSerial(1000000000) === '000000000' && vfns.voucherSerial(1000000042) === '000000042', [42, 123456789, 1000000000, 1000000042].map((v) => vfns.voucherSerial(v)));
check('② formatDenomination：0→"0"、999→"999"、1234→"1,234"、1234567→"1,234,567"、1234.6→"1,235"', ['0', '999', '1,234', '1,234,567', '1,235'].every((w, i) => vfns.formatDenomination([0, 999, 1234, 1234567, 1234.6][i]) === w), [0, 999, 1234, 1234567, 1234.6].map((v) => vfns.formatDenomination(v)));

const pV = await mount({ payloads: MODE_PAYLOADS, viewport: { width: 900, height: 1800 }, init: SPY });
await pV.waitForSelector('.thm-voucher canvas', { timeout: 15000 });
await pV.waitForTimeout(450);
const voc = await pV.evaluate(() => {
	const card = document.querySelector('.thm-voucher');
	const cv = card.querySelector('canvas.thm-voucherCanvas');
	const cards = [...document.querySelectorAll('.thm-card')];
	const r = cv ? cv.getBoundingClientRect() : null;
	return {
		cardIndex: cards.indexOf(card),
		donutIndex: cards.findIndex((c) => c.getAttribute('aria-label') === '模型用量'),
		title: (card.querySelector('.thm-h3') || {}).textContent || '',
		bank: (card.querySelector('.thm-vocBank') || {}).textContent || '',
		bankPx: card.querySelector('.thm-vocBank') ? parseFloat(getComputedStyle(card.querySelector('.thm-vocBank')).fontSize) : 0,
		hasCanvas: !!cv,
		cw: cv ? cv.width : 0,
		ch: cv ? cv.height : 0,
		cssW: r ? Math.round(r.width * 100) / 100 : 0,
		cssH: r ? Math.round(r.height * 100) / 100 : 0,
		draws: window.__DRAWS,
		buttons: [...card.querySelectorAll('button')].map((b) => b.textContent),
		emptyText: (card.querySelector('.thm-vocEmpty') || {}).textContent || null,
	};
});
check('① 卡片位置：紧跟「模型用量」之后；标题「鲸元券」+ 右上 11px「Token Bank」', voc.cardIndex === voc.donutIndex + 1 && voc.title === '鲸元券' && voc.bank === 'Token Bank' && voc.bankPx === 11, { cardIndex: voc.cardIndex, donutIndex: voc.donutIndex, title: voc.title, bank: voc.bank, bankPx: voc.bankPx });
check('③ 票面是 <canvas> 1984×992，CSS 按 1984:992 比例铺满卡宽', voc.hasCanvas && voc.cw === 1984 && voc.ch === 992 && voc.cssW > 0 && Math.abs(voc.cssH / voc.cssW - 992 / 1984) <= 0.02, { cw: voc.cw, ch: voc.ch, cssW: voc.cssW, cssH: voc.cssH });
const drawn = voc.draws.texts;
const serialLine = drawn.find((t) => /^NO\./.test(t)) || '';
check('⑥ 底图被画：drawImage 调用 1 次、参数 (image, 0, 0, 1984, 992)；面额千分位整数 + whale yuan + 印章红序列号行都画了', voc.draws.image === 1 && JSON.stringify(voc.draws.args) === JSON.stringify([[0, 0, 1984, 992]]) && drawn.includes(vfns.formatDenomination(VOC_FACE)) && drawn.includes('whale yuan') && new RegExp('^NO\\.\\d{9} \\d{4}-\\d{2}-\\d{2} - \\d{4}-\\d{2}-\\d{2}$').test(serialLine), { image: voc.draws.image, args: voc.draws.args, texts: drawn.slice(0, 12), serialLine });
check('③ 票面文本零中文（/\\u4e00-\\u9fa5/ 扫 canvas 实际绘制文本 0 命中）', !drawn.some((t) => /[\u4e00-\u9fa5]/.test(t)), drawn);
check('④ 默认环境（无 navigator.canShare）不渲染分享按钮，只渲染「保存图片」', voc.buttons.length === 1 && voc.buttons[0] === '保存图片', voc.buttons);

/* ④ canShare 为真 → 分享按钮出现 */
const pV3 = await mount({ payloads: MODE_PAYLOADS, viewport: { width: 900, height: 1800 }, init: () => { navigator.canShare = () => true; } });
await pV3.waitForSelector('.thm-voucher canvas', { timeout: 15000 });
const voc3 = await pV3.evaluate(() => [...document.querySelectorAll('.thm-voucher button')].map((b) => b.textContent));
check('④ navigator.canShare({files}) 为真时渲染「分享」按钮（共 2 个按钮）', voc3.length === 2 && voc3.includes('分享'), voc3);

/* ⑤ 空状态：总量 0 → 不画钞票、只有空状态文案、无按钮 */
const VOC_EMPTY = JSON.parse(JSON.stringify(MODE_PAYLOADS));
VOC_EMPTY.day.totals.total = 0;
const pV4 = await mount({ payloads: VOC_EMPTY, viewport: { width: 900, height: 1800 } });
await pV4.waitForSelector('.thm-voucher', { timeout: 15000 });
const voc4 = await pV4.evaluate(() => {
	const card = document.querySelector('.thm-voucher');
	return { hasCanvas: !!card.querySelector('canvas'), emptyText: (card.querySelector('.thm-vocEmpty') || {}).textContent || null, buttons: [...card.querySelectorAll('button')].map((b) => b.textContent) };
});
check('⑤ 空数据：不画钞票、显示「还没有可铸造的用量」、保存/分享按钮都不渲染', !voc4.hasCanvas && voc4.emptyText === '还没有可铸造的用量' && voc4.buttons.length === 0, voc4);

/* ⑥ 保存：canvas.toBlob('image/png') → 拦截 toBlob/createObjectURL/anchor.click，断言拿到 PNG blob 且文件名带序列号 */
await pV.evaluate(() => {
	window.__PNG = null;
	window.__DL = null;
	const origToBlob = HTMLCanvasElement.prototype.toBlob;
	HTMLCanvasElement.prototype.toBlob = function (cb, type) {
		origToBlob.call(this, function (b) {
			window.__PNG = { type: b && b.type, size: b && b.size };
			if (cb) cb(b);
		}, type);
	};
	HTMLAnchorElement.prototype.click = function () {
		if (this.download) window.__DL = this.download;
	};
});
await pV.click('[data-act="save"]');
const png = await pV.waitForFunction(() => window.__PNG, null, { timeout: 20000 }).then((h) => h.jsonValue());
const dl = await pV.evaluate(() => window.__DL);
check('⑩ 源码里旧 SVG 票面实现已删干净（voucherSvg / freezeVoucherSvg / exportVoucherPng / fmtMoney2 / fmtLatinCompact / VOUCHER_RATE 各 0 处）', ['voucherSvg', 'freezeVoucherSvg', 'exportVoucherPng', 'fmtMoney2', 'fmtLatinCompact', 'VOUCHER_RATE'].every((k) => vSrc.indexOf(k) < 0), ['voucherSvg', 'freezeVoucherSvg', 'exportVoucherPng', 'fmtMoney2', 'fmtLatinCompact', 'VOUCHER_RATE'].filter((k) => vSrc.indexOf(k) >= 0));
check('⑨ 保存图片：canvas.toBlob 得到 image/png blob（size > 0），文件名 whale-voucher-NO.<9 位序列号>.png', !!png && png.type === 'image/png' && png.size > 0 && dl === 'whale-voucher-NO.' + VOC_SERIAL + '.png', { png, dl, want: 'whale-voucher-NO.' + VOC_SERIAL + '.png' });

/* 截图：亮色 + 暗色 */
await pV.locator('.thm-voucher').screenshot({ path: SHOTS + 'ui-voucher.png' });
await pV.evaluate(() => document.body.classList.add('dark'));
await pV.waitForTimeout(150);
await pV.locator('.thm-voucher').screenshot({ path: SHOTS + 'ui-voucher-dark.png' });
await pV.evaluate(() => document.body.classList.remove('dark'));

/* ============================ 收尾 ============================ */
console.log('\n— 四种 today × 八个宽度（真机回归矩阵）');
for (const r of todayReport) console.log(`      ${r.today} ${String(r.w).padStart(4)}px  请求=${String(r.req).padStart(2)} 周  列数=${String(r.cols).padStart(2)}  窗口=${r.days} 天  cell=${r.cell.toFixed(2)}px`);
console.log('\n— 首帧帧序列（列数 / cell / 时间）');
for (const r of firstFrameReport) {
	console.log(`      ${r.w}px  最终 列数=${r.cols} cell=${r.cell}px  请求=${r.calls.join(',')}`);
	console.log('        ' + r.frames.map((f) => `t${f.t}ms:${f.cols}列/${f.w}px`).join('  '));
}
for (const p of pages) await p.close();
await browser.close();

console.log('\n断言 ' + checks + ' 项，失败 ' + failures + ' 项');
console.log('截图：' + SHOTS + 'ui-stats-heatmap.png / ui-heatmap-tooltip.png / ui-trend-donut.png / ui-trend-tooltip.png / ui-real-host.png / ui-dark-fixed.png');
console.log('      ' + SHOTS + 'ui-w{380,420,500,560,662,720,860,1000,1141,1200}-fixed.png / ui-w{380,500,662,720}-heat.png / ui-w{380,420,500,662,720}-trend.png / ui-w1141-{heat,trend}.png / ui-dark-trend.png');
process.exit(failures === 0 ? 0 : 1);
