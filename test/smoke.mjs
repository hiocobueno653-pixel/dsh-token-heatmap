/** 宿主半冒烟：直接跑数据层 + 服务，不依赖 DSH。 */
import { TokenHeatmapService } from '../src/cordis.js';
import { bucketByDay, createScanner, levelOf, levelThresholds } from '../src/scan.js';

const tzOffsetMinutes = -new Date().getTimezoneOffset();
const scanner = createScanner();
const t0 = Date.now();
const scan = scanner(process.env.DSH_HOME ? process.env.DSH_HOME + '\\sessions' : (process.env.USERPROFILE || '') + '\\.dsh\\sessions');
const days = bucketByDay(scan.facts, tzOffsetMinutes);
const cuts = levelThresholds([...days.values()].map(b => b.total));
console.log('扫描:', scan.fileCount, '个日志,', scan.facts.length, '次模型调用,', Date.now() - t0, 'ms, 坏行', scan.badLines);
console.log('阈值:', cuts ? cuts.map(n => n.toLocaleString()).join(' | ') : '(样本不足)');

const svc = new TokenHeatmapService({ logger: console }, { weeks: 26 });
const t1 = Date.now();
const res = await svc.heatmap({ weeks: 26, tzOffsetMinutes });
console.log('窗口:', res.window.from, '→', res.window.to, '| 扫描耗时', res.stats.scanMs, 'ms | 服务耗时', Date.now() - t1, 'ms');
console.log('窗口合计: total=%s new=%s requests=%s hit=%s', res.totals.total.toLocaleString(), res.totals.newTokens.toLocaleString(), res.totals.requests, res.totals.hitRate?.toFixed(4));
for (const d of res.days) {
  console.log(`  ${d.day} L${d.level}  total=${d.total.toLocaleString().padStart(13)}  new=${d.newTokens.toLocaleString().padStart(9)}  req=${String(d.requests).padStart(4)}  hit=${d.hitRate === null ? '—' : (d.hitRate * 100).toFixed(1) + '%'}  models=${d.models.length}`);
}
console.log('图例:', JSON.stringify(res.scale.legend.map(b => [b.level, b.min, b.max])));
const again = await svc.heatmap({ weeks: 26, tzOffsetMinutes });
console.log('二次调用走缓存:', again.cached === true);
console.log('levelOf 边界:', [0, 1, cuts ? cuts[0] : 0, cuts ? cuts[4] : 0, Number.MAX_SAFE_INTEGER].map(v => levelOf(v, cuts)).join(','));
