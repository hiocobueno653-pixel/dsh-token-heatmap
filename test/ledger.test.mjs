/**
 * 追加式账本回归（任务 task-26）。
 *
 * 用临时目录造 3 个会话日志（其中 1 个在 `.archive-trash`），覆盖：
 *  ① 首次建账 == 全量扫描逐项相等  ② 二次调用 newEvents=0  ③ 追加只算新的且旧日不变
 *  ④ 删掉已入账文件后数值完全不变  ⑤ 移动/归档不改数  ⑥ 截断/重写不翻倍
 *  ⑦ 原子写无 .tmp 残留            ⑧ 损坏可重建      ⑨ tz 固定
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';

const ROOT = join(tmpdir(), 'dsh-ledger-' + process.pid + '-' + Date.now());
const HOME = join(ROOT, 'home');
const SESS = join(HOME, 'sessions');
const LEDGER = join(HOME, 'dsh-token-usage', 'ledger.v1.json');
process.env.DSH_HOME = HOME;

const { TokenHeatmapService } = await import('../src/cordis.js');
const { bucketByDay, bucketRoundsByDay, createScanner } = await import('../src/scan.js');
const { loadLedger } = await import('../src/ledger.js');

const DAY = 86400000;
const TZ = 480;
const NOW = Date.now();

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) {
    pass++;
    console.log('  ok   ' + name);
  } else {
    fails.push(name);
    console.log('  FAIL ' + name + (detail === undefined ? '' : ' - ' + JSON.stringify(detail)));
  }
}

/* ---------- fixture：多帧 zstd 会话日志 ---------- */
const usage = (t, model, input, output, cacheRead, cacheWrite = 0) =>
  JSON.stringify({ type: 'assistant/message', time: t, data: { usage: { inputTokens: input, outputTokens: output, cacheReadTokens: cacheRead, cacheWriteTokens: cacheWrite }, message: { source: { model } } } });
const userRound = t => JSON.stringify({ type: 'user/message', time: t, data: { source: { kind: 'user' }, message: { role: 'user' } } });

const FILE_A = join(SESS, 'ws1', 'sess-a', 'session.v4.jsonl.zstd');
const FILE_B = join(SESS, 'ws1', 'sess-b', 'session.v4.jsonl.zstd');
const FILE_C = join(HOME, '.archive-trash', 'ws2', 'sess-c', 'session.v4.jsonl.zstd');

const linesA = [
  usage(NOW - 2 * DAY, 'deepseek/deepseek-v4.1-flash', 100, 50, 1000),
  usage(NOW - 2 * DAY + 60000, 'deepseek/deepseek-v4.1-flash', 10, 5, 100),
  userRound(NOW - 2 * DAY + 120000),
  usage(NOW - 1 * DAY, 'deepseek/deepseek-v4.1-pro', 200, 80, 2000),
];
const linesB = [usage(NOW - 2 * DAY, 'group/auto', 300, 120, 3000), userRound(NOW - 5 * DAY)];
const linesC = [usage(NOW - 5 * DAY, 'deepseek/deepseek-v4.1-flash', 400, 160, 4000), usage(NOW - 4 * DAY, 'deepseek/deepseek-v4.1-flash', 500, 200, 5000)];
/* C 存成两帧：后面截断测试只保留第一帧（文件变小但仍是合法 zstd） */
const cFrame1 = zstdCompressSync(Buffer.from(linesC[0] + '\n'));
const cFrame2 = zstdCompressSync(Buffer.from(linesC[1] + '\n'));

function zstdFile(file, lines) {
  mkdirSync(dirname(file), { recursive: true });
  const half = Math.max(1, Math.ceil(lines.length / 2));
  const frames = [zstdCompressSync(Buffer.from(lines.slice(0, half).join('\n') + '\n'))];
  if (lines.length > half) frames.push(zstdCompressSync(Buffer.from(lines.slice(half).join('\n') + '\n')));
  writeFileSync(file, Buffer.concat(frames));
}
zstdFile(FILE_A, linesA);
zstdFile(FILE_B, linesB);
mkdirSync(dirname(FILE_C), { recursive: true });
writeFileSync(FILE_C, Buffer.concat([cFrame1, cFrame2]));

/* ---------- 期望值：直接全量扫描 + 分桶（与账本无关） ---------- */
function summaryOf(map) {
  return [...map]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([day, b]) => ({
      day,
      total: b.total,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      newTokens: b.newTokens,
      requests: b.requests,
      models: [...b.models.values()]
        .map(m => ({ model: m.model, total: m.total, input: m.input, output: m.output, cacheRead: m.cacheRead, requests: m.requests }))
        .sort((x, y) => (x.model < y.model ? -1 : 1)),
    }));
}
const roots = [SESS, join(HOME, '.archive-trash')];
const scan = createScanner()(roots);
const fullBuckets = bucketByDay(scan.facts, TZ);
const fullRounds = bucketRoundsByDay(scan.roundTimes, TZ);
const fullSummary = summaryOf(fullBuckets);

const svc = new TokenHeatmapService({ reflect: { provide() {} }, logger: {} }, { sessionsHome: SESS, ledgerPath: LEDGER, ttlMs: 0, includeArchive: true });
const query = { weeks: 52, mode: 'day', tzOffsetMinutes: TZ };
const totOf = days => (days || []).reduce((s, d) => s + d.total, 0);

/* ---------- ① 首次建账 == 全量扫描 ---------- */
console.log('\n— ① 首次建账 vs 全量扫描');
const p1 = await svc.heatmap(query);
const led1 = loadLedger(LEDGER).ledger;
const ledgerSummary = summaryOf(
  new Map(
    Object.entries(led1.days)
      .filter(([, b]) => b.requests > 0)
      .map(([day, b]) => [
        day,
        {
          ...b,
          models: new Map(Object.entries(b.models).map(([name, m]) => [name, { model: name, ...m }])),
        },
      ]),
  ),
);
check('① 首次账本 days == 全量扫描分桶（每天 7 个字段 + 模型明细逐项相等）', JSON.stringify(ledgerSummary) === JSON.stringify(fullSummary), { ledger: ledgerSummary, scan: fullSummary });
check('① 首次调用 newEvents == 扫描到的事件数、ledgerEvents 同步', p1.stats.newEvents === scan.facts.length && p1.stats.ledgerEvents === scan.facts.length, { newEvents: p1.stats.newEvents, ledgerEvents: p1.stats.ledgerEvents, scan: scan.facts.length });
check('① ledgerRebuilt=false、tz=480、账本文件存在', p1.stats.ledgerRebuilt === false && p1.stats.ledgerPath === LEDGER && led1.tzOffsetMinutes === TZ && existsSync(LEDGER), { stats: p1.stats, tz: led1.tzOffsetMinutes });
check('① 轮次：账本里「只有轮消息没有用量」的那天不进 days、但 allTime.rounds 计入', p1.days.every(d => d.total > 0) && p1.allTime.rounds === [...fullRounds.values()].reduce((s, n) => s + n, 0), { days: p1.days.length, rounds: p1.allTime.rounds });
check('① 窗口 totals == 账本 days 求和（账本与载荷自洽）', p1.totals.total === totOf(p1.days) && p1.totals.total === totOf(fullSummary), { total: p1.totals.total, rows: totOf(p1.days), scan: totOf(fullSummary) });

/* ---------- ② 二次调用不重复 ---------- */
console.log('\n— ② 二次调用');
const p2 = await svc.heatmap(query);
check('② 连续两次调用：newEvents=0、ledgerEvents 不变、totals 不变', p2.stats.newEvents === 0 && p2.stats.ledgerEvents === p1.stats.ledgerEvents && p2.totals.total === p1.totals.total, { newEvents: p2.stats.newEvents, ev: p2.stats.ledgerEvents, total: p2.totals.total });

/* ---------- ③ 追加只算新的 ---------- */
console.log('\n— ③ 追加一条新事件');
const before3 = JSON.parse(JSON.stringify(p2.days));
const appendT = NOW - 0 * DAY + 60000; // 今天
const appendModel = 'deepseek/deepseek-v4.1-flash';
appendFileSync(FILE_A, zstdCompressSync(Buffer.from(usage(appendT, appendModel, 999, 111, 2222) + '\n')));
const p3 = await svc.heatmap(query);
/* 只比数值字段：level/value 由窗口分位算出，新增一天会让阈值整体移动（不是“旧日被改账”） */
const numOf = d => JSON.stringify({ total: d.total, input: d.input, output: d.output, cacheRead: d.cacheRead, cacheWrite: d.cacheWrite, newTokens: d.newTokens, requests: d.requests, rounds: d.rounds, models: d.models });
const changedDays = p3.days.filter(d => numOf(d) !== numOf(before3.find(x => x.day === d.day) || {}));
const appendDay = new Date(appendT + TZ * 60000).toISOString().slice(0, 10);
const appendRow = p3.days.find(d => d.day === appendDay);
check('③ 追加后 newEvents=1，只有「新事件那天」的数值变了（+3332），旧日数值一位不变', p3.stats.newEvents === 1 && changedDays.length === 1 && changedDays[0].day === appendDay && appendRow && appendRow.total === 999 + 111 + 2222 && before3.every(d => d.day === appendDay || numOf(d) === numOf(p3.days.find(x => x.day === d.day)), {}), { newEvents: p3.stats.newEvents, changed: changedDays.map(d => d.day), appendDay, row: appendRow && appendRow.total, before: before3.map(d => [d.day, d.total]) });

/* ---------- ④ 冻结：删掉已入账文件不改数 ---------- */
console.log('\n— ④ 删除已入账文件（冻结）');
const before4 = { total: p3.totals.total, days: JSON.stringify(p3.days.sort((a, b) => (a.day < b.day ? -1 : 1))), allTime: JSON.stringify(p3.allTime) };
rmSync(dirname(FILE_B), { recursive: true, force: true });
const p4 = await svc.heatmap(query);
check('④ 删除已入账文件后 totals/days/allTime 完全不变（冻结）', p4.totals.total === before4.total && JSON.stringify([...p4.days].sort((a, b) => (a.day < b.day ? -1 : 1))) === before4.days && JSON.stringify(p4.allTime) === before4.allTime, { before: before4.total, after: p4.totals.total, newEvents: p4.stats.newEvents });
check('④ 文件消失后账本 files 索引移除该文件（数字保留）', !Object.keys(loadLedger(LEDGER).ledger.files).some(k => k.includes('sess-b')), Object.keys(loadLedger(LEDGER).ledger.files));

/* ---------- ⑤ 移动/归档不改数 ---------- */
console.log('\n— ⑤ 会话从 sessions 移到 .archive-trash');
const before5 = { total: p4.totals.total, days: JSON.stringify([...p4.days].sort((a, b) => (a.day < b.day ? -1 : 1))) };
mkdirSync(join(HOME, '.archive-trash', 'ws1'), { recursive: true });
renameSync(join(SESS, 'ws1', 'sess-a'), join(HOME, '.archive-trash', 'ws1', 'sess-a'));
const p5 = await svc.heatmap(query);
check('⑤ 移动后数值不变（相对路径记账 → 不是新文件）、newEvents=0', p5.totals.total === before5.total && JSON.stringify([...p5.days].sort((a, b) => (a.day < b.day ? -1 : 1))) === before5.days && p5.stats.newEvents === 0, { before: before5.total, after: p5.totals.total, newEvents: p5.stats.newEvents });

/* ---------- ⑥ 截断/重写不翻倍 ---------- */
console.log('\n— ⑥ 截断已入账文件');
const before6 = { total: p5.totals.total, days: JSON.stringify([...p5.days].sort((a, b) => (a.day < b.day ? -1 : 1))) };
/* 截到「第一帧的结尾」：重读会再看到 C1（已入账）——没有 t>lastTs 就会翻倍 */
truncateSync(FILE_C, cFrame1.length);
const p6 = await svc.heatmap(query);
check('⑥ 截断后数值不翻倍（t > lastTs 生效）、totals 不变', p6.totals.total === before6.total && p6.stats.newEvents === 0 && JSON.stringify([...p6.days].sort((a, b) => (a.day < b.day ? -1 : 1))) === before6.days, { before: before6.total, after: p6.totals.total, newEvents: p6.stats.newEvents });

/* ---------- ⑦ 原子写 ---------- */
console.log('\n— ⑦ 原子写');
const dir = dirname(LEDGER);
const tmpFiles = readdirSync(dir).filter(n => n.endsWith('.tmp'));
const rawLedger = readFileSync(LEDGER, 'utf8');
let parsed = null;
try {
  parsed = JSON.parse(rawLedger);
} catch {
  /* 留空 */
}
check('⑦ 账本目录无 .tmp 残留、JSON 可解析、有 version/createdAt/updatedAt', tmpFiles.length === 0 && parsed && parsed.version === 1 && typeof parsed.createdAt === 'string' && typeof parsed.updatedAt === 'string', { tmp: tmpFiles, ok: !!parsed });
const ledgerSrc = readFileSync(new URL('../src/ledger.js', import.meta.url), 'utf8');
check('⑦b 原子写实现：先写 <ledger>.tmp 再 renameSync 覆盖（源码级，退化会删掉它）', /tmp = path \+ '.tmp'/.test(ledgerSrc) && /renameSync\(tmp, path\)/.test(ledgerSrc), { hasTmp: /tmp = path \+ '.tmp'/.test(ledgerSrc), hasRename: /renameSync\(tmp, path\)/.test(ledgerSrc) });

/* ---------- ⑧ 损坏容错 ---------- */
console.log('\n— ⑧ 账本损坏可重建');
writeFileSync(LEDGER, '{');
let p8 = null;
let threw = null;
try {
  p8 = await svc.heatmap(query);
} catch (e) {
  threw = String(e && e.message);
}
/* 重建的语义 = 按「当前还在盘上的文件」重新全量扫描：④删掉、⑥截断的数据源已不存在，不能要求复原 */
const rescan = createScanner()(roots);
const rescanSum = summaryOf(bucketByDay(rescan.facts, TZ));
const rebuiltOk = (() => {
  try {
    return JSON.parse(readFileSync(LEDGER, 'utf8')).version === 1;
  } catch {
    return false;
  }
})();
check('⑧ 账本被写成非法 JSON → 不抛错、ledgerRebuilt=true、账本恢复可解析、数值 == 当前文件全量重扫', !threw && p8 && p8.stats.ledgerRebuilt === true && rebuiltOk && p8.totals.total === totOf(rescanSum), { threw, rebuilt: p8 && p8.stats.ledgerRebuilt, after: p8 && p8.totals.total, rescan: totOf(rescanSum) });

/* ---------- ⑨ 时区固定 ---------- */
console.log('\n— ⑨ 时区固定');
const p9 = await svc.heatmap({ weeks: 52, mode: 'day', tzOffsetMinutes: 0 });
check('⑨ 以 tz=480 建账后用 tz=0 查询：payload.tzOffsetMinutes 仍 480、数值不变', p9.tzOffsetMinutes === TZ && p9.totals.total === p8.totals.total, { tz: p9.tzOffsetMinutes, total: p9.totals.total });

/* ---------- 收尾 ---------- */
rmSync(ROOT, { recursive: true, force: true });
console.log(`\n断言 ${pass + fails.length} 项，失败 ${fails.length} 项`);
if (fails.length) {
  console.log('失败项：' + fails.join(' / '));
  process.exit(1);
}
