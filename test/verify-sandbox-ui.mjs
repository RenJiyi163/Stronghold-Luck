// verify-sandbox-ui.mjs — the sandbox (extra 策略 + the deploy unlock) through the real browser.
//
//   node test/verify-sandbox-ui.mjs [--port 3196] [--chrome <path>]
//
// Boots the modded launcher, plays into the first PREP of a solo ABYSS match and checks, through the panel and over the
// game's own socket:
//
//   策略  叠一个额外策略 → the seat's `modBands` carries it, its own band handler runs, and the starting LP becomes the
//         biggest of the picks;
//   地块  a tile the stage's own legend refuses stays refused while the unlock is off (negative control), is placeable
//         once it is on, and survives the round change (the game's `_evictIllegal` consults the same widened map);
//         turning the unlock off pulls the piece back to the hand.
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
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3196;
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
const pageLog = [];
page.on('pageerror', (e) => console.log('  [page error]', e.message));
page.on('console', (m) => { const t = m.text(); if (/\[luck\]/.test(t)) { pageLog.push(t); console.log('  [page]', t); } });
await page.goto(base, { waitUntil: 'networkidle2', timeout: 30000 });
await sleep(2500);

const phase = () => page.evaluate(() => globalThis.__SP__.store.get().match?.public?.phase ?? null);
const priv = () => page.evaluate(() => globalThis.__SP__.store.get().match?.private ?? null);
const send = (t, f) => page.evaluate((tt, ff) => globalThis.__SP__.net.request(tt, ff).then(() => 'ok', (e) => String(e?.detail || e?.code || e)), t, f);
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

console.log(`\nStronghold-Luck 沙盒自检 — ${gameRoot}\n`);

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
  // draft the LOWEST 初始 LP strategy on the table, so the extra strategies' LP rule has something to beat
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

  // ---- 策略 ------------------------------------------------------------------------------------------
  console.log('[沙盒 · 策略]');
  await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
  await sleep(1000);
  // The probing piece: a MELEE one that is actually in this match's pool (a 本局禁用 chess is not buyable at all), and
  // preferably 谢拉格 — that is what 休露丝's price cap names.
  const picks = await page.evaluate(() => {
    const S = globalThis.__SP__;
    const cards = [...document.querySelectorAll('.spmod-row[data-id]')].map((e) => {
      const rec = S.data.lookup('chess', e.getAttribute('data-id'));
      return { id: e.getAttribute('data-id'), name: rec?.name, pos: rec?.position, price: rec?.price, bonds: rec?.bonds || [] };
    });
    const kj = cards.find((c) => c.pos === 'MELEE' && c.bonds.includes('kjeragShip') && (c.price ?? 9) >= 2);
    const melee = kj || cards.find((c) => c.pos === 'MELEE' && (c.price ?? 9) <= 2);
    return { kj: kj || null, melee: melee || null, n: cards.length };
  });
  await check('面板上有「沙盒」页，能列出本局允许的策略', async () => {
    assert.ok(await clickText('^沙盒$', '.spmod-segbtn'), '没有沙盒页签');
    await sleep(900);
    const n = await page.$$eval('.spmod-band', (els) => els.length);
    assert.ok(n > 10, `只列出 ${n} 个策略`);
  });
  // Extras: the biggest 初始 LP on the table (for the LP rule) and 休露丝. 休露丝 is also the proof that the extra
  // strategies' handlers really run: its onPrice caps the first 谢拉格 purchase of the round at 1 gold, which shows up
  // in the funds right away — no dependence on what the match happened to ban, unlike most strategy effects.
  const want = await page.evaluate(() => {
    const mine = globalThis.__SP__.store.get().match.private;
    const pool = mine.modSandbox?.pool || [];
    const lp = (id) => Number(globalThis.__SP__.data.lookup('bands', id)?.totalHp) || 0;
    const rows = [...document.querySelectorAll('.spmod-band[data-band]')]
      .map((e) => e.getAttribute('data-band'))
      .filter((id) => id !== mine.bandId);
    const byLp = [...rows].sort((a, b) => lp(b) - lp(a));
    return {
      big: byLp[0] || null, bigLp: lp(byLp[0] || ''),
      primaryLp: lp(mine.bandId),
      sciurus: pool.includes('band_sciurus') ? 'band_sciurus' : null,
    };
  });
  const buy = (id) => page.evaluate((x) => globalThis.__SP__.net.request('g.modBuy', { id: x })
    .then(() => 'ok', (e) => String(e?.detail || e?.code || e)), id);
  await check('这一局的候选里有能买的近战（用来试放置）', () => {
    assert.ok(picks.melee, `候选 ${picks.n} 名，但没有可买的近战`);
  });
  await check('先按原价买一名近战（对照价）', async () => {
    const before = (await priv()).funds;
    const res = await buy(picks.melee.id);
    assert.equal(res, 'ok', `直购失败：${res}`);
    const after = (await priv()).funds;
    if (!picks.kj) { console.log('      （本局没有可买的谢拉格近战，只看能不能买）'); return; }
    assert.equal(after, before - (picks.kj.price ?? 2), `资金 ${before} → ${after}，期望按原价 ${picks.kj.price}`);
  });
  await check('叠两个额外策略：服务端收下，起手 LP 取最大的那个', async () => {
    assert.ok(want.big, '没有可叠的策略');
    const ids = want.sciurus && want.sciurus !== want.big ? [want.big, want.sciurus] : [want.big];
    await page.evaluate((list) => {
      for (const id of list) document.querySelector(`.spmod-band[data-band="${id}"]`)?.click();
    }, ids);
    await sleep(2000);
    const now = await priv();
    assert.deepEqual([...now.modSandbox.bands].sort(), [...ids].sort(), `服务端收到的是 ${JSON.stringify(now.modSandbox.bands)}`);
    const expect = Math.max(want.bigLp, want.primaryLp);
    assert.equal(now.lp, expect, `LP 是 ${now.lp}，期望 max(${want.bigLp}, ${want.primaryLp}) = ${expect}`);
  });
  await check('额外策略的效果真的跑到：休露丝把谢拉格的首购价压到 1', async () => {
    const before = (await priv()).funds;
    const res = await buy(picks.melee.id); // 同一名再买一次：既是价格对照的第二次，也凑出第二枚棋子
    assert.equal(res, 'ok', `第二次直购失败：${res}`);
    const after = (await priv()).funds;
    if (!want.sciurus || !picks.kj) { console.log('      （本局没有休露丝或谢拉格近战，这次只当备第二枚棋子）'); return; }
    assert.equal(after, before - 1, `资金 ${before} → ${after}，期望 1 金（叠了休露丝）`);
  });
  // 战斗侧（那 11 个「叠了等于没叠」的策略）：它们的实现在 bands/battle.js install()，叠上之后要在开战时真的装进去。
  // 用一支纯战斗策略来验：陈（以己之长，注册一个 hit 钩子），装上后一场战斗的日志里必须出现安装记录。
  let combatPicked = null;
  const COMBAT_ONLY = ['band_chen', 'band_qalaisa', 'band_ermengard', 'band_clementia', 'band_emperor', 'band_mberry', 'band_humus', 'band_ioleta', 'band_amiya', 'band_sarkazb', 'band_amedic'];
  await check('叠一支纯战斗策略（战斗侧那 11 支之一）', async () => {
    const id = COMBAT_ONLY.find((x) => want.poolIds?.includes(x));
    const pick = await page.evaluate((list) => {
      const pool = globalThis.__SP__.store.get().match.private.modSandbox?.pool || [];
      const id2 = list.find((x) => pool.includes(x)) || null;
      if (id2) document.querySelector(`.spmod-band[data-band="${id2}"]`)?.click();
      return id2;
    }, COMBAT_ONLY);
    void id;
    if (!pick) { console.log('      （本局池子里没有纯战斗策略，跳过）'); return; }
    combatPicked = pick;
    await sleep(1600);
    const now = await priv();
    assert.ok(now.modSandbox.bands.includes(pick), `服务端没收下 ${pick}`);
  });
  // 上限：那 8 是外挂自己拍的常量，引擎对 ps.modBands 没有数量限制。勾到 12 个，服务端要一个不少地收下。
  await check('放开上限：一次勾到 9 个以上策略，服务端全部收下（不再卡在 8）', async () => {
    const clicked = await page.evaluate(() => {
      const primary = globalThis.__SP__.store.get().match.private.bandId;
      const cand = [...document.querySelectorAll('.spmod-band[data-band]')]
        .map((e) => e.getAttribute('data-band'))
        .filter((id) => id && id !== primary);
      const onCount = () => document.querySelectorAll('.spmod-band.is-on').length;
      for (const id of cand) {
        if (onCount() >= 12) break;
        const el = document.querySelector(`.spmod-band[data-band="${id}"]`);
        if (el && !el.classList.contains('is-on')) el.click();
      }
      return onCount();
    });
    await sleep(2500);
    const n = ((await priv()).modSandbox.bands || []).length;
    assert.ok(n > 8, `面板上 ${clicked} 个在亮，服务端只收下 ${n} 个额外策略`);
    console.log(`      （面板上 ${clicked} 个在亮，服务端记下 ${n} 个额外策略）`);
  });

  // ---- 地块 ------------------------------------------------------------------------------------------
  console.log('\n[沙盒 · 地块]');
  // Two tiles of the own board region, straight from the stage's own legend: one that no unit may deploy on (LOW and
  // unbuildable), and one that is 高台 (HIGH) — a melee unit may not stand there whatever its buildable flag is.
  const setup = await page.evaluate((meleeId) => {
    const S = globalThis.__SP__;
    const m = S.store.get().match;
    const stage = S.data.lookup('stages', m.public.stageId);
    const rows = Array.isArray(stage?.rows) ? stage.rows : [];
    const legend = stage && typeof stage.tiles === 'object' ? stage.tiles : {};
    const at = (r, c) => { const g = (rows[r] || '')[c]; return g != null ? legend[g] || null : null; };
    let target = null;
    let high = null;
    for (let r = 9; r <= 12; r++) {
      for (let c = 2; c <= 10; c++) {
        const t = at(r, c);
        if (!t) continue;
        if (!target && t.height === 'LOW' && t.buildable === 'NONE') target = [r, c];
        if (!high && t.height === 'HIGH') high = [r, c];
      }
    }
    const hand = (m.private.hand || []).filter(Boolean);
    return { target, high, uids: hand.map((h) => h.uid), ids: hand.map((h) => h.id), meleePos: S.data.lookup('chess', meleeId)?.position || null };
  }, picks.melee.id);
  await check('手上有两名干员可用（复用了前面按价买的那两名）', () => {
    assert.ok(setup.uids.length >= 2, `手牌只有 ${setup.uids.length} 名`);
    assert.equal(setup.meleePos, 'MELEE', `挑中的 ${picks.melee.name} 不是近战（${setup.meleePos}）`);
  });
  await check('拿到一块原本不能部署的格子，和一块高台（近战默认上不去）', () => {
    assert.ok(setup.target, '这张图没有「平地但不可部署」的格子，换一张再试');
    assert.ok(setup.high, '这张图没有高台，换一张再试');
  });
  const move = (uid, [r, c]) => page.evaluate((u, rr, cc) => globalThis.__SP__.net.request('g.move', { uid: u, to: { area: 'board', row: rr, col: cc, dir: 'RIGHT' }, dir: 'RIGHT' })
    .then(() => 'ok', (e) => String(e?.detail || e?.code || e)), uid, r, c);
  await check('解锁关着：那块格子被拒（阴性对照）', async () => {
    assert.equal(await send('g.modPlace', { on: false, cap: null }), 'ok');
    await sleep(800);
    const r = await move(setup.uids[0], setup.target);
    assert.notEqual(r, 'ok', `居然放上去了：${r}`);
  });
  await check('解锁关着：近战上不了高台（阴性对照）', async () => {
    const r = await move(setup.uids[1], setup.high);
    assert.notEqual(r, 'ok', `近战居然直接站上高台了：${r}`);
  });
  await check('解锁打开：面板勾一下，服务端就认了', async () => {
    await page.evaluate(() => { const b = document.querySelector('.spmod-sbrow input[type=checkbox]'); if (b && !b.checked) b.click(); });
    await sleep(1500);
    const now = await priv();
    assert.equal(now.modSandbox.place, true, '服务端没打开解锁');
  });
  await check('浏览器自己那份 map 也放开了（拖放镜像）', async () => {
    const st = await page.evaluate(() => {
      const s = globalThis.__SP__.data.lookup('stages', globalThis.__SP__.store.get().match.public.stageId);
      const glyphs = Object.values(s?.tiles || {});
      return {
        all: glyphs.length > 0 && glyphs.every((t) => t?.buildable === 'ALL'),
        deployTiles: s && 'deployTiles' in s ? String(s.deployTiles) : 'missing',
      };
    });
    assert.equal(st.all, true, 'legend 没被改成 ALL');
    assert.equal(st.deployTiles, 'null', 'deployTiles 没被清掉（客户端仍会用它）');
  });
  await check('解锁后就能放到那块格子上了', async () => {
    const r = await move(setup.uids[0], setup.target);
    assert.equal(r, 'ok', `还是被拒：${r}`);
    const p = await priv();
    const on = (p.board || []).some((x) => x && x.row === setup.target[0] && x.col === setup.target[1]);
    assert.ok(on, '服务端棋盘上没有这枚棋子');
  });
  await check('解锁后近战也能上高台了', async () => {
    const r = await move(setup.uids[1], setup.high);
    assert.equal(r, 'ok', `近战还是上不去高台：${r}`);
    const p = await priv();
    const on = (p.board || []).some((x) => x && x.row === setup.high[0] && x.col === setup.high[1]);
    assert.ok(on, '近战没站在高台上');
  });
  await check('回合切换后不被撤回（_evictIllegal 走的是同一张 map）', async () => {
    // 面板开着时它的遮罩会吃掉鼠标点击（.spmod.is-open::before 是 pointer-events:auto），先关掉
    await page.keyboard.press('Escape');
    await sleep(500);
    assert.equal(await page.evaluate(() => !!document.querySelector('.spmod.is-open')), false, '面板没关掉');
    await clickText('准备就绪', '.readybtn');
    // 还有资金时会先弹一次确认：它的 okText 也叫「准备就绪」，所以排除下面那颗按钮（要真鼠标点，preact 的按钮不一定吃 .click()）
    await sleep(700);
    await clickText('^准备就绪', 'button:not(.readybtn)');
    const t0 = Date.now();
    let left = false;
    while (Date.now() - t0 < 60000) { if ((await phase()) !== 'PREP') { left = true; break; } await sleep(300); }
    if (!left) {
      const btns = await page.evaluate(() => [...document.querySelectorAll('button')].filter((e) => e.offsetParent)
        .map((e) => `${e.className}|${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 14)}`).slice(0, 12));
      console.log('      [diag] 屏幕上的按钮:', JSON.stringify(btns));
      console.log('      [diag] ready=', JSON.stringify(await page.evaluate(() => globalThis.__SP__.store.get().match.private.ready)));
    }
    assert.ok(left, '按了准备就绪但休整期没结束（确认弹窗没点掉？）');
    assert.ok(await waitPhase('PREP', 120000), '没回到休整期');
    await sleep(1500);
    const p = await priv();
    const at = (t) => (p.board || []).some((x) => x && x.row === t[0] && x.col === t[1]);
    assert.ok(at(setup.target), `第 ${p.round} 回合，放在非法地块上的被撤回了`);
    assert.ok(at(setup.high), `第 ${p.round} 回合，站在高台上的近战被撤回了`);
  });
  await check('战斗侧策略真的装进了这一场战斗（模拟里那一半）', async () => {
    const hit = pageLog.filter((t) => /battle-side extra strategies installed/.test(t));
    if (!combatPicked) { console.log('      （没叠纯战斗策略，跳过）'); return; }
    if (!hit.length) {
      const diag = await page.evaluate(() => {
        const runner = globalThis.__SP_RUNNER__;
        const entries = runner?._entries ? [...runner._entries.values()] : [];
        return { entries: entries.length, seen: entries.map((e) => !!e.battle), logs: 0 };
      });
      console.log('      [diag]', JSON.stringify(diag), 'pageLog=', JSON.stringify(pageLog.slice(-5)));
    }
    assert.ok(hit.length > 0, `日志里没有安装记录（叠的是 ${combatPicked}）：${pageLog.slice(-4).join(' | ')}`);
  });
  await check('解锁关掉：站不住的东西被拉回手牌', async () => {
    assert.equal(await send('g.modPlace', { on: false, cap: null }), 'ok');
    await sleep(1200);
    const p = await priv();
    const at = (t) => (p.board || []).some((x) => x && x.row === t[0] && x.col === t[1]);
    assert.equal(at(setup.target), false, '关掉之后那枚棋子还站在非法地块上');
    assert.equal(at(setup.high), false, '关掉之后近战还站在高台上');
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-sandbox-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1200)}`);
process.exit(fail ? 1 : 0);
