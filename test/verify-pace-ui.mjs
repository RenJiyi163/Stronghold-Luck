// verify-pace-ui.mjs — two shop/pacing behaviours through the real browser.
//
//   node test/verify-pace-ui.mjs [--port 3198] [--chrome <path>]
//
//   额度   装备不占每回合次数：limit = 1 时，买一件装备照常成功且计数不动，再买第二张干员才被拒（MOD_LIMIT）。
//   过场   the fixed 结算 / 回合开始 waits do not follow the battle speed by the game's own design — this mod shortens
//          them in a solo match. Measured on the wire: the span from the last COMBAT to the end of SETTLE is the game's
//          1.5 s (战斗结束) + 3 s (结算) at 2×, and a quarter of that at 8×.
//
// Self-contained: the game's release package ships no `test/`, so this drives the page itself.

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
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3198;
const chromeArg = process.argv.indexOf('--chrome');
const CHROME = chromeArg >= 0 ? process.argv[chromeArg + 1] : 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
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
page.on('console', (m) => { const t = m.text(); if (/\[luck\]/.test(t)) console.log('  [page]', t); });
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

const phase = () => page.evaluate(() => globalThis.__SP__.store.get().match?.public?.phase ?? null);
const priv = () => page.evaluate(() => globalThis.__SP__.store.get().match?.private ?? null);
const req = (t, f) => page.evaluate((tt, ff) => globalThis.__SP__.net.request(tt, ff).then(() => 'ok', (e) => String(e?.detail || e?.code || e)), t, f);
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
  while (Date.now() - t0 < ms) { if ((await phase()) === p) return true; await sleep(250); }
  return false;
};

console.log(`\nStronghold-Luck 额度 / 过场自检 — ${gameRoot}\n`);

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
  await page.evaluate(() => { (document.querySelector('.dband') || {})?.click?.(); });
  await sleep(600);
  await clickText('确认选择');
  assert.ok(await waitPhase('PREP', 60000), '没进到第一个休整期');
  await sleep(1200);

  // ---- 额度只算干员 -----------------------------------------------------------------------------------
  console.log('[额度]');
  const pool = await page.evaluate(() => {
    const p = globalThis.__SP__.store.get().match.private;
    const pk = p.shop.modPickable;
    return { chess: pk.chess.slice(0, 2), item: pk.item.slice(0, 1), chessSlots: pk.chessSlots, itemSlots: pk.itemSlots };
  });
  await check('本局拿得到两个干员和一个装备（前置）', () => {
    assert.ok(pool.chess.length >= 2, `在售干员只有 ${pool.chess.length} 个`);
    assert.ok(pool.item.length >= 1, '在售装备为 0（换一局/换一张图再试）');
    assert.ok(pool.itemSlots >= 1, `装备槽位 ${pool.itemSlots} 个`);
  });

  await check('额度设成 1 之后：第一张干员占掉它', async () => {
    assert.equal(await req('g.modConfig', { pickLimit: 1 }), 'ok');
    await sleep(500);
    assert.equal(await req('g.modPick', { slot: 0, id: pool.chess[0] }), 'ok', '第一张干员放不进槽位');
    await sleep(700);
    const q = (await priv()).shop.modPickable.quota;
    assert.equal(q.limit, 1);
    assert.equal(q.used, 1, `计数是 ${q.used}`);
  });

  await check('装备照样放得进槽位，且计数不动（这一条就是作者要的）', async () => {
    const itemSlot = pool.chessSlots;
    const r = await req('g.modPick', { slot: itemSlot, id: pool.item[0] });
    assert.equal(r, 'ok', `装备被拒了：${r}`);
    await sleep(700);
    const q = (await priv()).shop.modPickable.quota;
    assert.equal(q.used, 1, `装备也占了额度：used = ${q.used}`);
  });

  await check('装备直购也不算额度', async () => {
    const before = (await priv()).shop.modPickable.quota.used;
    const r = await req('g.modBuy', { id: pool.item[0] });
    assert.equal(r, 'ok', `装备直购被拒了：${r}`);
    await sleep(700);
    assert.equal((await priv()).shop.modPickable.quota.used, before, '直购装备也占了额度');
  });

  await check('额度用完后，第二张干员被拒（阴性对照）', async () => {
    const r = await req('g.modPick', { slot: 1, id: pool.chess[1] });
    assert.notEqual(r, 'ok', '额度用完了还放得进第二张干员');
    assert.ok(/次数/.test(r), `被拒的理由不是额度：${r}`);
  });

  // ---- 过场等待跟倍速 ---------------------------------------------------------------------------------
  console.log('\n[过场]');
  // A phase recorder in the page: 30 ms polling is plenty to tell 4.5 s from 1.1 s.
  await page.evaluate(() => {
    const log = [];
    globalThis.__PHASE_LOG__ = log;
    let last = null;
    globalThis.__PHASE_TIMER__ = setInterval(() => {
      const p = globalThis.__SP__.store.get().match?.public?.phase ?? null;
      if (p === last) return;
      last = p;
      log.push({ p, t: performance.now() });
    }, 30);
  });
  /**
   * How long the SETTLE phase lasted — the game's DELAYS.SETTLE (3000 ms) shortened by the speed in a solo match. The
   * 战斗结束 wait (DELAYS.COMBAT_END) has no phase of its own: the client sits in COMBAT through it, so this is the
   * observable one. (The whole battle also sits in COMBAT, which is why the COMBAT→SETTLE span is useless here.)
   */
  const settleMs = async () => {
    const log = await page.evaluate(() => globalThis.__PHASE_LOG__);
    let s = -1;
    for (let i = 0; i < log.length; i++) if (log[i].p === 'SETTLE') s = i;
    if (s < 0 || s === log.length - 1) return null; // never entered, or still running
    return log[s + 1].t - log[s].t;
  };
  /**
   * Press through the ready-up. Returns only once the phase has actually LEFT prep — `waitPhase('PREP')` returns true at
   * once while still in prep, which would make the whole measurement a no-op.
   */
  const readyUp = async () => {
    await page.keyboard.press('Escape');
    await sleep(400);
    await clickText('准备就绪', '.readybtn');
    await sleep(700);
    await clickText('^准备就绪', 'button:not(.readybtn)'); // the confirm dialog's button, when funds are left
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      if ((await phase()) !== 'PREP') return true;
      await sleep(200);
    }
    const btns = await page.evaluate(() => [...document.querySelectorAll('button')].filter((e) => e.offsetParent)
      .map((e) => `${e.className}|${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 12)}`).slice(0, 10));
    console.log('      [diag] 按了准备就绪但还停在 PREP，屏幕上的按钮:', JSON.stringify(btns));
    return false;
  };

  /**
   * Ready up and play this round out far enough to time the 结算 phase, then report it.
   *
   * Deliberately stops at the END of 结算 instead of waiting for the next 休整期: a round can go 结算 → 机变阶段, and in
   * solo 机变 has no clock (it waits for the player to pick a card), so waiting for PREP would hang there. Nothing after
   * the settle matters to the measurement.
   */
  const playRound = async (label) => {
    await page.evaluate(() => { globalThis.__PHASE_LOG__.length = 0; });
    if (!await readyUp()) {
      console.log(`      [diag] ${label}：按了准备就绪但没离开休整期`);
      return null;
    }
    const t0 = Date.now();
    let ms = null;
    while (Date.now() - t0 < 150000) {
      ms = await settleMs();
      if (ms != null) break;
      // if the round is over and no settle was ever published, stop early instead of burning the whole budget
      if (await phase() === null) break;
      await sleep(120);
    }
    if (ms == null) {
      console.log(`      [diag] ${label} 阶段序列:`,
        JSON.stringify(await page.evaluate(() => globalThis.__PHASE_LOG__)).slice(0, 400));
    }
    return ms;
  };

  // 2× first: the game's own pacing, which the mod must leave alone.
  await check('2× 时：结算还是游戏原本的 3 秒', async () => {
    const pace = (await priv()).modPace;
    assert.ok(pace, '服务端没回 modPace');
    assert.equal(pace.solo, true, '这一局不是单人局？');
    assert.equal(pace.delayScale, 1, `2× 下 delayScale = ${pace.delayScale}`);
    const ms = await playRound('2×');
    assert.ok(ms != null, '这一轮没录到结算阶段');
    console.log(`      2× 结算时长：${Math.round(ms)} ms`);
    assert.ok(ms > 2200, `只有 ${Math.round(ms)} ms，比游戏自己的 3 s 还短？`);
    // the next round has to start from 休整期 (机变阶段 would need a hand-picked card)
    assert.ok(await waitPhase('PREP', 60000), '这一轮过完没回到休整期，8× 那一轮起不来');
    await sleep(1200);
  });

  await check('8× 时：同一段结算被缩短到约四分之一', async () => {
    assert.equal(await req('g.modSpeed', { n: 8 }), 'ok');
    await sleep(900);
    const pace = (await priv()).modPace;
    assert.equal(pace.delayScale, 0.25, `8× 下 delayScale = ${pace.delayScale}`);
    const ms = await playRound('8×');
    assert.ok(ms != null, '这一轮没录到结算阶段');
    console.log(`      8× 结算时长：${Math.round(ms)} ms`);
    assert.ok(ms < 1300, `${Math.round(ms)} ms —— 结算没跟着倍速缩短`);
    await sleep(1200);
  });

  await check('面板上那条倍速条把这件事显示出来了', async () => {
    const txt = await page.evaluate(() => document.querySelector('.spmod-speed')?.textContent || '');
    assert.ok(/过场\s*×0\.25/.test(txt), `倍速条上没写：${JSON.stringify(txt)}`);
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-pace-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1500)}`);
process.exit(fail ? 1 : 0);
