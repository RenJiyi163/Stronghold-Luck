// verify-mobile-ui.mjs — 面板在小屏与触屏上的可读性、点击目标（真浏览器驱动）。
//
//   node test/verify-mobile-ui.mjs [--port 3199] [--chrome <path>]
//
// 面板是照桌面画的。游戏的布局根是 clamp(40px, min(100vw/19.2, 100vh/10.8), 240px)（public/css/theme.css），
// 手机上被夹到 40px，于是面板里所有 rem 尺寸只剩设计值的四成；行与筹码又只有一个鼠标点得到的尺寸。
// 两处分开修，这个自检也分开量：
//
//   桌面   1600×900：不挂 spmod-touch，字号就是设计值（.14rem）
//   窗口   1100×620（无触屏，布局根 57px）：照样挂上 spmod-touch
//   手机   844×390：挂上 spmod-touch，正文 ≥ 10px，可点的行 ≥ 30px 高，面板不越出视口
//   字号   把 <html> 的 data-text 拨到 xl（游戏的「文字大小：特大」）：面板字号跟着变大
//   改尺寸 在 1600×900 上点「满」，再换到 844×390：面板要重新收进视口，且记住的值不被改掉
//
// Self-contained: the game's release package ships no `test/`, so this drives the page itself.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fsp.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3199;
const chromeArg = process.argv.indexOf('--chrome');
const CHROME = chromeArg >= 0 ? process.argv[chromeArg + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
/** --shot <file>：把手机视口下面板张开的样子存一张图，给人眼看 */
const shotArg = process.argv.indexOf('--shot');
const SHOT = shotArg >= 0 ? process.argv[shotArg + 1] : null;
const base = `http://127.0.0.1:${port}`;

const require = createRequire(path.join(MOD_ROOT, 'package.json'));
const puppeteer = (await import(pathToFileURL(require.resolve('puppeteer-core')).href)).default;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

const child = spawn(process.execPath, [path.join(MOD_ROOT, 'src', 'launcher.mjs'), '--no-open', '--port', String(port)], {
  cwd: MOD_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
});
let out = '';
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1600,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.log('  [page error]', e.message));

const phase = () => page.evaluate(() => globalThis.__SP__.store.get().match?.public?.phase ?? null);
const waitPhase = async (p, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await phase()) === p) return true; await sleep(400); }
  return false;
};
const clickText = async (re, sel = 'button') => {
  const box = await page.evaluate((r, s) => {
    const rx = new RegExp(r);
    for (const e of document.querySelectorAll(s)) {
      if (!rx.test((e.textContent || '').replace(/\s+/g, ' ').trim())) continue;
      const b = e.getBoundingClientRect();
      if (b.width < 2 || b.height < 2) continue;
      return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
    }
    return null;
  }, re, sel);
  if (!box) return false;
  await page.mouse.click(box.x, box.y);
  return true;
};

/** Everything one viewport check needs, in one round trip. */
const probe = () => page.evaluate(() => {
  const p = (v) => parseFloat(v) || 0;
  const html = document.documentElement;
  const panel = document.querySelector('.spmod-panel');
  const row = document.querySelector('.spmod-row');
  const name = document.querySelector('.spmod-row .spmod-name');
  // --spmod-t is a token stream (max(var(--t, 1rem), 76px)); resolve it through a throwaway probe
  const spot = document.createElement('span');
  spot.style.cssText = 'position:absolute;visibility:hidden;font-size:var(--spmod-t, 1rem)';
  panel.appendChild(spot);
  const tPx = p(getComputedStyle(spot).fontSize);
  spot.remove();
  const r = panel.getBoundingClientRect();
  const rr = row ? row.getBoundingClientRect() : null;
  return {
    touch: html.classList.contains('spmod-touch'),
    textAttr: html.dataset.text || '(sm)',
    rootPx: p(getComputedStyle(html).fontSize),
    tPx,
    namePx: name ? p(getComputedStyle(name).fontSize) : 0,
    rowH: rr ? rr.height : 0,
    rowW: rr ? rr.width : 0,
    panel: { x: r.x, y: r.y, w: r.width, h: r.height },
    vw: window.innerWidth, vh: window.innerHeight,
  };
});

const openPanel = async () => {
  if (!(await page.$('.spmod.is-open'))) await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
  await page.waitForSelector('.spmod.is-open .spmod-row', { visible: true, timeout: 8000 });
  await sleep(150);
};
const closePanel = async () => { await page.keyboard.press('Escape'); await sleep(250); };
const setViewport = async (o) => { await page.setViewport(o); await sleep(600); };

console.log(`\nStronghold-Luck 小屏 / 触屏布局自检 — ${gameRoot}\n`);

await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

try {
  await page.type('.field__input', '杜宾');
  await clickText('^开始$');
  await sleep(1200);
  await page.evaluate(() => [...document.querySelectorAll('.mode-card')].find((x) => /独立模拟/.test(x.textContent))?.click());
  await sleep(500);
  await page.evaluate(() => [...document.querySelectorAll('.diff-card')].find((x) => /绝境模拟/.test(x.textContent))?.click());
  await sleep(400);
  await clickText('开始独立模拟');
  await sleep(2500);
  await clickText('^开始模拟$');
  assert.ok(await waitPhase('INFO_CHECK', 40000), '没进到开局简报');
  await sleep(800);
  await clickText('准备就绪');
  assert.ok(await waitPhase('BAND_DRAFT', 40000), '没进到选择策略');
  await sleep(1200);
  await page.evaluate(() => {
    const lp = (e) => Number(((e.textContent || '').match(/(\d+)/) || [])[1]) || 0;
    const rows = [...document.querySelectorAll('.dband')].filter((e) => !e.className.includes('is-off'));
    rows.sort((a, b) => lp(a) - lp(b));
    (rows[0] || document.querySelector('.dband'))?.click();
  });
  await sleep(600);
  await clickText('确认选择');
  assert.ok(await waitPhase('PREP', 60000), '没进到第一个休整期');
  await sleep(1500);
  await openPanel();
} catch (e) {
  console.log('  ✗ 进不了对局：', e.message.split('\n')[0]);
  fail++;
}

await check('桌面 1600×900：不挂 spmod-touch', async () => {
  const s = await probe();
  assert.equal(s.touch, false, '桌面视口挂上了 spmod-touch');
  assert.ok(s.rootPx > 80 && s.rootPx < 90, `布局根是 ${s.rootPx}px，不像是 1600×900`);
});

await check('桌面：字号还是设计值（.14rem），和改之前一个样', async () => {
  const s = await probe();
  assert.ok(Math.abs(s.tPx - s.rootPx) < 0.5, `面板文字根 ${s.tPx}px ≠ 布局根 ${s.rootPx}px`);
  const want = 0.14 * s.rootPx;
  assert.ok(Math.abs(s.namePx - want) < 0.3, `名字 ${s.namePx}px，设计值是 ${want.toFixed(1)}px`);
});

await check('窗口 1100×620（无触屏）：布局根 < 64px，照样挂上 spmod-touch', async () => {
  await closePanel();
  await setViewport({ width: 1100, height: 620 });
  await openPanel();
  const s = await probe();
  assert.ok(s.rootPx < 64, `布局根 ${s.rootPx}px，这个视口本该小于 64px`);
  assert.equal(s.touch, true, '小窗口没挂上 spmod-touch');
});

await check('手机 844×390：挂上 spmod-touch，正文 ≥ 10px', async () => {
  await closePanel();
  await setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openPanel();
  const s = await probe();
  assert.equal(s.touch, true, '手机视口没挂上 spmod-touch');
  assert.ok(s.tPx >= 76, `面板文字根只有 ${s.tPx}px（下限是 76px）`);
  assert.ok(s.namePx >= 10, `名字只有 ${s.namePx.toFixed(1)}px，手机上读不清`);
});

await check('手机：可点的行至少 30px 高、且不越出视口', async () => {
  const s = await probe();
  assert.ok(s.rowH >= 30, `列表行只有 ${s.rowH.toFixed(1)}px 高，手指点不准`);
  assert.ok(s.rowW > 60, `列表行只有 ${s.rowW.toFixed(1)}px 宽`);
  assert.ok(s.panel.x >= -1 && s.panel.y >= -1, `面板左上角跑到视口外：x=${s.panel.x.toFixed(1)} y=${s.panel.y.toFixed(1)}`);
  assert.ok(s.panel.x + s.panel.w <= s.vw + 1, `面板右边越界：${(s.panel.x + s.panel.w).toFixed(1)} > ${s.vw}`);
  assert.ok(s.panel.y + s.panel.h <= s.vh + 1, `面板下边越界：${(s.panel.y + s.panel.h).toFixed(1)} > ${s.vh}`);
});

await check('文字大小：把 data-text 拨到 xl，面板字号跟着变大（原来完全不理这个设置）', async () => {
  const before = await probe();
  await page.evaluate(() => { document.documentElement.dataset.text = 'xl'; });
  await sleep(300);
  const after = await probe();
  assert.ok(after.tPx > before.tPx, `文字根没动：${before.tPx} → ${after.tPx}`);
  assert.ok(after.namePx > before.namePx + 0.5, `名字没变大：${before.namePx.toFixed(1)} → ${after.namePx.toFixed(1)}`);
  await page.evaluate(() => { document.documentElement.dataset.text = 'sm'; });
  await sleep(200);
  const back = await probe();
  assert.ok(Math.abs(back.namePx - before.namePx) < 0.6, `拨回 小 之后名字没回到原值：${back.namePx.toFixed(1)} vs ${before.namePx.toFixed(1)}`);
});

if (SHOT) {
  await page.screenshot({ path: SHOT });
  console.log(`  · 手机视口截图：${SHOT}`);
}

// 尺寸是「为哪块屏选的、就按那块屏的像素存」，所以换小屏之后必须重新收进视口。手机上最刺眼的一档是「满」：
// 桌面 1600×900 上它是 1536×846，原样搬到 844×390 的视口，面板会因为居中定位上下都溢出（y 变负）。
await check('换小视口：存下来的尺寸重新收进视口，且没把存的值改掉', async () => {
  await closePanel();
  await setViewport({ width: 1600, height: 900 });
  await openPanel();
  assert.ok(await clickText('^满$'), '没点到「满」');
  await sleep(500);
  const big = await probe();
  assert.ok(big.panel.h > 400, `「满」没生效，面板只有 ${big.panel.h.toFixed(1)}px 高`);
  const stored = await page.evaluate(() => localStorage.getItem('spmod.size'));

  await closePanel();
  await setViewport({ width: 844, height: 390, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  await openPanel();
  const s = await probe();
  assert.ok(s.panel.y >= -1, `面板上边被裁掉：y=${s.panel.y.toFixed(1)}（存的是 ${big.panel.w.toFixed(0)}×${big.panel.h.toFixed(0)}）`);
  assert.ok(s.panel.y + s.panel.h <= s.vh + 1, `面板下边越界：${(s.panel.y + s.panel.h).toFixed(1)} > ${s.vh}`);
  assert.ok(s.panel.x >= -1 && s.panel.x + s.panel.w <= s.vw + 1, `面板左右越界：${s.panel.x.toFixed(1)} … ${(s.panel.x + s.panel.w).toFixed(1)} / ${s.vw}`);
  assert.ok(s.panel.h <= s.vh, `面板比视口还高：${s.panel.h.toFixed(1)} > ${s.vh}`);
  const after = await page.evaluate(() => localStorage.getItem('spmod.size'));
  assert.equal(after, stored, '收进视口时把记住的尺寸改掉了（回到大屏应该还是原来那个盒子）');
});

await check('手机：面板张开时三条悬浮条让位，关上就回来', async () => {
  const visible = () => page.evaluate(() => ['.spmod-speed', '.spmod-auto', '.spmod-sandbox']
    .filter((s) => { const e = document.querySelector(s); return !!e && !e.hidden && e.getBoundingClientRect().width > 1; }));
  await closePanel();
  const before = await visible();
  assert.ok(before.length > 0, '面板关着时一条悬浮条都没有，先看游戏侧是不是没显示');
  await openPanel();
  await sleep(200);
  const during = await visible();
  assert.equal(during.length, 0, `面板张开时还压在面板上：${during.join(', ')}`);
  await closePanel();
  const after = await visible();
  assert.deepEqual(after.slice().sort(), before.slice().sort(), `关上之后没回来：${before.join(',')} → ${after.join(',')}`);
  await openPanel();
});

console.log(`\n✓ 通过 ${pass}，失败 ${fail}\n`);

await browser.close();
try { child.kill(); } catch { /* ignore */ }
process.exit(fail ? 1 : 0);
