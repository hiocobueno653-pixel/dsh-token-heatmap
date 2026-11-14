/**
 * 归档目录纳入扫描的回归：DSH 归档会把会话目录移出 sessions/ 到 <DSH_HOME>/.archive-trash/，
 * 只扫 sessions 会让历史用量消失。这里用临时目录造两种布局验证。
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createScanner, listLogsFrom } from '../src/scan.js';

let total = 0;
let failed = 0;
const check = (name, cond, detail) => {
  total++;
  if (!cond) failed++;
  console.log(`${cond ? '  ok  ' : '  FAIL'} ${name}${cond || detail === undefined ? '' : ' - ' + JSON.stringify(detail)}`);
};

const line = (t, input, output) =>
  JSON.stringify({ type: 'assistant/message', time: t, data: { usage: { inputTokens: input, outputTokens: output } } });
const round = (t) => JSON.stringify({ type: 'user/message', time: t, data: { source: { kind: 'user' } } });

const root = mkdtempSync(join(tmpdir(), 'heatmap-archive-'));
const sessions = join(root, 'sessions');
const archive = join(root, '.archive-trash');

// 活跃会话：1 次调用 100 tokens
mkdirSync(join(sessions, 'ws-a', 's1'), { recursive: true });
writeFileSync(join(sessions, 'ws-a', 's1', 'session.v4.jsonl'), [round(1), line(2, 60, 40)].join('\n'));

// 归档会话（两个不同的归档目录，各 1 次调用）
mkdirSync(join(archive, '2026-10-01T00-00-00Z-session-s2'), { recursive: true });
writeFileSync(join(archive, '2026-10-01T00-00-00Z-session-s2', 'session.v4.jsonl'), [round(3), line(4, 300, 200)].join('\n'));
mkdirSync(join(archive, '2026-10-02T00-00-00Z-session-s3'), { recursive: true });
writeFileSync(join(archive, '2026-10-02T00-00-00Z-session-s3', 'session.v4.jsonl'), [line(5, 1000, 0)].join('\n'));

const tokensOf = (scan) => scan.facts.reduce((n, f) => n + f.total, 0);

// ① 只扫 sessions
const only = createScanner()(sessions);
check('只扫 sessions：1 个文件 / 100 tokens / 2 轮消息', only.fileCount === 1 && tokensOf(only) === 100 && only.roundTimes.length === 1, {
  files: only.fileCount,
  tokens: tokensOf(only),
  rounds: only.roundTimes.length,
});

// ② sessions + 归档
const both = createScanner()([sessions, archive]);
check('sessions + 归档：3 个文件 / 1600 tokens / 3 轮消息', both.fileCount === 3 && tokensOf(both) === 1600 && both.roundTimes.length === 2, {
  files: both.fileCount,
  tokens: tokensOf(both),
  rounds: both.roundTimes.length,
});
check('归档会话进统计（比只扫 sessions 多 1500 tokens）', tokensOf(both) - tokensOf(only) === 1500, { delta: tokensOf(both) - tokensOf(only) });

// ③ 同一个根目录传两次不重复计数
const dup = createScanner()([sessions, sessions]);
check('同一根目录传两次：仍 1 个文件 / 100 tokens', dup.fileCount === 1 && tokensOf(dup) === 100, { files: dup.fileCount, tokens: tokensOf(dup) });

// ④ 同一份会话文件同时存在于两处（移动失败留下副本）只算一次
mkdirSync(join(archive, 's1'), { recursive: true });
writeFileSync(join(archive, 's1', 'session.v4.jsonl'), [round(1), line(2, 60, 40)].join('\n'));
const twin = createScanner()([sessions, archive]);
check('同名同会话的副本只算一次（不翻倍成 1700）', tokensOf(twin) === 1600, { tokens: tokensOf(twin), files: twin.fileCount });

// ⑤ listLogsFrom 对不存在的目录安全
const missing = listLogsFrom([join(root, 'nope'), sessions]);
check('不存在的根目录被忽略，不抛错', missing.length === 1, { found: missing.length });

rmSync(root, { recursive: true, force: true });
console.log(`\n归档扫描：断言 ${total} 项，失败 ${failed} 项`);
process.exit(failed === 0 ? 0 : 1);
