/**
 * 宿主半 payload 冒烟：真会话日志 × 三种 mode，逐条对 CONTRACT v2 的 §1 字段 / §2 口径 / §3 mode 断言。
 *
 * 零依赖：只用 node: 内置模块 + 本包 src/*。断言分三类：
 *  ① 形状：三种 mode 的 Payload 字段齐全、类型正确、老字段语义不变；
 *  ② mode 语义：day = 当天 total；week 同周各天 value/level 相同；cum 单调不减且等于窗口累计；
 *  ③ 手工复算：另起一遍独立解析（自己的 JSON 解析 + 自己的分档/断点循环），
 *     核对 allTime 的 total / activeDays / rounds / peak / 两个 streak / longestSpanMs。
 */
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { existsSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TokenHeatmapService, addDays, weekday } from '../src/cordis.js';
import { listSessionLogs, readZstdJsonl, timeOf, usageOf, weekStartOf } from '../src/scan.js';

const tzOffsetMinutes = -new Date().getTimezoneOffset();
/**
 * 会话根：优先用 verifier 冻结的快照（数据不漂，能钉住口径），否则退回本机真日志。
 * 覆盖顺序：HEATMAP_SESSIONS > _verify/_snapshot/sessions > $DSH_HOME/sessions > ~/.dsh/sessions。
 */
const liveRoot = process.env.DSH_HOME ? join(process.env.DSH_HOME, 'sessions') : join(homedir(), '.dsh', 'sessions');
const snapshotRoot = fileURLToPath(new URL('../../_verify/_snapshot/sessions', import.meta.url));
const usingSnapshot = !process.env.HEATMAP_SESSIONS && existsSync(snapshotRoot) && statSync(snapshotRoot).isDirectory();
const root = process.env.HEATMAP_SESSIONS || (usingSnapshot ? snapshotRoot : liveRoot);
const WEEKS = 26;
const SPAN_GAP_MS = 30 * 60 * 1000;
const DAY_MS = 86400000;

let checked = 0;
let failed = 0;
const show = v => (typeof v === 'object' ? JSON.stringify(v) : String(v));
function ok(cond, msg) {
  checked++;
  if (!cond) {
    failed++;
    console.error(`  ✗ ${msg}`);
  }
}
const eq = (actual, expected, msg) => ok(Object.is(actual, expected), `${msg}（实际 ${show(actual)} ≠ 期望 ${show(expected)}）`);
const same = (a, b, msg) => ok(JSON.stringify(a) === JSON.stringify(b), `${msg}（实际 ${show(a).slice(0, 200)}）`);

const files = listSessionLogs(root);
if (files.length === 0) {
  console.error(`没有会话日志可跑：${root}（用 DSH_HOME 指定 .dsh 根目录）`);
  process.exit(1);
}
console.log(`数据集 ${root}${usingSnapshot ? '（verifier 冻结快照）' : '（本机真日志，可能在漂）'}：${files.length} 个会话日志，tz=${tzOffsetMinutes}`);

// ───────────────────────── ① 调服务：三种 mode + 重复调用 ─────────────────────────
/* 账本隔离：这个冒烟用「冻结快照」当数据源，必须配一个临时账本，否则会读到真实 HOME 的账本
 * （两套数据混在一起，快照断言全错）。 */
const ledgerPath = join(tmpdir(), 'dsh-token-ledger-smoke-' + process.pid + '-' + Date.now(), 'ledger.v1.json');
const svc = new TokenHeatmapService({ logger: console }, { weeks: WEEKS, ttlMs: 300000, sessionsHome: root, ledgerPath });
const day = await svc.heatmap({ weeks: WEEKS, mode: 'day', tzOffsetMinutes });
const week = await svc.heatmap({ weeks: WEEKS, mode: 'week', tzOffsetMinutes });
const cum = await svc.heatmap({ weeks: WEEKS, mode: 'cum', tzOffsetMinutes });
const dayAgain = await svc.heatmap({ weeks: WEEKS, mode: 'day', tzOffsetMinutes });
const modes = [['day', day], ['week', week], ['cum', cum]];

const PAYLOAD_FIELDS = ['generatedAt', 'tzOffsetMinutes', 'sessionsRoot', 'weeks', 'mode', 'window', 'stats', 'scale', 'totals', 'days', 'allTime', 'cached'];
const STATS_FIELDS = ['files', 'reusedFiles', 'usageEvents', 'parsedLines', 'badLines', 'scanMs'];
const TOTALS_FIELDS = ['total', 'newTokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'rounds', 'days', 'hitRate'];
const DAY_FIELDS = ['day', 'total', 'newTokens', 'input', 'output', 'cacheRead', 'cacheWrite', 'requests', 'rounds', 'hitRate', 'level', 'value', 'models'];
const ALLTIME_FIELDS = ['total', 'activeDays', 'rounds', 'peak', 'currentStreak', 'longestStreak', 'longestSpanMs'];

for (const [mode, res] of modes) {
  for (const f of PAYLOAD_FIELDS) ok(f in res, `[${mode}] payload 缺字段 ${f}`);
  eq(res.mode, mode, `[${mode}] payload.mode`);
  eq(res.weeks, WEEKS, `[${mode}] payload.weeks`);
  eq(res.tzOffsetMinutes, tzOffsetMinutes, `[${mode}] payload.tzOffsetMinutes`);
  eq(res.sessionsRoot, root, `[${mode}] payload.sessionsRoot`);
  ok(typeof res.generatedAt === 'string' && !Number.isNaN(Date.parse(res.generatedAt)), `[${mode}] generatedAt 可解析`);
  eq(res.cached, false, `[${mode}] 首跑 cached`);

  for (const f of STATS_FIELDS) ok(typeof res.stats[f] === 'number', `[${mode}] stats.${f} 是数字`);
  ok(typeof res.stats.decompressedFiles === 'number', `[${mode}] stats.decompressedFiles（加法字段）是数字`);
  ok(res.stats.files > 0 && res.stats.files <= files.length + 8 && res.stats.usageEvents > 0, `[${mode}] stats 计数合理（files=${res.stats.files} events=${res.stats.usageEvents}）`);

  // §1 window：from 必须是周一，days 升序、落在窗口内、只含有量的天
  ok(res.window.from <= res.window.to, `[${mode}] window.from ≤ to`);
  eq(weekday(res.window.from), 1, `[${mode}] window.from 是周一`);
  ok(res.days.length > 0, `[${mode}] days 非空`);
  let prevDay = '';
  for (const d of res.days) {
    for (const f of DAY_FIELDS) ok(f in d, `[${mode}] day ${d.day} 缺字段 ${f}`);
    ok(d.day > prevDay, `[${mode}] days 升序（${prevDay} → ${d.day}）`);
    prevDay = d.day;
    ok(d.day >= res.window.from && d.day <= res.window.to, `[${mode}] ${d.day} 在窗口内`);
    ok(d.total > 0 && d.value >= 0, `[${mode}] ${d.day} total/value 非负且有量`);
    ok(Number.isInteger(d.level) && d.level >= 0 && d.level <= 6, `[${mode}] ${d.day} level ∈ 0…6`);
    ok(Number.isInteger(d.rounds) && d.rounds >= 0, `[${mode}] ${d.day} rounds 是非负整数`);
    ok(d.hitRate === null || (d.hitRate >= 0 && d.hitRate <= 1), `[${mode}] ${d.day} hitRate 口径`);
    const models = d.models;
    ok(Array.isArray(models) && models.length > 0, `[${mode}] ${d.day} models 非空`);
    for (let i = 1; i < models.length; i++) ok(models[i - 1].total >= models[i].total, `[${mode}] ${d.day} models 按 total 降序`);
  }

  for (const f of TOTALS_FIELDS) ok(f in res.totals, `[${mode}] totals 缺字段 ${f}`);
  eq(res.totals.days, res.days.length, `[${mode}] totals.days = days 长度`);
  eq(res.totals.rounds, res.days.reduce((n, d) => n + d.rounds, 0), `[${mode}] totals.rounds = Σ days[].rounds`);
  eq(res.totals.total, res.days.reduce((n, d) => n + d.total, 0), `[${mode}] totals.total = Σ days[].total`);

  eq(res.scale.metric, 'total', `[${mode}] scale.metric`);
  eq(res.scale.mode, mode, `[${mode}] scale.mode 随 mode 变`);
  eq(res.scale.max, Math.max(0, ...res.days.map(d => d.value)), `[${mode}] scale.max = 窗口 value 最大值`);
  ok(res.scale.cuts === null || (Array.isArray(res.scale.cuts) && res.scale.cuts.length === 5), `[${mode}] scale.cuts 为 null 或 5 个阈值`);
  if (Array.isArray(res.scale.cuts)) for (let i = 1; i < res.scale.cuts.length; i++) ok(res.scale.cuts[i - 1] <= res.scale.cuts[i], `[${mode}] scale.cuts 非降`);
  eq(res.scale.legend.length, 6, `[${mode}] legend 六档`);
  for (let i = 0; i < 6; i++) eq(res.scale.legend[i].level, i + 1, `[${mode}] legend[${i}].level`);
  eq(res.scale.legend[0].min, null, `[${mode}] legend 第 1 档 min=null`);
  eq(res.scale.legend[5].max, null, `[${mode}] legend 第 6 档 max=null`);
  if (Array.isArray(res.scale.cuts)) {
    eq(res.scale.legend[0].max, res.scale.cuts[0], `[${mode}] legend[0].max = cuts[0]`);
    eq(res.scale.legend[5].min, res.scale.cuts[4], `[${mode}] legend[5].min = cuts[4]`);
  }

  for (const f of ALLTIME_FIELDS) ok(f in res.allTime, `[${mode}] allTime 缺字段 ${f}`);
  ok(res.allTime.total >= res.totals.total, `[${mode}] allTime.total ≥ 窗口 total`);
  ok(res.allTime.rounds >= res.totals.rounds, `[${mode}] allTime.rounds ≥ 窗口 rounds`);
  ok(res.allTime.activeDays >= res.days.length, `[${mode}] allTime.activeDays ≥ 窗口天数`);
  ok(res.allTime.peak.day === null || /^\d{4}-\d{2}-\d{2}$/.test(res.allTime.peak.day), `[${mode}] allTime.peak.day 形态`);
  ok(res.allTime.longestSpanMs >= 0 && res.allTime.currentStreak >= 0 && res.allTime.longestStreak >= res.allTime.currentStreak, `[${mode}] allTime streak/span 合理`);
}

// ───────────────────────── ② mode 语义 + 缓存硬指标 ─────────────────────────
same(day.totals, week.totals, 'totals 不随 mode 变（day = week）');
same(day.totals, cum.totals, 'totals 不随 mode 变（day = cum）');
same(day.allTime, week.allTime, 'allTime 不随 mode 变（day = week）');
same(day.allTime, cum.allTime, 'allTime 不随 mode 变（day = cum）');
eq(dayAgain.cached, true, '同参数重复调用走载荷缓存');
eq(dayAgain.stats.reusedFiles, dayAgain.stats.files, `换回 day 也走缓存：reusedFiles=${dayAgain.stats.reusedFiles}/${dayAgain.stats.files}`);
eq(dayAgain.stats.decompressedFiles, 0, '换回 day 解压文件数 = 0');
same(dayAgain.totals, day.totals, '缓存命中的 payload 与首次一致');

for (const [mode, res] of [['week', week], ['cum', cum]]) {
  console.log(`  换 mode 复用：${mode} → reusedFiles=${res.stats.reusedFiles}/${res.stats.files}，decompressedFiles=${res.stats.decompressedFiles}，scanMs=${res.stats.scanMs}`);
  eq(res.stats.reusedFiles, res.stats.files, `[${mode}] 换 mode 不重新解压：reusedFiles === files`);
  eq(res.stats.decompressedFiles, 0, `[${mode}] 换 mode 解压文件数 = 0`);
}

// day：value = 当天 total
for (const d of day.days) eq(d.value, d.total, `day 模式 ${d.day} value = total`);

// week：同周各天 value/level 相同，且 = 该周窗口内各天 total 之和
const weekGroups = new Map();
for (const d of week.days) {
  const monday = weekStartOf(d.day);
  const g = weekGroups.get(monday) ?? [];
  g.push(d);
  weekGroups.set(monday, g);
}
ok(weekGroups.size > 1, `week 模式覆盖多周（${weekGroups.size} 周）`);
for (const [monday, group] of weekGroups) {
  const value = group[0].value;
  const level = group[0].level;
  ok(group.every(d => d.value === value), `week 同周（${monday}）value 相同：${group.map(d => `${d.day}=${d.value}`).join(' ')}`);
  ok(group.every(d => d.level === level), `week 同周（${monday}）level 相同 = ${level}`);
  eq(value, group.reduce((n, d) => n + d.total, 0), `week（${monday}）value = 该周各天 total 之和`);
  ok(value > 0, `week（${monday}）value > 0`);
}
ok(week.days.some(d => d.value !== d.total), 'week 模式 value 确实不同于当天 total（口径生效）');

// cum：单调不减，且 = 窗口起点到该天的累计
let acc = 0;
for (let i = 0; i < cum.days.length; i++) {
  acc += cum.days[i].total;
  eq(cum.days[i].value, acc, `cum ${cum.days[i].day} value = 窗口累计`);
  if (i > 0) ok(cum.days[i].value >= cum.days[i - 1].value, `cum ${cum.days[i].day} 单调不减`);
}
eq(cum.days[cum.days.length - 1].value, cum.totals.total, 'cum 末值 = 窗口 total');
ok(cum.days.some(d => d.value !== d.total), 'cum 模式 value 确实不同于当天 total（口径生效）');

// ───────────────────────── ③ 手工复算 allTime ─────────────────────────
// 独立解析：自己的 JSON 解析 + 自己的汇总/断点循环，只借用 readZstdJsonl / timeOf / usageOf
// 这三个「老口径」工具函数（本次要验的不是它们）。
function manualPass(filesNow) {
  const dayTotals = new Map();
  const stampsBySession = new Map();
  let userMessageEvents = 0;
  let roundEvents = 0;
  for (const file of filesNow) {
    const sessionId = file.split(/[\\/]/).slice(-2, -1)[0] ?? file;
    let text;
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(file).mtimeMs;
      text = readZstdJsonl(file);
    } catch {
      continue;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      const t = timeOf(ev) ?? mtimeMs;
      const stamps = stampsBySession.get(sessionId) ?? [];
      stamps.push(t);
      stampsBySession.set(sessionId, stamps);
      const u = usageOf(ev);
      if (u) {
        const d = new Date(t + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
        dayTotals.set(d, (dayTotals.get(d) ?? 0) + u.total);
      }
      if (ev?.type === 'user/message') {
        userMessageEvents++;
        if (ev?.data?.source?.kind === 'user') roundEvents++;
      }
    }
  }

  const shift = (key, n) => new Date(Date.parse(`${key}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
  const out = { total: 0, activeDays: 0, rounds: roundEvents, peak: { day: null, total: 0 }, currentStreak: 0, longestStreak: 0, longestSpanMs: 0 };
  const activeDays = [];
  for (const d of [...dayTotals.keys()].sort()) {
    const total = dayTotals.get(d);
    out.total += total;
    if (total > 0) activeDays.push(d);
    if (total > out.peak.total) out.peak = { day: d, total };
  }
  out.activeDays = activeDays.length;

  let run = 0;
  let prev = null;
  for (const d of activeDays) {
    run = prev !== null && shift(prev, 1) === d ? run + 1 : 1;
    if (run > out.longestStreak) out.longestStreak = run;
    prev = d;
  }
  const activeSet = new Set(activeDays);
  const todayKey = new Date(Date.now() + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
  let cursor = activeSet.has(todayKey) ? todayKey : shift(todayKey, -1);
  while (activeSet.has(cursor)) {
    out.currentStreak++;
    cursor = shift(cursor, -1);
  }

  let nakedSpanMax = 0;
  for (const stamps of stampsBySession.values()) {
    const ts = [...stamps].sort((a, b) => a - b);
    if (ts.length === 0) continue;
    if (ts[ts.length - 1] - ts[0] > nakedSpanMax) nakedSpanMax = ts[ts.length - 1] - ts[0];
    let start = ts[0];
    for (let i = 1; i <= ts.length; i++) {
      if (i === ts.length || ts[i] - ts[i - 1] > SPAN_GAP_MS) {
        if (ts[i - 1] - start > out.longestSpanMs) out.longestSpanMs = ts[i - 1] - start;
        start = ts[i];
      }
    }
  }
  return { manual: out, userMessageEvents, roundEvents, nakedSpanMax };
}

// 复算与取样之间日志可能被并发会话追加：数据面变了就整轮重算，最多 3 次。
const datasetStamp = () => {
  const m = new Map();
  for (const f of listSessionLogs(root)) {
    const st = statSync(f);
    m.set(f, `${st.mtimeMs}:${st.size}`);
  }
  return m;
};
const sameStamp = (a, b) => a.size === b.size && [...a].every(([k, v]) => b.get(k) === v);

let fresh = null;
let manual = null;
let userMessageEvents = 0;
let roundEvents = 0;
let nakedSpanMax = 0;
for (let attempt = 1; attempt <= 3; attempt++) {
  const before = datasetStamp();
  ({ manual, userMessageEvents, roundEvents, nakedSpanMax } = manualPass(files));
  fresh = await svc.heatmap({ weeks: WEEKS, mode: 'day', tzOffsetMinutes, refresh: true });
  const after = datasetStamp();
  const a = fresh.allTime;
  const diffs = ALLTIME_FIELDS.filter(f => JSON.stringify(a[f]) !== JSON.stringify(manual[f]));
  if (diffs.length === 0) break;
  if (attempt < 3 && !sameStamp(before, after)) {
    console.log(`  … 第 ${attempt} 次复算期间会话日志被追加（${diffs.join(',')}），整轮重算`);
    continue;
  }
  console.error(`  复算差异（第 ${attempt} 次）：${diffs.map(f => `${f} 实际=${show(a[f])} 期望=${show(manual[f])}`).join('；')}`);
  break;
}

const at = fresh.allTime;
eq(at.total, manual.total, 'allTime.total = 手工复算');
eq(at.activeDays, manual.activeDays, 'allTime.activeDays = 手工复算');
eq(at.rounds, manual.rounds, 'allTime.rounds = 手工复算（只数 source.kind === "user"）');
same(at.peak, manual.peak, 'allTime.peak = 手工复算');
eq(at.currentStreak, manual.currentStreak, 'allTime.currentStreak = 手工复算');
eq(at.longestStreak, manual.longestStreak, 'allTime.longestStreak = 手工复算');
eq(at.longestSpanMs, manual.longestSpanMs, 'allTime.longestSpanMs = 手工复算（30 分钟断点）');
ok(userMessageEvents > roundEvents * 2, `轮消息过滤生效：user/message 共 ${userMessageEvents} 条，真实用户发言只有 ${roundEvents} 条`);
ok(nakedSpanMax > at.longestSpanMs * 10, `最长活跃段不是首末相减（首末最大 ${nakedSpanMax} ms ≫ 活跃段 ${at.longestSpanMs} ms）`);
ok(fresh.stats.files >= files.length, `stats.files(${fresh.stats.files}) ≥ 开跑时列到的 ${files.length} 个日志`);
ok(fresh.stats.reusedFiles + fresh.stats.decompressedFiles === fresh.stats.files, `refresh 后 reusedFiles(${fresh.stats.reusedFiles}) + decompressedFiles(${fresh.stats.decompressedFiles}) = files`);

if (usingSnapshot) {
  // 快照已冻结（verifier 附 sha256 清单），这里钉死口径参照值；真目录会漂，不做这些断言。
  const FROZEN = {
    files: 50,
    usageEvents: 7388,
    parsedLines: 46937,
    badLines: 0,
    total: 2012531272,
    activeDays: 11,
    rounds: 174,
    peak: { day: '2026-10-05', total: 1279329191 },
    longestStreak: 5,
    longestSpanMs: 30115876,
  };
  eq(files.length, FROZEN.files, '快照 files');
  eq(day.stats.files, FROZEN.files, '快照 stats.files');
  eq(day.stats.parsedLines, FROZEN.parsedLines, '快照冷跑 stats.parsedLines');
  eq(day.stats.badLines, FROZEN.badLines, '快照冷跑 stats.badLines');
  eq(day.stats.usageEvents, FROZEN.usageEvents, '快照冷跑 stats.usageEvents');
  eq(fresh.stats.usageEvents, FROZEN.usageEvents, '快照暖跑 stats.usageEvents 不丢');
  eq(fresh.stats.decompressedFiles, 0, '快照暖跑 refresh：全部命中文件记忆，没有重新解压');
  eq(at.total, FROZEN.total, '快照 allTime.total');
  eq(at.activeDays, FROZEN.activeDays, '快照 allTime.activeDays');
  eq(at.rounds, FROZEN.rounds, '快照 allTime.rounds');
  same(at.peak, FROZEN.peak, '快照 allTime.peak');
  eq(at.longestStreak, FROZEN.longestStreak, '快照 allTime.longestStreak');
  eq(at.longestSpanMs, FROZEN.longestSpanMs, '快照 allTime.longestSpanMs = 8h21m55.9s');
  ok(at.longestSpanMs < 86400000, `最长活跃段 < 24h（首末相减会得到约 ${Math.round(nakedSpanMax / 3600000)}h）`);
}

const fmtSpan = ms => `${Math.floor(ms / 3600000)}h${String(Math.round((ms % 3600000) / 60000)).padStart(2, '0')}m`;
console.log(
  `allTime: total=${at.total} activeDays=${at.activeDays} rounds=${at.rounds} peak=${at.peak.day}/${at.peak.total} ` +
    `currentStreak=${at.currentStreak} longestStreak=${at.longestStreak} longestSpanMs=${at.longestSpanMs}（${fmtSpan(at.longestSpanMs)}）`,
);
console.log(`窗口(${day.window.from} → ${day.window.to}): days=${day.days.length} total=${day.totals.total} rounds=${day.totals.rounds} requests=${day.totals.requests}`);

console.log(failed === 0 ? `\npayload.smoke 通过：${checked} 项断言全过` : `\npayload.smoke 失败：${failed}/${checked} 项断言不通过`);
process.exit(failed === 0 ? 0 : 1);
