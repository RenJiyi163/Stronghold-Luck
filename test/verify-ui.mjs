// verify-ui.mjs — drives the real browser UI (headless Chrome via the game's own e2e client) against the modded
// launcher: enters a solo match, reaches the first prep, uses the panel to swap a shop slot, and then repeats the
// run with the server patch disabled to prove the panel hides itself instead of breaking the game.
//
//   node test/verify-ui.mjs [--port 3198] [--chrome <path>]
//
// Needs puppeteer-core (npm i in this folder) and a Chrome/Edge binary.

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

const chromeArg = process.argv.indexOf('--chrome');
let chrome = null;
for (const c of [
  chromeArg >= 0 ? process.argv[chromeArg + 1] : null,
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
].filter(Boolean)) {
  if (await fsp.access(c).then(() => true, () => false)) { chrome = c; break; }
}
if (!chrome) {
  console.log('找不到 Chrome/Edge，跳过界面自检（用 CHROME_PATH 指定）');
  process.exit(0);
}
process.env.CHROME_PATH = chrome;

const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3198;
const base = `http://127.0.0.1:${port}`;

const require = createRequire(path.join(MOD_ROOT, 'package.json'));
const puppeteer = (await import(pathToFileURL(require.resolve('puppeteer-core')).href)).default;
const { Client } = await import(pathToFileURL(path.join(HERE, 'helpers', 'e2eClient.mjs')).href);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** An operator card, in either of the panel's two views (立绘 cards / 名字 rows). */
const CARD = '.spmod-card[data-id], .spmod-row[data-id]';
let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

function launch(extraArgs = []) {
  const child = spawn(process.execPath, [path.join(MOD_ROOT, 'src', 'launcher.mjs'), '--no-open', '--port', String(port), ...extraArgs], {
    cwd: MOD_ROOT, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const state = { child, out: '' };
  child.stdout.on('data', (d) => { state.out += d; });
  child.stderr.on('data', (d) => { state.out += d; });
  return state;
}
async function stop(srv) {
  try { srv.child.kill(); } catch { /* ignore */ }
  for (let i = 0; i < 60; i++) {
    try { await fetch(`${base}/healthz`); await sleep(200); } catch { return; }
  }
}
async function waitUp(srv) {
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(`${base}/healthz`)).ok) return; } catch { /* wait */ }
    await sleep(200);
  }
  throw new Error(`启动器没起来：\n${srv.out.slice(-1500)}`);
}

/** Title → 独立模拟/标准模拟 → start → briefing → draft → first PREP. */
async function toFirstPrep(c) {
  await c.open();
  await c.enter('杜宾');
  await c.click('.mode-card', '独立模拟');
  await c.click('.diff-card', '标准模拟');
  await c.click('.create-box button', '开始独立模拟');
  await c.waitFor((s) => !!s.room, 'solo room');
  if (!(await c.st()).phase) await c.click('.room-bar__right button', '开始模拟');
  await c.waitFor((s) => s.phase === 'INFO_CHECK', 'briefing', 30000);
  await c.click('.brief__foot .btn--primary', '准备就绪');
  await c.waitFor((s) => s.phase === 'BAND_DRAFT', 'band draft', 30000);
  await c.click('.dband', null, { nth: 1 });
  await c.click('.draft-detail__btns .btn--primary', '确认选择');
  await c.waitFor((s) => s.phase === 'PREP' && !s.ready, 'prep 1', 60000);
  await sleep(1200);
  return c;
}

console.log(`\nStronghold-Luck 界面自检 — ${chrome}\n`);

// ---- pass 1: the mod is on ----------------------------------------------------------------------------
const LOG_DIR = await fsp.mkdtemp(path.join(os.tmpdir(), 'luck-ui-'));
let srv = launch(['--log-dir', LOG_DIR]);
let solo = null;
try {
  await waitUp(srv);
  solo = await toFirstPrep(new Client(puppeteer, base, 'luck', { prefix: 'luck' }));

  console.log('[面板]');
  await check('自选按钮出现在对局里', () => solo.page.waitForSelector('.spmod-fab', { visible: true, timeout: 10000 }));
  await check('面板能打开并列出可选干员', async () => {
    await solo.click('.spmod-fab');
    await solo.page.waitForSelector('.spmod-panel', { visible: true, timeout: 5000 });
    const n = await solo.page.$$eval(CARD, (els) => els.length);
    assert.ok(n > 3, `只画出了 ${n} 个干员`);
  });
  await check('槽位页签数量与服务端一致', async () => {
    const tabs = await solo.page.$$eval('.spmod-tab', (els) => els.length);
    const want = await solo.page.evaluate(() => {
      const p = globalThis.__SP__.store.get().match.private.shop.modPickable;
      return p.chessSlots + p.itemSlots;
    });
    assert.equal(tabs, want, `页签 ${tabs} ≠ 槽位 ${want}`);
  });
  await check('点一张卡就把该槽位换成这名干员', async () => {
    const want = await solo.page.$$eval(CARD, (els) => els[1]?.getAttribute('data-id'));
    assert.ok(want, '没有可点的卡');
    await solo.click(`[data-id="${want}"]`);
    const ok = await solo.page.waitForFunction(
      (id) => globalThis.__SP__.store.get().match.private?.shop?.slots?.[0]?.id === id,
      { timeout: 5000 }, want,
    ).then(() => true, () => false);
    assert.ok(ok, '商店 0 号槽没有变成所选干员');
  });
  await solo.shot('panel-open');
  await check('原版商店栏照常渲染、面板无报错', async () => {
    const cards = await solo.page.$$eval('.scard', (els) => els.length);
    assert.ok(cards > 0, '商店栏是空的');
    const flash = await solo.page.$eval('.spmod-flash', (e) => ({ text: e.textContent, ok: e.classList.contains('is-ok') })).catch(() => ({ text: '', ok: true }));
    assert.ok(flash.ok, `面板报错：${flash.text}`);
  });
  await check('装备页签列出装备', async () => {
    const tabs = await solo.page.$$eval('.spmod-tab', (els) => els.length);
    await solo.click('.spmod-tab', null, { nth: tabs - 1 });
    await solo.page.waitForSelector('.spmod-grid--item button[data-id]', { timeout: 5000 });
    assert.ok((await solo.page.$$eval('.spmod-grid--item button[data-id]', (els) => els.length)) > 0, '装备页签没有内容');
    await solo.shot('panel-items');
  });
  await check('切到直购模式：点一张卡直接进手牌', async () => {
    const before = await solo.page.evaluate(() => {
      const p = globalThis.__SP__.store.get().match.private;
      return p.hand.filter(Boolean).length;
    });
    await solo.click('.spmod-tab', null, { nth: 0 });     // 回到干员页签
    // by name, not by position: the panel's page tabs (商店 / 沙盒 / 自选位 / 开关) are segbtns too, and they come
    // first in the document — an index would land on 沙盒 and take the whole shop page away with it.
    await solo.click('.spmod-segbtn', '直购');
    const id = await solo.page.$$eval(CARD, (els) => els[0]?.getAttribute('data-id'));
    assert.ok(id, '没有可点的卡');
    await solo.click(`[data-id="${id}"]`);
    const grown = await solo.page.waitForFunction(
      (n) => globalThis.__SP__.store.get().match.private.hand.filter(Boolean).length > n,
      { timeout: 5000 }, before,
    ).then(() => true, () => false);
    assert.ok(grown, '直购后手牌没有增加');
  });
  await check('面板显示本回合剩余次数', async () => {
    const text = await solo.page.$eval('.spmod-quota', (e) => e.textContent);
    assert.match(text, /本回合剩 \d+\/\d+|本回合不限/);
  });
  await check('改「每回合上限」即时生效', async () => {
    await solo.page.$eval('.spmod-limit', (el) => { el.value = '5'; el.dispatchEvent(new Event('change', { bubbles: true })); });
    const ok = await solo.page.waitForFunction(
      () => globalThis.__SP__.store.get().match.private?.shop?.modPickable?.quota?.limit === 5,
      { timeout: 5000 },
    ).then(() => true, () => false);
    assert.ok(ok, '上限没有变成 5');
  });
  await check('Esc 关闭面板', async () => {
    await solo.page.keyboard.press('Escape');
    await solo.page.waitForSelector('.spmod-panel', { hidden: true, timeout: 5000 });
  });

  console.log('\n[倍速]');
  await check('倍速条出现在对局里', () => solo.page.waitForSelector('.spmod-speed', { visible: true, timeout: 10000 }));
  await check('倍速条默认点亮服务端的 2×', async () => {
    const on = await solo.page.$$eval('.spmod-speedbtn.is-on', (els) => els.map((e) => e.textContent));
    assert.deepEqual(on, ['2×'], `点亮的是 ${on.join(',')}`);
  });
  await check('点 8× → 服务端倍速真的变成 8', async () => {
    const btns = await solo.page.$$('.spmod-speedbtn');
    assert.equal(btns.length, 4, `按钮数 ${btns.length}`);
    await btns[3].click(); // 1× 2× 4× 8×
    const ok = await solo.page.waitForFunction(
      () => globalThis.__SP__.store.get().match.private?.modSpeed === 8, { timeout: 5000 },
    ).then(() => true, () => false);
    assert.ok(ok, '服务端倍速没有变成 8');
  });
  await check('改回 2×（不影响继续玩）', async () => {
    const btns = await solo.page.$$('.spmod-speedbtn');
    await btns[1].click();
    const ok = await solo.page.waitForFunction(
      () => globalThis.__SP__.store.get().match.private?.modSpeed === 2, { timeout: 5000 },
    ).then(() => true, () => false);
    assert.ok(ok, '服务端倍速没有回到 2');
  });

  console.log('\n[自动买卖]');
  await check('自动买卖条出现在对局里', () => solo.page.waitForSelector('.spmod-auto', { visible: true, timeout: 10000 }));
  await check('默认是「启动」，且没点亮', async () => {
    const label = await solo.page.$eval('.spmod-autobtn', (e) => e.textContent);
    const lit = await solo.page.$eval('.spmod-autobtn', (e) => e.classList.contains('is-on'));
    assert.equal(label, '启动');
    assert.equal(lit, false);
  });
  await check('目标勾选表只列本局协议里有的卡（隐藏的红豆不在）', async () => {
    await solo.page.$eval('.spmod-autotarget', (e) => e.click());
    await solo.page.waitForSelector('.spmod-autotargetbox input[data-auto-id]', { visible: true, timeout: 5000 });
    const ids = await solo.page.$$eval('.spmod-autotargetbox input[data-auto-id]', (els) => els.map((e) => e.dataset.autoId));
    const pool = await solo.page.evaluate(() => globalThis.__SP__.store.get().match.private.shop.modPickable.pool);
    assert.ok(Array.isArray(pool) && pool.length > 0, 'privateView 没带 modPickable.pool');
    assert.ok(ids.length > 0, '勾选表是空的');
    assert.ok(ids.every((v) => pool.includes(v)), `勾选表里有本局没有的卡：${ids.filter((v) => !pool.includes(v))}`);
    assert.ok(!ids.includes('chess_char_1_05_a'), '红豆（visible:false）还在勾选表里');
    assert.equal(new Set(ids).size, ids.length, '勾选表里有重复项');
    await solo.page.$eval('.spmod-autotarget', (e) => e.click()); // fold it back up
  });
  await check('点启动 → 服务端记下这次请求（privateView 里有 modAuto）', async () => {
    await solo.page.$eval('.spmod-autobtn', (e) => e.click());
    const ok = await solo.page.waitForFunction(
      () => !!globalThis.__SP__.store.get().match.private?.modAuto, { timeout: 5000 },
    ).then(() => true, () => false);
    assert.ok(ok, 'privateView 里没有 modAuto');
  });
  await check('启动/停止是同一个键：再点一下就是停（没有另一个停止键）', async () => {
    assert.equal(await solo.page.$$eval('.spmod-auto button[data-auto="run"]', (els) => els.length), 1);
    // two clicks in one task: the first starts, the second stops — no batch answer can land in between
    await solo.page.$eval('.spmod-autobtn', (e) => { e.click(); e.click(); });
    const ok = await solo.page.waitForFunction(
      () => globalThis.__SP__.store.get().match.private?.modAuto?.on === false, { timeout: 5000 },
    ).then(() => true, () => false);
    assert.ok(ok, '服务端没收到停表');
    assert.equal(await solo.page.$eval('.spmod-autobtn', (e) => e.textContent), '启动');
  });
  await check('自动买卖条拖得动，位置记在浏览器里', async () => {
    const box = await solo.page.$eval('.spmod-auto', (e) => { const r = e.getBoundingClientRect(); return { x: r.left, y: r.top }; });
    await solo.page.mouse.move(box.x + 3, box.y + 3);
    await solo.page.mouse.down();
    await solo.page.mouse.move(box.x - 157, box.y + 43, { steps: 8 });
    await solo.page.mouse.up();
    const after = await solo.page.$eval('.spmod-auto', (e) => Math.round(e.getBoundingClientRect().left));
    const saved = await solo.page.evaluate(() => JSON.parse(localStorage.getItem('spmod.autoPos') || 'null'));
    assert.ok(after < Math.round(box.x) - 100, `条没被拖走：${Math.round(box.x)} → ${after}`);
    assert.ok(saved && Number.isFinite(saved.x) && Number.isFinite(saved.y), '拖动位置没写进 localStorage');
  });
  await check('倍速条没被自动倒转条污染（按钮仍是 4 个）', async () => {
    assert.equal(await solo.page.$$eval('.spmod-speedbtn', (els) => els.length), 4);
  });

  // The engine only shows 暂离（AI 托管）in co-op, but the intent works in solo too and is the one way to reach a
  // battle without hand-dragging every starter piece: the AI lays the board out and readies up.
  console.log('\n[战斗中改倍速]');
  await check('进入战斗（AI 托管替我们布阵、准备）', async () => {
    await solo.page.evaluate(() => { try { globalThis.__SP__.net.request('g.autoplay', { on: true }); } catch { /* ignore */ } });
    await solo.waitFor((s) => s.phase === 'COMBAT', 'combat', 90000);
    const live = await solo.page.waitForFunction(() => {
      const r = globalThis.__SP_RUNNER__;
      const st = r && r.state();
      if (!st || !st.battleId) return false;
      const e = r._entries.get(st.battleId);
      return !!(e && e.battle && !e.done && e.battle.tickCount > 60);
    }, { timeout: 30000 }).then(() => true, () => false);
    assert.ok(live, '浏览器里没有跑起来的战斗');
  });
  await check('战斗中切到 8×：游戏时钟不跳（没有跳到战斗结尾）', async () => {
    const snap = () => solo.page.evaluate(() => {
      const r = globalThis.__SP_RUNNER__;
      const e = r._entries.get(r.state().battleId);
      return { speed: e.speed, time: e.battle.time, ticks: e.battle.tickCount, at: performance.now() };
    });
    const before = await snap();
    assert.equal(before.speed, 2, `开打时应该是 2×，实际 ${before.speed}`);
    const btns = await solo.page.$$('.spmod-speedbtn');
    await btns[3].click(); // 8×
    const after = await snap();
    assert.equal(after.speed, 8, '正在跑的那场战斗没有跟着加速');
    // between the two reads the clock only advances at most the wall-clock gap × 8; a forced jump (the target tick
    // recomputed at 8× from the old origin) would be several times that — seconds of battle skipped in one frame
    const allowed = ((after.at - before.at) / 1000) * 8 + 0.6;
    const jumped = after.time - before.time;
    assert.ok(jumped >= 0 && jumped <= allowed, `游戏时钟跳了 ${jumped.toFixed(2)}s（允许 ${allowed.toFixed(2)}s）`);
  });
  await check('8× 下这场战斗照常跑完、回合继续推进', async () => {
    await solo.waitFor((s) => s.phase !== 'COMBAT', '这场战斗结束', 90000);
  });
  await check('结束后倍速条仍在，且没有任何报错', async () => {
    assert.equal(await solo.page.$$eval('.spmod-speedbtn.is-on', (els) => els.length), 1, '没有按钮处于选中态');
    const bad = solo.problems.filter((p) => !/favicon/.test(p));
    assert.deepEqual(bad.slice(0, 6), [], `${bad.length} 条问题`);
  });
  await solo.page.evaluate(() => { try { globalThis.__SP__.net.request('g.autoplay', { on: false }); } catch { /* ignore */ } });
  await solo.page.$$eval('.spmod-speedbtn', (els) => els[1]?.click()).catch(() => {}); // back to 2×
  await check('没有任何控制台错误 / 请求失败', () => {
    const bad = solo.problems.filter((p) => !/favicon/.test(p));
    assert.deepEqual(bad.slice(0, 6), [], `${bad.length} 条问题`);
  });
  await solo.shot('panel');
  console.log(`\n结果：${pass} 通过，${fail} 失败`);
  console.log(`截图：${solo.shots.join(' ')}\n`);
} catch (e) {
  fail++;
  console.log(`\n✗ 致命错误：${e.message}\n${srv.out.slice(-1500)}\n`);
} finally {
  try { await solo?.close(); } catch { /* ignore */ }
  await stop(srv);
}

// ---- pass 2: server patch off → the panel must hide itself ---------------------------------------------
console.log('[补丁失效时应当无害]');
let solo2 = null;
srv = launch(['--no-patch']);
try {
  await waitUp(srv);
  solo2 = await toFirstPrep(new Client(puppeteer, base, 'vanilla', { prefix: 'luck-nopatch' }));
  await check('服务端未打补丁时，整个面板自己隐藏（不报错、不挡操作）', async () => {
    await sleep(1500);
    const shown = await solo2.page.evaluate(() => {
      const node = document.querySelector('.spmod');
      if (!node) return 'absent';
      return getComputedStyle(node).display === 'none' ? 'hidden' : 'shown';
    });
    assert.equal(shown, 'hidden', `面板状态：${shown}`);
  });
  await check('补丁失效时倍速条也自己隐藏', async () => {
    await sleep(1500);
    const shown = await solo2.page.evaluate(() => {
      const node = document.querySelector('.spmod-speed');
      return node ? (node.hidden ? 'hidden' : 'shown') : 'absent';
    });
    assert.equal(shown, 'hidden', `倍速条状态：${shown}`);
  });
  await check('补丁失效时自动倒转条也自己隐藏', async () => {
    const shown = await solo2.page.evaluate(() => {
      const node = document.querySelector('.spmod-auto');
      return node ? (node.hidden ? 'hidden' : 'shown') : 'absent';
    });
    assert.equal(shown, 'hidden', `自动倒转条状态：${shown}`);
  });
  await check('此时游戏本身照常可用（商店栏在）', async () => {
    assert.ok((await solo2.page.$$eval('.scard', (els) => els.length)) > 0);
  });
  await check('浏览器这边依然没有报错', () => {
    const bad = solo2.problems.filter((p) => !/favicon/.test(p));
    assert.deepEqual(bad.slice(0, 6), [], `${bad.length} 条问题`);
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 致命错误：${e.message}\n${srv.out.slice(-1200)}`);
} finally {
  try { await solo2?.close(); } catch { /* ignore */ }
  await stop(srv);
}

console.log(`\n总计：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
