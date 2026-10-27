// verify-diy-ui.mjs — 自选编队 (0.2.0 DIY) through the real browser UI.
//
//   node test/verify-diy-ui.mjs [--port 3197] [--chrome <path>]
//
// Boots the modded launcher, sets 自选编队 picks over the game's own `room.diy` intent, plays into the first PREP of a
// solo ABYSS match and checks that the panel lists the seat's own pieces (composed name, tier, its own 调度中心 gate),
// that the server refuses them with the LEVEL reason while the level is short, and that a preset operator is still
// filled into a shop slot. It also walks the panel's size presets and its two views.
//
// Self-contained on purpose: the game's release package ships no `test/`, so this one drives the page itself instead of
// the game's e2e client (which test/verify-ui.mjs needs).
//
// The picks are two 原型干员 — a prototype keeps its stock whatever the drawn bans are (协防 is never banned), so the
// list is non-empty in any match. Nothing here writes to the game folder.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fsp.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3197;
const chromeArg = process.argv.indexOf('--chrome');
const CHROME = chromeArg >= 0 ? process.argv[chromeArg + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = `http://127.0.0.1:${port}`;

/** The 自选编队 picks this run slots: one prototype per tier (a prototype may fill one tier-5 and one tier-6 slot). */
const PICKS = { chess_char_5_diy1_a: { charId: 'char_601_cguard' }, chess_char_6_diy1_a: { charId: 'char_608_acpion' } };
/** An operator card, in either of the panel's two views (立绘 cards / 名字 rows). */
const CARD = '.spmod-card[data-id], .spmod-row[data-id]';

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
const stop = async () => { try { child.kill(); } catch { /* ignore */ } await sleep(400); };

for (let i = 0; i < 100; i++) {
  try { if ((await fetch(`${base}/healthz`)).ok) break; } catch { /* wait */ }
  await sleep(250);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--no-sandbox', '--window-size=1600,900'] });
const page = await browser.newPage();
await page.setViewport({ width: 1600, height: 900 });
page.on('pageerror', (e) => console.log('  [page error]', e.message));
page.on('console', (m) => { const t = m.text(); if (/\[luck\]/.test(t)) console.log('  [page]', t); });
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

const phase = () => page.evaluate(() => globalThis.__SP__.store.get().match?.public?.phase ?? null);
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
const waitPhase = async (p, ms = 60000) => {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if ((await phase()) === p) return true; await sleep(400); }
  return false;
};

console.log(`\nStronghold-Luck 自选编队界面自检 — ${gameRoot}\n`);

let reached = false;
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

  console.log('[自选编队生效]');
  const set = await page.evaluate((picks) => globalThis.__SP__.net.request('room.diy', { picks })
    .then(() => 'ok', (e) => String(e?.detail || e?.code || e)), PICKS);
  await check('房间接受自选编队（room.diy）', () => assert.equal(set, 'ok'));

  await clickText('开始模拟');
  reached = await waitPhase('INFO_CHECK', 40000);
  if (!reached) throw new Error('没进到开局简报');
  await sleep(800);
  await clickText('准备就绪');
  assert.ok(await waitPhase('BAND_DRAFT', 40000), '没进到选择策略');
  await sleep(1200);
  await page.evaluate(() => document.querySelector('.dband')?.click());
  await sleep(600);
  await clickText('确认选择');
  assert.ok(await waitPhase('PREP', 60000), '没进到第一个休整期');
  await sleep(1500);

  const seen = await page.evaluate(() => {
    const p = globalThis.__SP__.store.get().match.private;
    return { diy: Object.keys(p.diy || {}), pick: p.shop?.modPickable?.diy || [], level: p.shop?.level };
  });
  await check('对局记住了自选编队', () => assert.equal(seen.diy.length, Object.keys(PICKS).length, `服务端 picks: ${seen.diy.join(',')}`));
  await check('自选干员进了候选列表', () => {
    const ids = seen.pick.map((d) => d.id).sort();
    assert.deepEqual(ids, Object.keys(PICKS).sort());
    for (const d of seen.pick) {
      assert.ok(Number.isInteger(d.level) && d.level > 0, `${d.id} 没有等级门槛`);
      assert.equal(typeof d.ok, 'boolean');
    }
  });

  console.log('\n[服务端资格]');
  const raw = await page.evaluate(async () => {
    const send = (t, f) => globalThis.__SP__.net.request(t, f).then(() => 'ok', (e) => String(e?.detail || e?.code || e));
    return {
      buy5: await send('g.modBuy', { id: 'chess_char_5_diy1_a' }),
      pick6: await send('g.modPick', { slot: 0, id: 'chess_char_6_diy1_a' }),
      elite: await send('g.modBuy', { id: 'chess_char_5_diy1_b' }),
      unslotted: await send('g.modBuy', { id: 'chess_char_5_diy2_a' }),
    };
  });
  await check('等级不够时给的是等级理由（不是「不可招募」）', () => {
    if (seen.level >= 5) return; // the match already opened the slots — the refusal below is the level gate then too
    assert.match(raw.buy5, /调度中心等级不足/, `实际：${raw.buy5}`);
    assert.match(raw.pick6, /调度中心等级不足/, `实际：${raw.pick6}`);
  });
  await check('精锐形态被拒', () => assert.equal(raw.elite, '不是可招募的干员'));
  await check('没填的自选槽位被拒', () => assert.equal(raw.unslotted, '不是本局可用的自选干员'));

  console.log('\n[面板]');
  await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
  await sleep(1200);
  const panel = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('.spmod-row')];
    const diy = rows.filter((r) => r.querySelector('.spmod-diy'));
    return {
      nameView: !!document.querySelector('.spmod-grid.is-name'),
      rows: rows.length,
      diy: diy.map((r) => ({ id: r.getAttribute('data-id'), text: r.innerText.replace(/\s+/g, ' '), locked: r.className.includes('is-locked') })),
    };
  });
  await check('名字视图默认打开，自选干员列在最前并带「自选」标记', () => {
    assert.ok(panel.nameView, '默认不是名字视图');
    assert.ok(panel.rows > 3, `只画出 ${panel.rows} 行`);
    assert.equal(panel.diy.length, Object.keys(PICKS).length);
    for (const d of panel.diy) assert.ok(d.text.includes('自选'), `没有自选标记：${d.text}`);
  });
  await check('等级没到时点它只说明原因', async () => {
    if (seen.level >= 5) return;
    await page.evaluate(() => document.querySelector('.spmod-row .spmod-diy')?.closest('button')?.click());
    await sleep(800);
    const flash = await page.$eval('.spmod-flash', (e) => e.textContent).catch(() => '');
    assert.match(flash, /调度中心到 Lv\.\d+ 才会出现在商店里/, `实际：${flash}`);
  });
  await check('普通干员照旧放进槽位', async () => {
    const before = await page.evaluate(() => globalThis.__SP__.store.get().match.private.shop.slots[0]?.id);
    const id = await page.evaluate(() => {
      const c = [...document.querySelectorAll('.spmod-row[data-id]')].find((r) => !r.classList.contains('is-locked'));
      return c?.getAttribute('data-id') || null;
    });
    assert.ok(id, '没有可点的普通干员');
    await page.evaluate((x) => document.querySelector(`.spmod-row[data-id="${x}"]`)?.click(), id);
    await sleep(1500);
    const slot0 = await page.evaluate(() => globalThis.__SP__.store.get().match.private.shop.slots[0]?.id);
    assert.equal(slot0, id, `槽位 0 是 ${slot0}（原 ${before}），期望 ${id}`);
  });
  await check('大小可切换：小 < 中 < 大 < 满', async () => {
    const w = {};
    for (const label of ['小', '中', '大', '满']) {
      await clickText(`^${label}$`, '.spmod-sizebtn');
      await sleep(500);
      w[label] = await page.evaluate(() => Math.round(document.querySelector('.spmod-panel').getBoundingClientRect().width));
    }
    assert.ok(w['小'] < w['中'] && w['中'] < w['大'] && w['大'] < w['满'], JSON.stringify(w));
    await clickText('^中$', '.spmod-sizebtn');
    await sleep(400);
  });
  await check('立绘视图按 1:2 画，不再裁成一条', async () => {
    await clickText('^立绘$', '.spmod-segbtn');
    await sleep(1000);
    const box = await page.evaluate(() => {
      const b = document.querySelector('.spmod-card .spmod-art')?.getBoundingClientRect();
      return b ? { w: b.width, h: b.height } : null;
    });
    assert.ok(box, '没有立绘');
    assert.ok(Math.abs(box.h / box.w - 2) < 0.05, `立绘框 ${Math.round(box.w)}×${Math.round(box.h)}，不是 1:2`);
    await clickText('^名字$', '.spmod-segbtn');
  });
  await check('拖右下角能改大小', async () => {
    await clickText('^中$', '.spmod-sizebtn');
    await sleep(500);
    const from = await page.evaluate(() => {
      const g = document.querySelector('.spmod-grip');
      const b = g?.getBoundingClientRect();
      return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2, w: document.querySelector('.spmod-panel').getBoundingClientRect().width } : null;
    });
    assert.ok(from, '没有拖角');
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    await page.mouse.move(from.x + 120, from.y + 60, { steps: 6 });
    await page.mouse.up();
    await sleep(500);
    const w = await page.evaluate(() => document.querySelector('.spmod-panel').getBoundingClientRect().width);
    assert.ok(w > from.w + 60, `拖动后宽度 ${Math.round(w)}，拖前 ${Math.round(from.w)}`);
    await clickText('^中$', '.spmod-sizebtn');
    await sleep(400);
  });
  await check('装备页签在名字视图下也列得出来', async () => {
    await page.evaluate(() => { const t = [...document.querySelectorAll('.spmod-tab')]; t[t.length - 1]?.click(); });
    await sleep(800);
    const rows = await page.$$eval('.spmod-grid--item button[data-id]', (els) => els.length);
    assert.ok(rows > 0, '装备页签没有内容');
    await page.evaluate(() => document.querySelectorAll('.spmod-tab')[0]?.click());
    await sleep(600);
  });
  // the bug that made the 自动倒转 bar invisible: a dragged spot is pixels for the window it was dragged in, so a
  // smaller window later leaves the bar at x = 2400 with nothing on screen. It must come back by itself.
  await check('存下的条位置在窗口外时会被拉回可见范围', async () => {
    await page.evaluate(() => {
      const far = JSON.stringify({ x: window.innerWidth + 3000, y: window.innerHeight + 3000 });
      localStorage.setItem('spmod.autoPos', far);
      localStorage.setItem('spmod.speedPos', far);
      localStorage.setItem('spmod.fabPos', far);
    });
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2500);
    if ((await phase()) !== 'PREP') await waitPhase('PREP', 30000); // the seat reconnects into the same match
    await sleep(1200);
    const v = await page.evaluate(() => {
      const box = (sel) => {
        const e = document.querySelector(sel);
        if (!e || e.hasAttribute('hidden')) return null;
        const r = e.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), on: r.width > 0 && r.height > 0 && r.right > 0 && r.bottom > 0 && r.left < innerWidth && r.top < innerHeight };
      };
      return { auto: box('.spmod-auto'), speed: box('.spmod-speed'), fab: box('.spmod-fab') };
    });
    for (const [name, b] of Object.entries(v)) {
      assert.ok(b, `${name} 不在页面上`);
      assert.ok(b.on, `${name} 还在屏幕外：${JSON.stringify(b)}`);
    }
    const healed = await page.evaluate(() => JSON.parse(localStorage.getItem('spmod.autoPos')));
    assert.ok(healed.x <= await page.evaluate(() => window.innerWidth), `写回的位置仍是 ${JSON.stringify(healed)}`);
  });
  await check('「复位」把三条都放回默认位置', async () => {
    await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
    await sleep(900);
    await clickText('^复位$', '.spmod-sizebtn');
    await sleep(800);
    const left = await page.evaluate(() => ({
      auto: document.querySelector('.spmod-auto').style.left,
      speed: document.querySelector('.spmod-speed').style.left,
      fab: document.querySelector('.spmod-fab').style.left,
      ls: ['spmod.autoPos', 'spmod.speedPos', 'spmod.fabPos'].map((k) => localStorage.getItem(k)),
    }));
    assert.equal(left.auto, ''); assert.equal(left.speed, ''); assert.equal(left.fab, '');
    assert.deepEqual(left.ls, [null, null, null]);
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-diy-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  await stop();
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1200)}`);
if (process.exitCode == null) process.exitCode = fail ? 1 : 0;
process.exit(fail ? 1 : 0);
