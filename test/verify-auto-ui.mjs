// verify-auto-ui.mjs — 自动买卖的目标勾选表 (the panel half of g.modAuto) through the real browser.
//
//   node test/verify-auto-ui.mjs [--port 3198] [--chrome <path>]
//
// Boots the modded launcher, plays into the first PREP of a solo ABYSS match, then drives the bar itself:
//
//   目录   勾选表只列本局协议里有的卡（红豆这类 visible:false 的从不下手）；
//   默认   当期与下期预先勾上，道具类留空；
//   计数   勾/取消都立刻反映到「目标 N/M」上，并写进 localStorage；
//   空集   全不勾时启动键锁住（不发一批空请求出去）；
//   服务端 点启动之后，服务端记下的 cardIds 就是勾选的那几张（多张共用同一个循环）。
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
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3198;
const chromeArg = process.argv.indexOf('--chrome');
const CHROME = chromeArg >= 0 ? process.argv[chromeArg + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const base = `http://127.0.0.1:${port}`;

const { AUTO_CARDS, AUTO_DEFAULT_IDS } = await import(pathToFileURL(path.join(MOD_ROOT, 'public', 'auto-rules.js')).href);
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
page.on('console', (m) => { const t = m.text(); if (/\[luck\]/.test(t)) console.log('  [page]', t); });
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

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

const tapTargets = () => page.$eval('.spmod-autotarget', (e) => e.click());
const openBox = async () => {
  if (!(await page.$('.spmod-autotargetbox input[data-auto-id]'))) await tapTargets();
  await page.waitForSelector('.spmod-autotargetbox input[data-auto-id]', { visible: true, timeout: 5000 });
};
const offered = () => page.$$eval('.spmod-autotargetbox input[data-auto-id]', (els) => els.map((e) => e.dataset.autoId));
const enabledIds = () => page.$$eval('.spmod-autotargetbox input[data-auto-id]', (els) => els.filter((e) => !e.disabled).map((e) => e.dataset.autoId));
const checkedIds = () => page.$$eval('.spmod-autotargetbox input[data-auto-id]', (els) => els.filter((e) => e.checked).map((e) => e.dataset.autoId));
const tick = (id, on) => page.$eval(`.spmod-autotargetbox input[data-auto-id="${id}"]`, (e, v) => { if (e.checked !== v) e.click(); }, on);
const btnLabel = () => page.$eval('.spmod-autotarget', (e) => e.textContent);
const savedTicks = () => page.evaluate(() => JSON.parse(localStorage.getItem('spmod.auto') || '{}').cardIds);

console.log(`\nStronghold-Luck 自动买卖勾选自检 — ${gameRoot}\n`);

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
  await clickText('开始模拟');
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

  await check('条在，目标按钮读出「目标 N/M」', async () => {
    await page.waitForSelector('.spmod-autotarget', { visible: true, timeout: 10000 });
    assert.match(await btnLabel(), /^目标 \d+\/\d+$/, `按钮文案是「${await btnLabel()}」`);
  });

  await check('勾选表只列本局协议里有的卡（隐藏的红豆不在）', async () => {
    await openBox();
    const ids = await offered();
    const pool = await page.evaluate(() => globalThis.__SP__.store.get().match.private.shop.modPickable.pool);
    assert.ok(Array.isArray(pool) && pool.length > 0, 'privateView 没带 modPickable.pool');
    assert.ok(ids.length > 0, '勾选表是空的');
    assert.ok(ids.every((v) => pool.includes(v)), `勾选表里有本局没有的卡：${ids.filter((v) => !pool.includes(v))}`);
    assert.ok(!ids.includes('chess_char_1_05_a'), '红豆（visible:false）还在勾选表里');
    assert.equal(new Set(ids).size, ids.length, '勾选表里有重复项');
  });

  await check('默认勾上当期与下期，道具类留空', async () => {
    await openBox();
    const itemIds = new Set(AUTO_CARDS.filter((c) => c.cls === 'item').map((c) => c.id));
    const want = new Set(AUTO_DEFAULT_IDS);
    const got = await checkedIds();
    assert.ok(got.length > 0, '一张都没勾上');
    for (const id of got) {
      assert.ok(!itemIds.has(id), `${AUTO_CARDS.find((c) => c.id === id)?.name}（道具类）默认被勾上了`);
      assert.ok(want.has(id), `${id} 不在默认勾选里`);
    }
  });

  await check('取消 / 重新勾选：计数跟着变，并写进 localStorage', async () => {
    await openBox();
    const before = await checkedIds();
    assert.ok(before.length > 0, '这一局一张都没勾上');
    const id = before[0];
    await tick(id, false);
    await sleep(300);
    const off = await checkedIds();
    assert.equal(off.length, before.length - 1, `取消 ${id} 计数没变：${before.length} → ${off.length}`);
    assert.ok(!off.includes(id), `${id} 还是勾着的`);
    assert.ok(!(await savedTicks())?.includes(id), 'localStorage 里没记下这次取消');
    assert.match(await btnLabel(), new RegExp(`^目标 ${off.length}/`), `按钮没跟上：${await btnLabel()}`);
    await tick(id, true);
    await sleep(300);
    const back = await checkedIds();
    assert.ok(back.includes(id), `${id} 勾不回来`);
    assert.ok((await savedTicks())?.includes(id), 'localStorage 里没记下重新勾选');
  });

  await check('全不勾：启动键锁住，不发出空请求', async () => {
    await openBox();
    const on = await checkedIds();
    for (const id of on) await tick(id, false);
    await sleep(400);
    assert.equal((await checkedIds()).length, 0, '还有没取消的');
    assert.equal(await page.$eval('.spmod-autobtn', (e) => e.disabled), true, '一张不勾时启动键还能按');
    assert.match(await btnLabel(), /^目标 0\//, `按钮文案是「${await btnLabel()}」`);
  });

  await check('勾几张点启动：服务端记下的 cardIds 就是勾选的那几张', async () => {
    await openBox();
    const pick = (await enabledIds()).slice(0, 2);
    assert.ok(pick.length >= 1, '这一局没有可勾的卡');
    for (const id of pick) await tick(id, true);
    await sleep(400);
    assert.equal(await page.$eval('.spmod-autobtn', (e) => e.disabled), false, '有勾选时启动键还是锁的');
    await page.$eval('.spmod-autobtn', (e) => e.click());
    const ok = await page.waitForFunction(
      (want) => {
        const a = globalThis.__SP__.store.get().match.private?.modAuto;
        return !!a && Array.isArray(a.cardIds) && a.cardIds.length === want;
      }, { timeout: 8000 }, pick.length,
    ).then(() => true, () => false);
    assert.ok(ok, '服务端没记下多目标的一次批次');
    const got = await page.evaluate(() => globalThis.__SP__.store.get().match.private.modAuto.cardIds);
    assert.deepEqual([...got].sort(), [...pick].sort(), `服务端收到的是 ${got}，勾的是 ${pick}`);
    // 条右边报出这一批跑的是哪一套刷法（免费刷 / 收费刷），作者要能一眼看出奇迹满没满一百
    assert.match(await page.$eval('.spmod-autolabel[data-auto="tally"]', (e) => e.textContent), /(免费刷|收费刷)/, 'tally 里没有刷法');
    // stop it again so the page is left quiet
    await page.$eval('.spmod-autobtn', (e) => e.click());
    await sleep(500);
  });
} finally {
  await browser.close().catch(() => {});
  child.kill();
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) { console.log('\n--- launcher 输出 ---\n' + out.slice(-2000)); }
process.exit(fail ? 1 : 0);
