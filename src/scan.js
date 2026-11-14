/**
 * 会话日志 → 每日用量事实（纯数据层，无 DSH 依赖，可单独 node 运行）。
 *
 * 数据来源：<sessionsRoot>/<workspace>/<session-id>/session.v4.jsonl.zstd
 * 日志是「多帧拼接的 zstd」：一个文件里几十上百个独立帧，必须逐帧解压——一次性
 * zstdDecompressSync 整个文件只会得到第一帧（会话头），后面的用量全部丢失。
 *
 * 每条用量事实 = { t: 事件时间戳(ms), total, input, output, cacheRead, cacheWrite, model }
 * 口径：total = input(未缓存) + output + cacheRead + cacheWrite（与日志里的 totalTokens 一致）。
 *
 * CONTRACT v2 追加的口径（全部是加法，老函数语义不变）：
 * - `isUserRound` / `bucketRoundsByDay`：轮消息只数 `type === 'user/message'` 且
 *   `data.source.kind === 'user'` 的事件，注入消息（time-context / team-message /
 *   subagent-settled / runtime-context / skill-catalog / goal …）一律不算。
 * - `longestSegmentMs`：30 分钟断点的最长「连续活跃段」，不是首末相减
 *   （实测有会话首末跨 427 小时）。
 * - `modeValues` / `computeAllTime`：week / cum 两种呈现口径的取值，以及全历史汇总。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** 逐帧解压一个多帧 zstd 日志，返回拼接后的 JSONL 文本。 */
export function readZstdJsonl(file) {
  const buf = readFileSync(file);
  const offsets = [0];
  let idx = 4;
  while ((idx = buf.indexOf(MAGIC, idx)) !== -1) {
    offsets.push(idx);
    idx += 4;
  }
  offsets.push(buf.length);
  const parts = [];
  let i = 0;
  while (i < offsets.length - 1) {
    let text = null;
    // 帧内出现 0x28B52FFD 纯属巧合时，切片会解压失败：向后合并下一段再试。
    for (let j = i + 1; j < offsets.length; j++) {
      try {
        text = zstdDecompressSync(buf.subarray(offsets[i], offsets[j])).toString('utf8');
        i = j;
        break;
      } catch {
        /* 假帧边界，继续合并 */
      }
    }
    if (text === null) {
      i++;
      continue;
    }
    parts.push(text);
  }
  return parts.join('');
}

/**
 * 只解压**与 [fromByte, size) 重叠**的帧（追加式账本的增量摄取用）。
 * 多帧 zstd：跳过整帧都在 offset 之前的帧，从第一帧「跨过 offset」的开始解压。
 * @returns {{text: string, startByte: number}} startByte 可能 < fromByte（首帧从更早处开始），
 *   调用方据此对该帧内的事件做 `t > lastTs` 过滤，避免已入账事件被重复计数。
 */
export function readZstdJsonlFrom(file, fromByte) {
  const buf = readFileSync(file);
  const from = Math.max(0, Math.min(buf.length, Math.floor(Number(fromByte) || 0)));
  if (from <= 0) return { text: readZstdJsonl(file), startByte: 0 };
  const offsets = [0];
  let idx = 4;
  while ((idx = buf.indexOf(MAGIC, idx)) !== -1) {
    offsets.push(idx);
    idx += 4;
  }
  offsets.push(buf.length);
  let i0 = offsets.length - 2;
  for (let i = 0; i < offsets.length - 1; i++) {
    if (offsets[i + 1] > from) {
      i0 = i;
      break;
    }
  }
  const parts = [];
  let i = i0;
  while (i < offsets.length - 1) {
    let text = null;
    // 帧内出现 0x28B52FFD 纯属巧合时，切片会解压失败：向后合并下一段再试。
    for (let j = i + 1; j < offsets.length; j++) {
      try {
        text = zstdDecompressSync(buf.subarray(offsets[i], offsets[j])).toString('utf8');
        i = j;
        break;
      } catch {
        /* 假帧边界，继续合并 */
      }
    }
    if (text === null) {
      i++;
      continue;
    }
    parts.push(text);
  }
  return { text: parts.join(''), startByte: offsets[i0] };
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

/** 兼容 v3/v4（data.usage）与旧代（data.chunk.usage）；无用量返回 undefined。 */
export function usageOf(ev) {
  const u = ev?.data?.usage ?? ev?.data?.chunk?.usage ?? ev?.usage;
  if (!u || typeof u !== 'object') return undefined;
  const input = num(u.inputTokens ?? u.promptTokens ?? u.prompt_tokens);
  const output = num(u.outputTokens ?? u.completionTokens ?? u.completion_tokens);
  const cacheRead = num(u.cacheReadTokens ?? u.promptCacheHitTokens ?? u.cache_read_input_tokens);
  const cacheWrite = num(u.cacheWriteTokens ?? u.cacheCreationInputTokens ?? u.cache_write_input_tokens);
  const total = num(u.totalTokens) || input + output + cacheRead + cacheWrite;
  if (input + output + cacheRead + cacheWrite + total === 0) return undefined;
  return { input, output, cacheRead, cacheWrite, total };
}

export function timeOf(ev) {
  const t = ev?.time ?? ev?.data?.chunk?.time ?? ev?.data?.message?.time ?? ev?.ts ?? ev?.data?.time;
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined;
}

export function modelOf(ev) {
  return (
    ev?.data?.message?.source?.model ??
    ev?.data?.chunk?.source?.model ??
    ev?.data?.model ??
    ev?.model ??
    '(unknown)'
  );
}

function listLogs(dir) {
  const out = [];
  const walk = d => {
    let entries;
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.isFile() && /\.jsonl(\.zstd)?$/.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

/** 会话日志文件清单（只 readdir，不解压），供缓存层核对文件数。 */
export function listSessionLogs(dir) {
  return listLogs(dir);
}

/**
 * 多个根目录的日志清单（DSH 归档会把整个会话目录**移出** `sessions/` 到
 * `<DSH_HOME>/.archive-trash/`，只扫 sessions 会丢历史）。同一条物理文件只算一次。
 * @param {string|string[]} roots
 */
export function listLogsFrom(roots) {
  const list = Array.isArray(roots) ? roots : [roots];
  const out = [];
  const seen = new Set();
  for (const root of list) {
    if (!root) continue;
    for (const file of listLogs(root)) {
      const key = file.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

/** 事件是否「真实用户发言」：注入消息（time-context / team-message / …）不算，拿不到 source.kind 也不算。 */
export function isUserRound(ev) {
  return ev?.type === 'user/message' && ev?.data?.source?.kind === 'user';
}

/** 连续活跃段的断点：相邻事件间隔超过它就断开。 */
export const SPAN_GAP_MS = 30 * 60 * 1000;

/**
 * 最长「连续活跃段」：时间戳排序后，相邻间隔 > gapMs 即断开，取单段（末 - 首）的最大值。
 * 不能用首末相减——实测有会话首末跨 427 小时（隔了很多天的复用会话）。
 */
export function longestSegmentMs(stamps, gapMs = SPAN_GAP_MS) {
  if (!stamps || stamps.length === 0) return 0;
  const ts = [...stamps].sort((a, b) => a - b);
  let best = 0;
  let segStart = ts[0];
  for (let i = 1; i < ts.length; i++) {
    if (ts[i] - ts[i - 1] > gapMs) {
      const span = ts[i - 1] - segStart;
      if (span > best) best = span;
      segStart = ts[i];
    }
  }
  const tail = ts[ts.length - 1] - segStart;
  return tail > best ? tail : best;
}

/**
 * 逐条抽用量事实 + 每会话事件时间戳 + 用户轮时间戳。
 * 文件按 (mtimeMs, size) 记忆，未变则三份结果一起复用（mode 切换不可能触发重新解压）。
 */
export function createScanner() {
  const memo = new Map(); // file -> { key, facts, stamps, rounds, mtimeMs }

  return function scan(roots) {
    const files = listLogsFrom(roots);
    const facts = [];
    const roundTimes = [];
    const stampsBySession = new Map(); // 会话 → 该会话全部事件时间戳（同会话多文件会合并）
    let reused = 0;
    let decompressed = 0;
    let parsed = 0;
    let badLines = 0;

    // 同一份会话文件若同时出现在 sessions/ 与归档里（移动失败留下的副本），只算一次。
    const seenSessionFile = new Set();

    const collect = (sessionId, entry) => {
      for (const f of entry.facts) facts.push(f);
      for (const t of entry.rounds) roundTimes.push(t);
      const existing = stampsBySession.get(sessionId);
      if (existing) for (const t of entry.stamps) existing.push(t);
      else stampsBySession.set(sessionId, [...entry.stamps]);
    };

    for (const file of files) {
      let st;
      try {
        st = statSync(file);
      } catch {
        continue;
      }
      const key = `${st.mtimeMs}:${st.size}`;
      const sessionId = file.split(/[\\/]/).slice(-2, -1)[0] ?? file;
      const sessionFileKey = sessionId + '|' + (file.split(/[\\/]/).pop() ?? file).toLowerCase();
      if (seenSessionFile.has(sessionFileKey)) continue;
      seenSessionFile.add(sessionFileKey);
      const hit = memo.get(file);
      if (hit && hit.key === key) {
        collect(sessionId, hit);
        reused++;
        continue;
      }
      let text;
      try {
        text = file.endsWith('.zstd') ? readZstdJsonl(file) : readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      decompressed++;
      const local = { facts: [], stamps: [], rounds: [] };
      for (const line of text.split('\n')) {
        if (!line.trim()) continue;
        parsed++;
        let ev;
        try {
          ev = JSON.parse(line);
        } catch {
          badLines++;
          continue;
        }
        const t = timeOf(ev) ?? st.mtimeMs;
        local.stamps.push(t);
        if (isUserRound(ev)) local.rounds.push(t);
        const u = usageOf(ev);
        if (!u) continue;
        local.facts.push({
          t,
          sessionId,
          model: modelOf(ev),
          ...u,
        });
      }
      memo.set(file, { key, ...local, mtimeMs: st.mtimeMs });
      collect(sessionId, local);
    }

    // 清掉已消失的会话文件，避免记忆无限增长
    if (memo.size > files.length * 2 + 64) {
      const alive = new Set(files);
      for (const k of [...memo.keys()]) if (!alive.has(k)) memo.delete(k);
    }

    let longestSpanMs = 0;
    for (const stamps of stampsBySession.values()) {
      const span = longestSegmentMs(stamps);
      if (span > longestSpanMs) longestSpanMs = span;
    }

    return {
      facts,
      roundTimes,
      stampsBySession,
      longestSpanMs,
      fileCount: files.length,
      reusedFiles: reused,
      decompressedFiles: decompressed,
      parsedLines: parsed,
      badLines,
    };
  };
}

const emptyBucket = () => ({
  total: 0,
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  newTokens: 0,
  requests: 0,
  models: new Map(),
});

/** 把用量事实按本地日期分桶（含按模型明细）。 */
export function bucketByDay(facts, tzOffsetMinutes) {
  const tzMs = (Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0) * 60 * 1000;
  const days = new Map();
  const dayKey = ms => new Date(ms + tzMs).toISOString().slice(0, 10);

  for (const f of facts) {
    const day = dayKey(f.t);
    let b = days.get(day);
    if (!b) {
      b = emptyBucket();
      days.set(day, b);
    }
    b.total += f.total;
    b.input += f.input;
    b.output += f.output;
    b.cacheRead += f.cacheRead;
    b.cacheWrite += f.cacheWrite;
    b.newTokens += f.input + f.output;
    b.requests += 1;
    const m = b.models.get(f.model) ?? { model: f.model, total: 0, input: 0, output: 0, cacheRead: 0, requests: 0 };
    m.total += f.total;
    m.input += f.input;
    m.output += f.output;
    m.cacheRead += f.cacheRead;
    m.requests += 1;
    b.models.set(f.model, m);
  }
  return days;
}

/**
 * 用户轮消息按本地日期计数（CONTRACT §2：只数 `user/message` 且 `source.kind === 'user'`）。
 * 与 bucketByDay 分开：轮消息**不会**凭空造出「有轮消息但零 token」的日期行，
 * 老的 days 口径（当天有用量事件才算一天）保持不变。
 */
export function bucketRoundsByDay(roundTimes, tzOffsetMinutes) {
  const tzMs = (Number.isFinite(tzOffsetMinutes) ? tzOffsetMinutes : 0) * 60 * 1000;
  const out = new Map();
  for (const t of roundTimes) {
    const day = new Date(t + tzMs).toISOString().slice(0, 10);
    out.set(day, (out.get(day) ?? 0) + 1);
  }
  return out;
}

const DAY_MS = 86400000;

/** ISO 日键加减天数（固定 86400000 ms，避开宿主机 DST）。 */
export function addDayKeys(key, n) {
  return new Date(Date.parse(`${key}T00:00:00.000Z`) + n * DAY_MS).toISOString().slice(0, 10);
}

/** 0 = 周日 … 6 = 周六。 */
export function weekdayOf(key) {
  return new Date(`${key}T00:00:00.000Z`).getUTCDay();
}

/** 该日所在周的周一（ISO 周，周一起）。 */
export function weekStartOf(key) {
  return addDayKeys(key, -((weekdayOf(key) + 6) % 7));
}

/**
 * CONTRACT §3：按 mode 口径算出窗口内每天参与分档的 value。
 * @param {'day'|'week'|'cum'} mode
 * @param {string[]} windowDays 升序的「窗口内且有量的日期」
 * @param {Map<string, number>} dayTotals 全历史 日期 → 当日 total
 * @returns {number[]} 与 windowDays 一一对应
 */
export function modeValues(mode, windowDays, dayTotals) {
  const out = new Array(windowDays.length);
  if (mode === 'week') {
    const perWeek = new Map();
    for (let i = 0; i < windowDays.length; i++) {
      const monday = weekStartOf(windowDays[i]);
      let sum = perWeek.get(monday);
      if (sum === undefined) {
        sum = 0;
        for (let k = 0; k < 7; k++) sum += dayTotals.get(addDayKeys(monday, k)) ?? 0;
        perWeek.set(monday, sum);
      }
      out[i] = sum;
    }
  } else if (mode === 'cum') {
    let acc = 0;
    for (let i = 0; i < windowDays.length; i++) {
      acc += dayTotals.get(windowDays[i]) ?? 0;
      out[i] = acc;
    }
  } else {
    for (let i = 0; i < windowDays.length; i++) out[i] = dayTotals.get(windowDays[i]) ?? 0;
  }
  return out;
}

/**
 * CONTRACT §2 全历史汇总（不随窗口与 mode 变化）：
 * total / activeDays / rounds / peak / currentStreak / longestStreak / longestSpanMs。
 * @param {{ days: Map, roundsByDay?: Map, longestSpanMs?: number, todayKey: string }} args
 */
export function computeAllTime({ days, roundsByDay = new Map(), longestSpanMs = 0, todayKey }) {
  const active = [];
  let total = 0;
  let peak = { day: null, total: 0 };
  // 按日期升序扫，保证并列时 peak 稳定取最早的那天。
  for (const day of [...days.keys()].sort()) {
    const bucket = days.get(day);
    total += bucket.total;
    if (bucket.total > 0) active.push(day);
    if (bucket.total > peak.total) peak = { day, total: bucket.total };
  }

  let rounds = 0;
  for (const n of roundsByDay.values()) rounds += n;

  let longestStreak = 0;
  let run = 0;
  let prev = null;
  for (const day of active) {
    run = prev !== null && addDayKeys(prev, 1) === day ? run + 1 : 1;
    if (run > longestStreak) longestStreak = run;
    prev = day;
  }

  // 从今天往前数；今天还没用量就从昨天起算，昨天也没有则 0。
  const set = new Set(active);
  let currentStreak = 0;
  let cursor = set.has(todayKey) ? todayKey : addDayKeys(todayKey, -1);
  while (set.has(cursor)) {
    currentStreak++;
    cursor = addDayKeys(cursor, -1);
  }

  return { total, activeDays: active.length, rounds, peak, currentStreak, longestStreak, longestSpanMs };
}

/** 六档分位阈值（只统计有量的天）。返回 [t1..t5]；样本不足时返回 null（调用方回落单一档）。 */
export function levelThresholds(values) {
  const vals = values.filter(v => v > 0).sort((a, b) => a - b);
  if (vals.length < 2) return null;
  const distinct = new Set(vals).size;
  if (distinct < 2) return null;
  const at = q => {
    const pos = Math.min(vals.length - 1, Math.max(0, Math.ceil(q * vals.length) - 1));
    return vals[pos];
  };
  const cuts = [];
  for (let i = 1; i <= 5; i++) cuts.push(at(i / 6));
  // 去重后可能不足 5 个阈值（大量并列），仍可分出更少的档
  return cuts;
}

/** 0 = 无用量；1..6 = 由浅到深。 */
export function levelOf(value, cuts) {
  if (!(value > 0)) return 0;
  if (!cuts || cuts.length === 0) return 3;
  let level = 1;
  for (const c of cuts) if (value >= c) level++;
  return Math.min(6, level);
}

export function hitRate(bucket) {
  const denom = bucket.cacheRead + bucket.input;
  return denom === 0 ? null : bucket.cacheRead / denom;
}
