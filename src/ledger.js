/**
 * 追加式账本（append-only ledger）：用量统计只增不减。
 *
 * 用户要求：「每次只统计新加的 token 用量，统计过后的就不变了」。首次建账把现有一切
 * 会话日志（`sessions/` + `.archive-trash/`）一次性补进去，之后每个日志文件只摄取
 * **新增**的部分（按字节 offset 增量读、只解压尾部帧；文件被截断/重写时只收
 * `t > lastTs` 的事件），已入账的日/模型数字**只做 `+=`，绝不重算覆盖**。
 *
 * 文件消失（删日志、清理归档）**不影响已入账数字** —— 这就是「冻结」语义；
 * 只是该文件从 `files` 索引里移除（不再跟进）。
 *
 * 文件按「相对扫描根目录的路径」记账（根目录见 cordis.js 的 sessionsRoots）：
 * 会话从 `sessions/` 移到 `.archive-trash/` 时 key 不变，不会被当成新文件重复计数。
 *
 * 账本文件：`<DSH_HOME>/dsh-token-usage/ledger.v1.json`（可用配置 ledgerPath 覆盖）。
 * - **原子写**：先写 `.tmp` 再 renameSync 覆盖；
 * - **损坏容错**：解析失败视为不存在（重建，stats 里 ledgerRebuilt = true）；
 * - **时区固定**：建账时写入 tzOffsetMinutes，之后一律按它分桶。
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import {
  SPAN_GAP_MS,
  isUserRound,
  listLogsFrom,
  modelOf,
  readZstdJsonlFrom,
  timeOf,
  usageOf,
} from './scan.js';

export const LEDGER_VERSION = 1;
const DAY_MS = 86400000;

/** 账本默认路径：`<DSH_HOME>/dsh-token-usage/ledger.v1.json`（配置 ledgerPath 优先）。 */
export function ledgerFilePath(config, env) {
  const custom = config && typeof config.ledgerPath === 'string' ? config.ledgerPath.trim() : '';
  if (custom) return custom;
  const e = env || process.env;
  const home = e.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'dsh-token-usage', 'ledger.v1.json');
}

/** 新的一天桶（字段与 scan.js 的 emptyBucket 对齐，模型明细用普通对象以便 JSON 序列化）。 */
export function newDayBucket() {
  return { total: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, newTokens: 0, requests: 0, rounds: 0, models: {} };
}

/** 空账本（建账时用固定 tz）。 */
export function emptyLedger(tzOffsetMinutes, iso) {
  return {
    version: LEDGER_VERSION,
    createdAt: iso,
    updatedAt: iso,
    tzOffsetMinutes: Number.isFinite(tzOffsetMinutes) ? Math.trunc(tzOffsetMinutes) : 0,
    days: {},
    files: {},
    longestSpanMs: 0,
    events: 0,
  };
}

/** 结构校验/补全：只接受本版本，字段缺失时补默认值（绝不因个别字段缺就丢账）。 */
function normalizeLedger(j) {
  if (!j || typeof j !== 'object' || j.version !== LEDGER_VERSION) return null;
  if (!j.days || typeof j.days !== 'object' || !j.files || typeof j.files !== 'object') return null;
  const out = emptyLedger(j.tzOffsetMinutes, typeof j.createdAt === 'string' && j.createdAt ? j.createdAt : new Date(0).toISOString());
  out.updatedAt = typeof j.updatedAt === 'string' && j.updatedAt ? j.updatedAt : out.createdAt;
  out.longestSpanMs = Number.isFinite(j.longestSpanMs) ? j.longestSpanMs : 0;
  out.events = Number.isFinite(j.events) ? j.events : 0;
  for (const [day, b] of Object.entries(j.days)) {
    if (!b || typeof b !== 'object') continue;
    const bucket = newDayBucket();
    for (const k of ['total', 'input', 'output', 'cacheRead', 'cacheWrite', 'newTokens', 'requests', 'rounds']) {
      if (Number.isFinite(b[k])) bucket[k] = b[k];
    }
    if (b.models && typeof b.models === 'object') {
      for (const [name, m] of Object.entries(b.models)) {
        if (!m || typeof m !== 'object') continue;
        bucket.models[name] = {
          total: Number.isFinite(m.total) ? m.total : 0,
          input: Number.isFinite(m.input) ? m.input : 0,
          output: Number.isFinite(m.output) ? m.output : 0,
          cacheRead: Number.isFinite(m.cacheRead) ? m.cacheRead : 0,
          requests: Number.isFinite(m.requests) ? m.requests : 0,
        };
      }
    }
    out.days[day] = bucket;
  }
  for (const [key, rec] of Object.entries(j.files)) {
    if (!rec || typeof rec !== 'object') continue;
    const segs = Array.isArray(rec.segs)
      ? rec.segs
          .filter(pair => Array.isArray(pair) && pair.length === 2 && Number.isFinite(pair[0]) && Number.isFinite(pair[1]))
          .map(pair => [pair[0], pair[1]])
      : [];
    out.files[key] = {
      size: Number.isFinite(rec.size) ? rec.size : 0,
      offset: Number.isFinite(rec.offset) ? rec.offset : 0,
      lastTs: Number.isFinite(rec.lastTs) ? rec.lastTs : 0,
      segStart: Number.isFinite(rec.segStart) ? rec.segStart : 0,
      segEnd: Number.isFinite(rec.segEnd) ? rec.segEnd : 0,
      best: Number.isFinite(rec.best) ? rec.best : 0,
      segs,
    };
  }
  return out;
}

/**
 * 读账本。
 * @returns {{ledger: object|null, existed: boolean, rebuilt: boolean}}
 *   existed=false → 首次建账；rebuilt=true → 文件存在但损坏（调用方重建并打标）。
 */
export function loadLedger(path) {
  let raw;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { ledger: null, existed: false, rebuilt: false };
  }
  try {
    const ledger = normalizeLedger(JSON.parse(raw));
    if (!ledger) return { ledger: null, existed: true, rebuilt: true };
    return { ledger, existed: true, rebuilt: false };
  } catch {
    return { ledger: null, existed: true, rebuilt: true };
  }
}

/** 原子写：tmp + rename（进程中断不会留下半个 JSON）。 */
export function saveLedgerAtomic(path, ledger) {
  const tmp = path + '.tmp';
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(tmp, JSON.stringify(ledger));
  try {
    renameSync(tmp, path);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      /* ignore */
    }
    throw err;
  }
}

/** 文件 → 账本 key：相对扫描根的路径（小写、正斜杠）；跨根移动因此不会变成新文件。 */
export function ledgerKeyOf(file, roots) {
  const f = String(file).replace(/\\/g, '/');
  const list = Array.isArray(roots) ? roots : [roots];
  let best = null;
  for (const root of list) {
    if (!root) continue;
    const rr = String(root).replace(/\\/g, '/').replace(/\/+$/, '');
    if (!rr) continue;
    if (f.toLowerCase().startsWith(rr.toLowerCase() + '/')) {
      if (!best || rr.length > best.length) best = rr;
    }
  }
  const rel = best ? f.slice(best.length + 1) : f;
  return rel.toLowerCase();
}

function dayKeyOf(ms, tzOffsetMinutes) {
  const tz = Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0;
  return new Date(ms + tz * 60000).toISOString().slice(0, 10);
}

function dayBucketOf(ledger, day) {
  let b = ledger.days[day];
  if (!b) {
    b = newDayBucket();
    ledger.days[day] = b;
  }
  return b;
}

/** 入账一条用量事实：**只做加法**。 */
function addUsage(ledger, t, model, u) {
  const b = dayBucketOf(ledger, dayKeyOf(t, ledger.tzOffsetMinutes));
  b.total += u.total;
  b.input += u.input;
  b.output += u.output;
  b.cacheRead += u.cacheRead;
  b.cacheWrite += u.cacheWrite;
  b.newTokens += u.input + u.output;
  b.requests += 1;
  const m = b.models[model] || (b.models[model] = { total: 0, input: 0, output: 0, cacheRead: 0, requests: 0 });
  m.total += u.total;
  m.input += u.input;
  m.output += u.output;
  m.cacheRead += u.cacheRead;
  m.requests += 1;
}

function addRound(ledger, t) {
  const b = dayBucketOf(ledger, dayKeyOf(t, ledger.tzOffsetMinutes));
  b.rounds += 1;
}

/** 把事件时间戳并入该文件的「连续活跃段」列表（30 分钟断点，与 scan.longestSegmentMs 同口径）。 */
function addStamp(rec, t) {
  const segs = rec.segs || (rec.segs = []);
  let lo = 0;
  let hi = segs.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (segs[mid][0] < t) lo = mid + 1;
    else hi = mid;
  }
  let idx = lo;
  let start = t;
  let end = t;
  if (idx > 0 && t <= segs[idx - 1][1] + SPAN_GAP_MS) {
    idx--;
    start = segs[idx][0];
    end = Math.max(segs[idx][1], t);
    segs.splice(idx, 1);
  }
  while (idx < segs.length && segs[idx][0] <= end + SPAN_GAP_MS) {
    end = Math.max(end, segs[idx][1]);
    segs.splice(idx, 1);
  }
  segs.splice(idx, 0, [start, end]);
  let best = 0;
  for (const seg of segs) if (seg[1] - seg[0] > best) best = seg[1] - seg[0];
  rec.best = best;
  rec.segStart = segs[segs.length - 1][0];
  rec.segEnd = segs[segs.length - 1][1];
  if (best > rec.maxBest) rec.maxBest = best;
}

/**
 * 增量摄取：遍历扫描根下的日志，只把**新出现**的事件记进账本。
 *
 * 每文件规则（见任务卡）：
 *  - 无记录 → 全量读；`size > offset` → 只解压与 `[offset, size)` 重叠的尾部帧；
 *  - `size < offset`（截断/重写）→ 重读全文件，但只收 `t > lastTs`；
 *  - `size == offset` → 跳过；文件消失 → 已入账数字保留，只从 files 索引移除。
 *
 * @returns {{newEvents:number, changed:boolean, files:number, decompressedFiles:number,
 *            parsedLines:number, badLines:number, removedFiles:number}}
 */
export function ingestNewEvents(roots, ledger) {
  const files = listLogsFrom(roots);
  const seen = new Set();
  let newEvents = 0;
  let decompressedFiles = 0;
  let parsedLines = 0;
  let badLines = 0;

  for (const file of files) {
    const key = ledgerKeyOf(file, roots);
    if (seen.has(key)) continue;
    seen.add(key);
    let st;
    try {
      st = statSync(file);
    } catch {
      continue;
    }
    const rec = ledger.files[key];
    if (rec && st.size === rec.offset) continue; // 没长、没重写 → 什么都不做

    const full = !rec || st.size < rec.offset;
    const fromByte = full ? 0 : rec.offset;
    let text;
    let startByte;
    try {
      if (/\.zstd$/.test(file)) {
        const r = readZstdJsonlFrom(file, fromByte);
        text = r.text;
        startByte = r.startByte;
      } else {
        const buf = readFileSync(file);
        text = buf.subarray(fromByte).toString('utf8');
        startByte = fromByte;
      }
    } catch {
      continue; // 读不动（被锁/半截帧）→ 下轮再来
    }
    decompressedFiles++;

    const next = rec
      ? { ...rec, maxBest: rec.maxBest || rec.best || 0 }
      : { size: 0, offset: 0, lastTs: 0, segStart: 0, segEnd: 0, best: 0, segs: [], maxBest: 0 };
    /* 只在「重新读了已入账区间」时按 lastTs 过滤（截断重写 / 首帧跨界），防重复计数 */
    const filterAfter = rec && startByte <= (rec.offset || 0) ? rec.lastTs : 0;

    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      parsedLines++;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        badLines++;
        continue;
      }
      const t = timeOf(ev) ?? st.mtimeMs;
      if (filterAfter && !(t > filterAfter)) continue;
      /* 文件级「连续活跃段」（30 分钟断点）：同一个文件的全部事件时间戳并进 segs 列表 */
      addStamp(next, t);
      if (t > next.lastTs) next.lastTs = t;
      const u = usageOf(ev);
      if (u) {
        addUsage(ledger, t, modelOf(ev), u);
        ledger.events += 1;
        newEvents++;
      } else if (isUserRound(ev)) {
        addRound(ledger, t);
      }
    }

    next.size = st.size;
    next.offset = st.size;
    if (next.maxBest > next.best) next.best = next.maxBest;
    ledger.files[key] = next;
    if (next.best > ledger.longestSpanMs) ledger.longestSpanMs = next.best;
  }

  /* 文件消失：已入账数字原样保留（冻结），只把该文件从索引里移除 */
  let removedFiles = 0;
  for (const key of Object.keys(ledger.files)) {
    if (!seen.has(key)) {
      delete ledger.files[key];
      removedFiles++;
    }
  }

  return {
    newEvents,
    changed: newEvents > 0 || removedFiles > 0,
    files: seen.size,
    decompressedFiles,
    parsedLines,
    badLines,
    removedFiles,
  };
}

export { DAY_MS };
