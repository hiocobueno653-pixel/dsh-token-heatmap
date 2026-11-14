/**
 * 宿主半：扫描会话日志，按「本地日」产出六档热力图数据，经 Typert Remote 供浏览器半调用。
 *
 * 形态照搬第三方用量插件（dsh-plugin-usage-stats）已验证的两件套：
 *  ① 实例字段 typertRemote = { service, serviceKey, namespace }（gateway validateBinding 读它）；
 *  ② 原型字符串键 "@deepseek-ai/dsh-typert-protocol/remote-methods"（跨副本可读，version 1 有效）。
 * 零依赖：只用 node: 内置模块 + 本包的 ./scan.js，不 import 任何 @deepseek-ai/* 宿主包
 * （插件被 pnpm 链接在 profile 目录下，import 宿主包会解析出第二副本，Service 原型链跨副本失效）。
 *
 * 统计口径 = **追加式账本**（src/ledger.js）：首次建账把现有全部会话日志（含归档）一次性补进去，
 * 之后每个日志文件只按字节 offset 摄取新增事件，已入账的日/模型数字**只增不改**；日志/归档被删
 * 也不会让历史数字变小（冻结）。tzOffsetMinutes 在建账时固定，之后一律按账本 tz 分桶。
 *
 * 缓存分三层（CONTRACT §1「mode 不得导致重新解压」的落点）：
 *  ① 账本 + 增量摄取：没变化的文件一个字节都不再解压，只跟进新增帧；
 *  ② 账本派生层 this.scanCache：key 含「账本是否变化」（updatedAt|events），变了才重算派生表；
 *  ③ 载荷层 this.payloads：key 同样含账本戳，命中即标 cached: true（newEvents 如实报 0）。
 */
import { join } from 'node:path';
import { homedir } from 'node:os';
import { computeAllTime, hitRate, levelOf, levelThresholds, modeValues } from './scan.js';
import { emptyLedger, ingestNewEvents, ledgerFilePath, loadLedger, saveLedgerAtomic } from './ledger.js';

const REMOTE_METHODS_KEY = '@deepseek-ai/dsh-typert-protocol/remote-methods';
const SERVICE = 'tokenHeatmap';
const DAY_MS = 86400000;
const MODES = ['day', 'week', 'cum'];

export function sessionsRoot(override) {
  const custom = typeof override === 'string' ? override.trim() : '';
  if (custom) return custom;
  const home = process.env.DSH_HOME || join(homedir(), '.dsh');
  return join(home, 'sessions');
}

/**
 * 要扫描的根目录列表：`sessions/` + 归档目录。
 * DSH 归档（删除会话）会把整个会话目录移出 `sessions/` 到 `<DSH_HOME>/.archive-trash/`，
 * 只扫 sessions 会让历史用量凭空消失（实测本机归档里有 16 个会话、3.66 亿 tokens）。
 * 归档是历史事实，用量应当继续计入；`includeArchive: false` 可关掉。
 */
export function sessionsRoots(override, includeArchive) {
  const primary = sessionsRoot(override);
  const roots = [primary];
  if (includeArchive === false) return roots;
  const custom = typeof override === 'string' && override.trim() !== '';
  const parent = primary.replace(/[\\/][^\\/]+$/, '') || primary;
  /* 自定义 sessionsHome（测试快照 / 其它 DSH 实例）只找它旁边的 .archive-trash；
   * 默认根才额外并入 <DSH_HOME>/.archive-trash —— 否则两套数据会混在一起。 */
  const candidates = custom
    ? [join(parent, '.archive-trash')]
    : [join(process.env.DSH_HOME || join(homedir(), '.dsh'), '.archive-trash'), join(parent, '.archive-trash')];
  for (const dir of candidates) {
    if (!roots.includes(dir)) roots.push(dir);
  }
  return roots;
}

/** ms → 本地日历日（用固定偏移换算，避免宿主机时区/DST 影响）。 */
function dayKey(ms, tzOffsetMinutes) {
  return new Date(ms + tzOffsetMinutes * 60000).toISOString().slice(0, 10);
}

function addDays(key, n) {
  const ms = Date.parse(key + 'T00:00:00.000Z') + n * DAY_MS;
  return new Date(ms).toISOString().slice(0, 10);
}

/** 0=周日 … 6=周六。 */
function weekday(key) {
  return new Date(key + 'T00:00:00.000Z').getUTCDay();
}

/** 本地「今天」。 */
function today(tzOffsetMinutes) {
  return dayKey(Date.now(), tzOffsetMinutes);
}

function clampInt(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

/** CONTRACT §1：mode 只认 'day' | 'week' | 'cum'，其它一律回落 'day'。 */
function normalizeMode(value) {
  return MODES.includes(value) ? value : 'day';
}

/** 账本 → 与旧扫描层同形的派生表（只含「有用量」的天；轮次单独一张表，避免零用量天变成格子行）。 */
function layerFromLedger(ledger) {
  const days = new Map();
  const roundsByDay = new Map();
  for (const [day, b] of Object.entries(ledger.days)) {
    if (b.rounds > 0) roundsByDay.set(day, b.rounds);
    if (!(b.requests > 0)) continue;
    const models = new Map();
    for (const [name, m] of Object.entries(b.models || {})) {
      models.set(name, { model: name, total: m.total, input: m.input, output: m.output, cacheRead: m.cacheRead, requests: m.requests });
    }
    days.set(day, {
      total: b.total,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      newTokens: b.newTokens,
      requests: b.requests,
      models,
    });
  }
  const dayTotals = new Map([...days].map(([day, b]) => [day, b.total]));
  return { days, dayTotals, roundsByDay, longestSpanMs: ledger.longestSpanMs };
}

class TokenHeatmapService {
  constructor(ctx, config) {
    this.ctx = ctx;
    this.config = config || {};
    this.typertRemote = Object.freeze({ service: this, serviceKey: SERVICE, namespace: SERVICE });
    this.scanCache = null; // 账本派生层：{ key: `${weeks}|${tz}|${ledgerStamp}`, at, layer }
    this.payloads = new Map(); // 载荷层：`${weeks}|${tz}|${mode}|${ledgerStamp}` → { at, value }，最多 8 条
    this._ledgerPath = null;
  }

  /** 账本文件路径（配置 ledgerPath 优先，否则 <DSH_HOME>/dsh-token-usage/ledger.v1.json）。 */
  ledgerPath() {
    if (!this._ledgerPath) this._ledgerPath = ledgerFilePath(this.config);
    return this._ledgerPath;
  }

  /**
   * 热力图数据。query: { weeks?, mode?, tzOffsetMinutes?, refresh? }
   * 只做加法字段：老的 totals / days / scale / legend / stats / window 名字与语义不变。
   */
  async heatmap(query) {
    const q = query && typeof query === 'object' ? query : {};
    const weeks = clampInt(q.weeks, 4, 104, clampInt(this.config.weeks, 4, 104, 26));
    const mode = normalizeMode(q.mode);
    const requestedTz = Number.isFinite(q.tzOffsetMinutes) ? Math.trunc(q.tzOffsetMinutes) : -new Date().getTimezoneOffset();
    const ttlMs = clampInt(this.config.ttlMs, 0, 600000, 15000);
    const refresh = Boolean(q.refresh);
    const now = Date.now();
    const started = now;

    /* ── 账本：首次建账补历史，之后只摄取新事件（refresh = 强制同步一次新事件）────── */
    const roots = sessionsRoots(this.config.sessionsHome, this.config.includeArchive);
    const root = roots[0];
    const ledgerPath = this.ledgerPath();
    const loaded = loadLedger(ledgerPath);
    const ledger = loaded.ledger || emptyLedger(requestedTz, new Date(now).toISOString());
    const rebuilt = loaded.rebuilt === true;
    const ingest = ingestNewEvents(roots, ledger);
    if (ingest.changed || rebuilt || !loaded.existed) {
      ledger.updatedAt = new Date(now).toISOString();
      saveLedgerAtomic(ledgerPath, ledger);
    }
    const tzOffsetMinutes = ledger.tzOffsetMinutes;
    const ledgerStamp = `${ledger.updatedAt}|${ledger.events}`;

    /* 层③：载荷缓存（key 含账本戳 —— 账本一变就自然落空） */
    const payloadKey = `${weeks}|${tzOffsetMinutes}|${mode}|${ledgerStamp}`;
    const cachedPayload = refresh ? undefined : this.payloads.get(payloadKey);
    if (cachedPayload && now - cachedPayload.at < ttlMs) {
      const value = cachedPayload.value;
      return {
        ...value,
        cached: true,
        stats: {
          ...value.stats,
          reusedFiles: value.stats.files,
          decompressedFiles: 0,
          newEvents: 0,
          ledgerEvents: ledger.events,
        },
      };
    }

    /* 层②：账本 → 派生表（按天桶 / 轮次 / 最长活跃段），key 含账本戳 */
    const scanKey = `${weeks}|${tzOffsetMinutes}|${ledgerStamp}`;
    let layer;
    let fromScanCache = false;
    if (!refresh && this.scanCache && this.scanCache.key === scanKey && now - this.scanCache.at < ttlMs) {
      layer = this.scanCache.layer;
      fromScanCache = true;
    } else {
      layer = layerFromLedger(ledger);
      this.scanCache = { key: scanKey, at: now, layer };
    }

    const to = today(tzOffsetMinutes);
    // 窗口右端 = 今天；左端回退到所在周的周一，保证列是完整周。
    let from = addDays(to, -(weeks * 7 - 1));
    from = addDays(from, -((weekday(from) + 6) % 7));

    const inWindow = [];
    for (const [day, bucket] of layer.days) {
      if (day >= from && day <= to) inWindow.push([day, bucket]);
    }
    inWindow.sort((a, b) => (a[0] < b[0] ? -1 : 1));

    // ── 层③口径：mode 只在这份已分桶结果上做纯计算 ─────────────────────────────
    const windowDays = inWindow.map(([day]) => day);
    const values = modeValues(mode, windowDays, layer.dayTotals);
    const cuts = levelThresholds(values);
    const max = values.reduce((m, v) => (v > m ? v : m), 0);

    const dayRows = inWindow.map(([day, b], i) => ({
      day,
      total: b.total,
      newTokens: b.newTokens,
      input: b.input,
      output: b.output,
      cacheRead: b.cacheRead,
      cacheWrite: b.cacheWrite,
      requests: b.requests,
      rounds: layer.roundsByDay.get(day) ?? 0,
      hitRate: hitRate(b),
      level: levelOf(values[i], cuts),
      value: values[i],
      models: [...b.models.values()].sort((x, y) => y.total - x.total),
    }));

    const totals = dayRows.reduce(
      (acc, d) => {
        acc.total += d.total;
        acc.newTokens += d.newTokens;
        acc.input += d.input;
        acc.output += d.output;
        acc.cacheRead += d.cacheRead;
        acc.cacheWrite += d.cacheWrite;
        acc.requests += d.requests;
        acc.rounds += d.rounds;
        acc.days += 1;
        return acc;
      },
      { total: 0, newTokens: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, requests: 0, rounds: 0, days: 0 },
    );
    totals.hitRate = totals.cacheRead + totals.input === 0 ? null : totals.cacheRead / (totals.cacheRead + totals.input);

    const legend = cuts
      ? [
          { level: 1, min: null, max: cuts[0] },
          { level: 2, min: cuts[0], max: cuts[1] },
          { level: 3, min: cuts[1], max: cuts[2] },
          { level: 4, min: cuts[2], max: cuts[3] },
          { level: 5, min: cuts[3], max: cuts[4] },
          { level: 6, min: cuts[4], max: null },
        ]
      : [1, 2, 3, 4, 5, 6].map(level => ({ level, min: null, max: null }));

    const allTime = computeAllTime({
      days: layer.days,
      roundsByDay: layer.roundsByDay,
      longestSpanMs: layer.longestSpanMs,
      todayKey: to,
    });

    const stats = {
      files: ingest.files,
      reusedFiles: Math.max(0, ingest.files - ingest.decompressedFiles),
      decompressedFiles: ingest.decompressedFiles,
      usageEvents: ledger.events,
      parsedLines: ingest.parsedLines,
      badLines: ingest.badLines,
      scanMs: Date.now() - started,
      /* 账本状态（只加不删）：路径 / 建账与更新时间 / 累计事件数 / 本次新增 / 是否重建 */
      ledgerPath,
      ledgerCreatedAt: ledger.createdAt,
      ledgerUpdatedAt: ledger.updatedAt,
      ledgerEvents: ledger.events,
      newEvents: ingest.newEvents,
      ledgerRebuilt: rebuilt,
    };
    if (fromScanCache) {
      // 层②命中：本次调用没有解压任何日志文件，数据来自账本派生结果。
      stats.reusedFiles = stats.files;
      stats.decompressedFiles = 0;
    }

    const value = {
      generatedAt: new Date(now).toISOString(),
      tzOffsetMinutes,
      sessionsRoot: root,
      sessionsRoots: roots,
      weeks,
      mode,
      window: { from, to },
      stats,
      scale: { metric: 'total', mode, cuts, legend, max },
      totals,
      days: dayRows,
      allTime,
      cached: false,
    };
    this.payloads.set(payloadKey, { at: now, value });
    if (this.payloads.size > 8) {
      for (const k of this.payloads.keys()) {
        if (k !== payloadKey) {
          this.payloads.delete(k);
          break;
        }
      }
    }
    return value;
  }
}

/** 手写 SRC Remote 标记（形态 = typert-protocol mark() 产物）。 */
Object.defineProperty(TokenHeatmapService.prototype, REMOTE_METHODS_KEY, {
  configurable: true,
  value: Object.freeze({
    version: 1,
    methods: Object.freeze([Object.freeze({ method: 'heatmap', invocation: Object.freeze({ kind: 'direct' }) })]),
  }),
});

export const name = 'token-heatmap';
export const inject = [];

export function applyCordis(ctx, config) {
  const service = new TokenHeatmapService(ctx, config || {});
  ctx.reflect.provide(SERVICE, service);
  ctx.logger?.info?.('[token-heatmap] tokenHeatmap remote online');
  return service;
}

export default { name, inject, apply: applyCordis };
export { TokenHeatmapService, dayKey, addDays, weekday, today, normalizeMode };
