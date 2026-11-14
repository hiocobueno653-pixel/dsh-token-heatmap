/**
 * 左导航图标改画（齿轮 → lucide chart-no-axes-combined）的真浏览器回归。
 *
 * 为什么必须在真浏览器里测：这条改动完全作用在宿主 DOM 上（class 选择器、SVG 命名空间、
 * MutationObserver 的自激与否、宿主重渲染后的自愈），jsdom 的 SVG/observer 语义都不可信。
 *
 * 仿真对象取自宿主 SettingsRoot 的真实结构：面板是 createPortal 进 document.body 的
 * `[data-shortcut-modal="settings"]`，每个 section 一行 `[class*="navCell"]` 按钮，
 * 行内先一个 16px 的 `<svg viewBox="0 0 16 16">`（齿轮 = 2 个 path），再一个 label span。
 *
 * 覆盖：
 *   1. 面板打开后本插件行被改画成 6 条 lucide path，viewBox 换成 24×24，尺寸不变；
 *   2. 只动本插件那一行，其它行（含同样带 svg 的「通用设置」）保持齿轮；
 *   3. 宿主重渲染把自己那 2 个 path 的 d 写回去（模拟 React 复用同一 svg 节点）→ 自愈；
 *   4. 反复触发不产生新 mutation（observer 不自激），且全程无 pageerror。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require(
	process.env.DSHP_PLAYWRIGHT ||
	(process.env.USERPROFILE || '') + '/AppData/Local/npm-cache/_npx/9833c18b2d85bc59/node_modules/playwright',
);

const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');

/** 抠出插件里一个顶层函数（按大括号配平），保证测的就是插件本体。 */
function grabFunction(name) {
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

const pathsBlock = /^\t\tvar NAV_ICON_PATHS = \[[\s\S]*?\];/m.exec(source);
if (!pathsBlock) throw new Error('找不到 NAV_ICON_PATHS');
const expectedPaths = new Function(pathsBlock[0].replace(/^\t\t/, '') + '\nreturn NAV_ICON_PATHS;')();
if (expectedPaths.length !== 6) throw new Error('NAV_ICON_PATHS 期望 6 条，实际 ' + expectedPaths.length);

/* 单行常量按行抠；NAV_ICON_PATHS 是多行数组，单独整块抠 */
const consts =
	(source.match(/^\t\tvar (NAV_LABEL|SVG_NS|NAV_ICON_MARK|NAV_PATH_MARK)[^\n]*$/gm) || [])
		.map((l) => l.replace(/^\t\t/, ''))
		.join('\n') +
	'\n' +
	pathsBlock[0].replace(/^\t\t/, '');

const installSrc =
	consts +
	'\n' +
	['findSettingsPanel', 'findOwnNavCell', 'paintNavIcon', 'watchNavIcon'].map(grabFunction).join('\n') +
	'\nreturn { findSettingsPanel: findSettingsPanel, findOwnNavCell: findOwnNavCell, paintNavIcon: paintNavIcon, watchNavIcon: watchNavIcon };\n';

const CHROME = process.env.DSHP_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const browser = await chromium.launch({ executablePath: CHROME });
const page = await browser.newPage({ viewport: { width: 1000, height: 800 } });

const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
	if (m.type() === 'error') errors.push('console: ' + m.text());
});

/* ---- 宿主样式：navCell 行高 40px，图标 16px（取自 SettingsRoot.module.css 的量级） ---- */
await page.setContent(`<!doctype html><html><head><style>
	body{margin:0;font:14px system-ui}
	._nav_{display:flex;flex-direction:column;gap:4px;width:188px;padding:22px 12px}
	._navCell_{height:40px;display:flex;align-items:center;gap:8px;padding:0 10px 0 8px;border:0;background:none;border-radius:6px;cursor:pointer;font:inherit;text-align:left}
	._navIcon_{flex:none}
	._navLabel_{white-space:nowrap;overflow:hidden}
</style></head><body><div id="app"></div></body></html>`);

await page.evaluate(() => {
	window.__mount = function (rows) {
		const host = document.getElementById('app');
		host.innerHTML = '';
		/* 面板挂在 body 上，重复 mount 前必须先清掉旧的，否则 querySelector 会命中上一轮的残留 */
		document.querySelectorAll('[data-shortcut-modal="settings"]').forEach((p) => p.remove());
		const panel = document.createElement('div');
		panel.setAttribute('data-shortcut-modal', 'settings');
		panel.className = '_panel_';
		const nav = document.createElement('div');
		nav.className = '_nav_';
		for (const r of rows) {
			const cell = document.createElement('button');
			cell.type = 'button';
			cell.className = '_navCell_ ' + r.cls;
			cell.dataset.rowId = r.id;
			/* 齿轮：viewBox 16×16 + 2 条 path（与宿主 IconSettingsOutlineArtwork 同形制） */
			cell.innerHTML =
				'<svg width="16" height="16" class="_navIcon_" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" stroke-width="1.3">' +
				'<path d="M8 9.75C8.97 9.75 9.75 8.97 9.75 8C9.75 7.03 8.97 6.25 8 6.25C7.03 6.25 6.25 7.03 6.25 8C6.25 8.97 7.03 9.75 8 9.75012Z" stroke="currentColor"></path>' +
				'<path d="M13.01 7.79L2.99 6.17" stroke="currentColor"></path>' +
				'</svg><span class="_navLabel_">' + r.label + '</span>';
			nav.appendChild(cell);
		}
		panel.appendChild(nav);
		/* 面板是 portal 到 body 的，这里保持一致 */
		document.body.appendChild(panel);
	};
	window.__unmount = function () {
		const p = document.querySelector('[data-shortcut-modal="settings"]');
		if (p) p.remove();
	};
	/** 模拟 React 复用同一 svg 节点、把自己那 2 条 path 的 d 写回旧值。 */
	window.__hostRerender = function (rowId) {
		const cell = document.querySelector('[data-row-id="' + rowId + '"]');
		const svg = cell.querySelector('svg');
		svg.setAttribute('viewBox', '0 0 16 16');
		const paths = svg.querySelectorAll('path');
		paths[0].setAttribute('d', 'M8 9.75C8.97 9.75 9.75 8.97 9.75 8C9.75 7.03 8.97 6.25 8 6.25C7.03 6.25 6.25 7.03 6.25 8C6.25 8.97 7.03 9.75 8 9.75012Z');
	};
	window.__readRow = function (rowId) {
		const cell = document.querySelector('[data-row-id="' + rowId + '"]');
		if (!cell) return null;
		const svg = cell.querySelector('svg');
		const box = svg.getBoundingClientRect();
		return {
			viewBox: svg.getAttribute('viewBox'),
			drawingWidth: svg.getAttribute('width'),
			drawingHeight: svg.getAttribute('height'),
			paintedWidth: Math.round(box.width * 10) / 10,
			paintedHeight: Math.round(box.height * 10) / 10,
			strokeWidth: svg.getAttribute('stroke-width'),
			stroke: svg.getAttribute('stroke'),
			pathCount: svg.querySelectorAll('path').length,
			deltas: Array.prototype.map.call(svg.querySelectorAll('path'), (p) => p.getAttribute('d')),
			mark: svg.getAttribute('data-thm-nav-icon'),
			cellHeight: Math.round(cell.getBoundingClientRect().height),
		};
	};
});

let failures = 0;
const check = (name, ok, detail) => {
	console.log((ok ? '  ok   ' : '  FAIL ') + name + (ok || detail === undefined ? '' : ' - ' + JSON.stringify(detail)));
	if (!ok) failures++;
};
const raf = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));

/* ---- 装上插件的图标逻辑（等价于 apply() 里那条 ctx.effect） ---- */
await page.evaluate(
	(installSrc) => {
		const api = new Function('document', 'MutationObserver', 'requestAnimationFrame', 'setTimeout', installSrc)(
			document,
			MutationObserver,
			requestAnimationFrame,
			setTimeout,
		);
		window.__dispose = api.watchNavIcon();
		window.__paintOnce = api.paintNavIcon;
		window.__findOnce = api.findOwnNavCell;
	},
	installSrc,
);

const ROWS = [
	{ id: 'general', cls: '_navCell_general_', label: '通用设置' },
	{ id: 'token-heatmap', cls: '_navCell_heatmap_', label: '用量热力图' },
	{ id: 'archive', cls: '_navCell_archive_', label: '归档会话' },
];

/* 1. 插件 effect 先跑、面板后打开：靠 body 子节点观察自动补画 */
await page.evaluate((rows) => window.__mount(rows), ROWS);
await raf();
let mine = await page.evaluate(() => window.__readRow('token-heatmap'));
check('面板打开后本插件行被改画', mine && mine.pathCount === 6 && mine.viewBox === '0 0 24 24', mine);
check('六条 d 与 lucide chart-no-axes-combined 一致', mine && JSON.stringify(mine.deltas) === JSON.stringify(expectedPaths), mine && mine.deltas);
check('描边参数照用户给的 SVG', mine && mine.strokeWidth === '2' && mine.stroke === 'currentColor', mine);
check('绘制尺寸仍是宿主的 16px（行高不变）', mine && mine.paintedWidth === 16 && mine.paintedHeight === 16 && mine.cellHeight === 40, mine);
check('打了已画标记', mine && mine.mark === '1', mine);

const others = await page.evaluate(() => [window.__readRow('general'), window.__readRow('archive')]);
check(
	'其它行没被误伤（仍是 16×16 齿轮两条 path）',
	others.every((r) => r.viewBox === '0 0 16 16' && r.pathCount === 2 && r.mark === null),
	others,
);

/* 截图留证：本插件行已换成折线柱图标，其它行仍是齿轮 */
await page.screenshot({
	path: fileURLToPath(new URL('./nav-icon-painted.png', import.meta.url)),
	clip: { x: 0, y: 0, width: 260, height: 180 },
});

/* 2. 幂等：再扫一遍不新增 path、不产生 mutation */
const before = await page.evaluate(() => window.__readRow('token-heatmap'));
const mutationCount = await page.evaluate(async () => {
	const panel = document.querySelector('[data-shortcut-modal="settings"]');
	let n = 0;
	const mo = new MutationObserver((recs) => (n += recs.length));
	mo.observe(panel, { childList: true, subtree: true, attributes: true, characterData: true });
	await new Promise((r) => setTimeout(r, 120));
	mo.disconnect();
	return n;
});
const after = await page.evaluate(() => window.__readRow('token-heatmap'));
check('静置 120ms 无自激 mutation', mutationCount === 0, mutationCount);
check('重复扫描结果不变', JSON.stringify(before) === JSON.stringify(after), { before, after });

/* 3. 宿主重渲染把 d 写回齿轮 → 自愈（模拟 React 复用同一 svg 节点） */
await page.evaluate(() => window.__hostRerender('token-heatmap'));
await raf();
mine = await page.evaluate(() => window.__readRow('token-heatmap'));
check('宿主重写 d 之后能自愈', mine.pathCount === 6 && mine.viewBox === '0 0 24 24' && JSON.stringify(mine.deltas) === JSON.stringify(expectedPaths), mine);

/* 4. 关掉面板再重开（DOM 全新）→ 重新画 */
await page.evaluate(() => window.__unmount());
await raf();
await page.evaluate((rows) => window.__mount(rows), ROWS);
await raf();
mine = await page.evaluate(() => window.__readRow('token-heatmap'));
check('面板重开后重新生效', mine.pathCount === 6 && JSON.stringify(mine.deltas) === JSON.stringify(expectedPaths), mine);

/* 5. 只有文案没有 svg 的那一帧：不报错，等下一帧 */
await page.evaluate(() => {
	window.__unmount();
	const panel = document.createElement('div');
	panel.setAttribute('data-shortcut-modal', 'settings');
	const cell = document.createElement('button');
	cell.type = 'button';
	cell.className = '_navCell_';
	cell.dataset.rowId = 'svgless';
	cell.innerHTML = '<span class="_navLabel_">用量热力图</span>';
	panel.appendChild(cell);
	document.body.appendChild(panel);
});
await raf();
check(
	'缺 svg 时不抛错、也不误画',
	(await page.evaluate(() => {
		const cell = window.__findOnce(document.querySelector('[data-shortcut-modal="settings"]'));
		return cell !== null && cell.querySelector('svg') === null;
	})) === true,
);
await page.evaluate(() => window.__unmount());

/* 5b. 面板开着时，面板外的同名按钮也不能被改画（只认设置面板那一棵） */
await page.evaluate((rows) => {
	window.__mount(rows);
	const stray = document.createElement('button');
	stray.className = '_navCell_';
	stray.dataset.rowId = 'stray';
	stray.innerHTML =
		'<svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M8 9.75" stroke="currentColor"></path><path d="M13 7.79" stroke="currentColor"></path></svg>' +
		'<span class="_navLabel_">用量热力图</span>';
	document.getElementById('app').appendChild(stray);
}, ROWS);
await raf();
const stray = await page.evaluate(() => window.__readRow('stray'));
check('面板外的同名按钮不被改画', stray.viewBox === '0 0 16 16' && stray.pathCount === 2, stray);
const inPanel = await page.evaluate(() => window.__readRow('token-heatmap'));
check('面板内那一行照常改画', inPanel.pathCount === 6 && inPanel.viewBox === '0 0 24 24', inPanel);
await page.evaluate(() => {
	const s = document.querySelector('[data-row-id="stray"]');
	if (s) s.remove();
});

/* 6. 卸载后不再观察 */
await page.evaluate(() => window.__dispose());
await page.evaluate((rows) => window.__mount(rows), ROWS);
await raf();
const disposed = await page.evaluate(() => window.__readRow('token-heatmap'));
check('dispose 之后不再改画', disposed.viewBox === '0 0 16 16' && disposed.pathCount === 2, disposed);

check('全程无 pageerror / console.error', errors.length === 0, errors);

await page.screenshot({ path: fileURLToPath(new URL('./nav-icon.png', import.meta.url)), clip: { x: 0, y: 0, width: 260, height: 180 } });
await browser.close();

console.log(failures === 0 ? '\n全部通过' : '\n失败 ' + failures + ' 项');
process.exit(failures === 0 ? 0 : 1);
