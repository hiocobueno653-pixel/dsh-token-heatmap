# dsh-token-heatmap 扩展契约（v2，冻结版）

本文件是**接口冻结文档**：宿主半（`src/scan.js` + `src/cordis.js`）与浏览器半（`lib/client.js`）
各自实现，任何一方需要改字段，必须先改这里并同步另一方。

目标：把「用量热力图」从「一张日历图」升级成参考图里的完整用量页
（参考图见 `../_recon/ref-1-stats-heatmap.png` … `ref-4-heatmap-tooltip.png`）。

---

## 1. Remote 方法（不变）

只有一个远端方法，**不新增方法**，只做加法字段：

```
ctx.get("remote.tokenHeatmap").heatmap(query) -> { ok: true, value: Payload }
```

### 请求 query

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `weeks` | number | 26 | 热力图窗口，clamp 4…104 |
| `mode` | `'day' \| 'week' \| 'cum'` | `'day'` | 热力图配色口径：每日 / 每周 / 累计 |
| `tzOffsetMinutes` | number | `-new Date().getTimezoneOffset()` | 本地时区偏移 |
| `refresh` | boolean | false | true = 跳过结果缓存 |

**性能硬要求**：`mode` 只是呈现层口径，**不得**导致重新解压会话日志。
暖缓存后再换 `mode` 调用，必须满足 `stats.reusedFiles === stats.files`。

### 响应 Payload

```jsonc
{
  "generatedAt": "2026-10-18T12:00:00.000Z",
  "tzOffsetMinutes": 480,
  "sessionsRoot": "C:\\Users\\<you>\\.dsh\\sessions",
  "weeks": 26,
  "mode": "day",
  "window": { "from": "2026-04-20", "to": "2026-10-18" },   // from = to 所在周的周一
  "stats": { "files": 47, "reusedFiles": 47, "decompressedFiles": 0, "usageEvents": 2100,
             "parsedLines": 9000, "badLines": 0, "scanMs": 900 },

  "scale": {
    "metric": "total",
    "mode": "day",
    "cuts": [1e8, 2e8, 3e8, 4e8, 5e8],      // 5 个分位阈值；样本不足 = null
    "max": 1020782001,
    "legend": [ { "level": 1, "min": null, "max": 1e8 }, /* … */ { "level": 6, "min": 5e8, "max": null } ]
  },

  "totals": { "total": 0, "newTokens": 0, "input": 0, "output": 0, "cacheRead": 0,
              "cacheWrite": 0, "requests": 0, "rounds": 0, "days": 0, "hitRate": null },

  "days": [{
    "day": "2026-10-18",
    "total": 38083921, "newTokens": 0, "input": 0, "output": 0,
    "cacheRead": 0, "cacheWrite": 0,
    "requests": 236,          // assistant/message 用量事件条数
    "rounds": 12,             // 当天真实用户消息条数，见 §2
    "hitRate": 0.83,          // cacheRead / (cacheRead + input)，分母 0 → null
    "level": 4,               // 0…6，按 mode 口径分档
    "value": 38083921,        // 该 mode 下参与分档的数值，见 §3
    "models": [ { "model": "deepseek/deepseek-v4.1-flash", "total": 0, "input": 0,
                  "output": 0, "cacheRead": 0, "requests": 0 } ]   // 仅当天，按 total 降序
  }],

  "allTime": {
    "total": 1780000000,          // 全部历史计费总量（不限窗口）
    "activeDays": 11,             // total > 0 的天数
    "rounds": 171,
    "peak": { "day": "2026-10-04", "total": 1020782001 },
    "currentStreak": 1,
    "longestStreak": 5,
    "longestSpanMs": 30120000     // 最长「连续活跃段」，见 §2
  },

  "cached": false
}
```

`days` 只包含**窗口内且当天有数据**的日期，升序；空档由浏览器半自己补格子（维持现状）。

`level` / `legend` / `scale.cuts` **随 `mode` 变化**；`totals`、`allTime` 不随 `mode` 变化。

`stats.decompressedFiles` 是加法字段（本次调用真正解压了几个日志文件，用来直接证明「换 mode 一次解压
都没有」）。任何暖缓存命中都如实报 `reusedFiles === files`、`decompressedFiles === 0`；冷扫时正在被
并发写入的那个会话日志会算 1 次解压 —— 真目录下偶尔看到 49/50，属预期，不是契约问题。

**浏览器半的降级分档必须与宿主同口径**：宿主按 `modeValues(mode, windowDays, …)` 取样，而
`windowDays` = `days[]` 里**有数据的那几天**（空白天根本不出行）。所以浏览器半在「宿主没按
`mode` 返回 payload」时自算 `scale`，取样集合也只能遍历 `days[]`（`week` = 该天所在周的周总量、
`cum` = 只对有数据的天按序累加），**不能**遍历窗口内每一个格子 —— 后者会多塞样本、改变分位数，
冷缓存切 `mode` 时还会先跳一次色。`test/ui.render.test.mjs` 场景 6 把这条钉死了。

**已知且接受的口径边界**：某天「只有用户轮消息、没有任何用量事件」时，`allTime.rounds` 计入、
`totals.rounds` 与该天在 `days[]` 里的行不计（老 `days` 口径：不凭空造出 0 token 的日期行）。
真数据目前不存在这种天。

---

## 2. 指标口径（已在真数据上验证）

数据源：`<sessionsRoot>/<workspace>/<session-id>/session.v4.jsonl.zstd`（多帧 zstd，逐帧解压）。

- **计费总量 total** = `input + output + cacheRead + cacheWrite`（= 日志 `totalTokens`）。口径不变。
- **轮消息 rounds（天）** = 当天 `type === 'user/message'` 且 `data.source.kind === 'user'` 的事件条数。
  ⚠️ **必须过滤注入消息**：实测 `source.kind` 分布里 `time-context`(433) / `team-message`(160) /
  `subagent-settled`(132) / `runtime-context`(63) / `skill-catalog`(53) / `goal`(49) 等都不是用户发言，
  只有 `kind === 'user'`(171) 是。若拿不到 `source.kind`，该条不计入 rounds。
- **最长聊天时长 longestSpanMs** = 逐会话取「连续活跃段」最大值：把该会话所有事件时间戳排序，
  相邻间隔 > 30 分钟即断开，取单段 `末 - 首` 的最大值；再对所有会话取最大。
  （不能用「首末相减」：实测有会话首末跨 427 小时，那是隔了很多天的复用会话。）
- **当前连续天数 currentStreak** = 从本地今天往前数 `total > 0` 的连续天数；今天还没用量时从昨天起算；
  昨天也没有则 0。
- **最长连续天数 longestStreak** = 全部历史里最长的连续 `total > 0` 天段。
- **峰值 peak** = 全部历史里 `total` 最大的那一天。

---

## 3. mode 口径

| mode | `days[].value` | `level` 分档样本 |
| --- | --- | --- |
| `day` | 当天 `total` | 窗口内 `value > 0` 的每一天（= 现状） |
| `week` | 该天所在周（周一起）的 `total` 之和 | 窗口内 `value > 0` 的每一天（同周内各天 value 相同、level 相同） |
| `cum` | 窗口起点到该天（含）的 `total` 累计 | 窗口内 `value > 0` 的每一天 |

分档算法沿用 `levelThresholds` / `levelOf`（1/6…5/6 分位，六档；样本不足回落单档）。

---

## 4. 浏览器半必须呈现的界面（对照参考图）

沿用 `settings.section`（`id: token-heatmap`、`order: 31`、label `用量热力图`）**不新增席位**。
导航图标改画逻辑（`NAV_ICON_PATHS` / `watchNavIcon`）**原样保留**，`NAV_LABEL` 仍是 `用量热力图`。

自上而下：

1. **标题区**：`用量热力图` + 一个 pill（数据来源，如 `本地会话日志`）+ 一句说明。
2. **KPI 条**（参考图 1 顶部，5 列、列间细分隔线，值大号、标签小号灰色）：
   `累计 Token 数`(allTime.total) · `峰值 Token 数`(allTime.peak.total，副标题峰值日) ·
   `最长聊天时长`(longestSpanMs，如 `8 小时 22 分钟`) · `当前连续天数` · `最长连续天数`。
3. **Token 活动卡**：
   - 卡头左 `Token 活动`，右分段控件 `每日 | 每周 | 累计`（= `mode`）。
   - 日历网格：列 = 周（周一起），行 = 周一…周日；**月份轴在网格下方**（参考图 1）；
     格子 ~13–15px、圆角 3–4px、无边框；今天那格加一圈 ring。
   - **悬停浮层**（参考图 4）：`2026年9月24日` + `4.5亿 tokens · 55 轮消息`，跟随鼠标、不出卡。
   - **点击格子**仍要能下钻到当天明细（保留现有 `detailView`：KPI + 分模型表格）。
   - 六档图例（写清每档区间）。
4. **时间范围行**：左 `时间范围`，右分段控件 `近 7 日 | 近 30 日`。
5. **每日 Token 趋势图卡**（参考图 2/3）：图例（圆点 + 模型名，取该区间内 top 模型，含 `其他` 兜底）；
   SVG 折线（平滑曲线）、虚线横向网格、底部日期轴；悬停显示竖线 + 浮层（模型名 + 值）。
6. **模型用量卡**（参考图 2）：SVG 环形图（中心显示区间总量 + `tokens`）+ 右侧列表
   （色点、模型名、百分比、token 数）。
7. **底部**：右下 `刷新` 按钮（`refresh: true`）+ 现有那行扫描统计小字。

数据全部来自 `days`（趋势序列与环形图由浏览器半按 `rangeDays` 在 `days[].models` 上聚合，
不新增远端方法）。配色继续走 `--dsw-*` 主题令牌，图表色板用语义色 + 固定兜底色。
