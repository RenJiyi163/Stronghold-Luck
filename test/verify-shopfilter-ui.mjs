// verify-shopfilter-ui.mjs — 阵营锁（商店只刷所选盟约的干员）through the real browser.
//
//   node test/verify-shopfilter-ui.mjs [--port 3197] [--chrome <path>]
//
// Boots the modded launcher, plays into the first PREP of a solo ABYSS match, then drives the panel and the game's own
// socket:
//
//   面板   商店页有「阵营锁」那一行，服务端报得出本局的可选盟约；
//   口径   子集读数：一名干员只有它的**每一条**盟约都在所选里才留下（[炎,灵巧] 在 {炎,灵巧,奥术} 下留下，
//          [炎,维多利亚] 挡掉）；
//   自动刷新  勾上之后，商店**自动刷新**出来的干员全是所选盟约的子集；勾之前那一roll 里能见到集合外的干员（阴性对照）；
//   范围   只管自动刷新：面板的自选/直购列表（modPickable.chess）一件都不少（作者 2026-10-10 的口径）。
//
// The bond set is derived from a piece the shop could actually roll right now (one pickable operator's own bonds, so the
// subset test holds for it by construction), taking the one that admits the most — a filtered roll is then guaranteed to
// land on something (`SharedPool.roll` is copy-weighted, so a non-empty eligible set never rolls empty).
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
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3197;
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

console.log(`\nStronghold-Luck 阵营锁自检 — ${gameRoot}\n`);

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

  console.log('[阵营锁 · 面板]');
  await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
  await sleep(1000);

  // The bond set to lock to, taken from what the shop could actually roll right now: one pickable operator's own bonds
  // (its subset test then holds by construction), preferring the one that admits the most pieces so a filtered roll is
  // never empty. Keep other operators OUT of it — that is what the negative control rests on.
  const pickData = await page.evaluate(() => {
    const S = globalThis.__SP__;
    const pick = S.store.get().match.private.shop.modPickable;
    const bondsOf = (id) => {
      const c = S.data.lookup('chess', id);
      return c && Array.isArray(c.bonds) ? c.bonds.slice() : [];
    };
    const admitted = (set) => pick.chess.filter((id) => {
      const bs = bondsOf(id);
      return bs.length > 0 && bs.every((b) => set.includes(b));
    }).length;
    const seen = new Set();
    let best = null;
    for (const id of pick.chess) {
      const bs = bondsOf(id);
      if (!bs.length) continue;
      const key = [...bs].sort().join(',');
      if (seen.has(key)) continue;
      seen.add(key);
      const set = [...bs].sort();
      const cand = { set, n: admitted(set) };
      if (!best || cand.n > best.n) best = cand;
    }
    return {
      best,
      chessN: pick.chess.length,
      poolBonds: (S.store.get().match.private.shop.modShopFilter?.pool || []).map((b) => b.id),
    };
  });
  assert.ok(pickData.best, '这一局没有可买的自选干员，换一局再试');
  const SET = pickData.best.set;
  const setNames = await page.evaluate((ids) => ids.map((id) => globalThis.__SP__.data.lookup('bonds', id)?.name || id), SET);
  console.log(`      锁定盟约：${setNames.join(' · ')}（这一档能出的 ${pickData.chessN} 名里，子集命中的有 ${pickData.best.n} 名）`);

  /** The chess ids the shop is offering right now. */
  const shopChess = async () => ((await priv()).shop.slots || []).filter((x) => x && x.kind === 'chess').map((x) => x.id);
  /** Which of `ids` the set does NOT admit (some bond of theirs is outside it). */
  const outsideOf = (ids) => page.evaluate((s, list) => {
    const S = globalThis.__SP__;
    return list.filter((id) => {
      const c = S.data.lookup('chess', id);
      const bs = c && Array.isArray(c.bonds) ? c.bonds : [];
      return !(bs.length > 0 && bs.every((b) => s.includes(b)));
    });
  }, SET, ids);
  /** Refresh up to n times, collecting the shop's chess AFTER each roll; stops once the server refuses (gold runs out). */
  const rollCollect = async (n) => {
    const seen = [];
    for (let i = 0; i < n; i++) {
      const r = await send('g.refresh', {});
      await sleep(450);
      seen.push(...(await shopChess()));
      if (r !== 'ok') break;
    }
    return seen;
  };

  await check('商店页有「阵营锁」那一行，服务端报得出本局的可选盟约', async () => {
    assert.ok(await page.evaluate(() => !!document.querySelector('.spmod-shopfilter')), '面板上没有阵营锁那一行');
    assert.ok(pickData.poolBonds.length > 3, `服务端只报了 ${pickData.poolBonds.length} 个盟约`);
  });

  await check('勾之前：开局那一roll 里能见到集合外的干员（阴性对照）', async () => {
    const now = await shopChess();
    assert.ok(now.length > 0, '开局的商店一个干员都没有，换一局再试');
    const outside = await outsideOf(now);
    assert.ok(outside.length > 0, `开局那一roll（${now.join(', ')}）一名集合外的干员都没有，阴性对照不成立`);
  });

  // Enable it the way a player would — the panel's own checkbox and bond chips — so the remembered state, the request
  // it sends and what the server echoes all move together.
  await check('面板上勾开、点选盟约：服务端收下，回显的可选人数与前端独立算出来的一致', async () => {
    const before = (await priv()).shop.modPickable.chess.length;
    await page.evaluate(() => { const b = document.querySelector('.spmod-shopfilter input[type=checkbox]'); if (b && !b.checked) b.click(); });
    await sleep(700);
    for (const id of SET) {
      await page.evaluate((x) => document.querySelector(`.spmod-bondchip[data-bond="${x}"]`)?.click(), id);
      await sleep(300);
    }
    await sleep(900);
    const p = await priv();
    const sf = p.shop.modShopFilter;
    assert.equal(sf.on, true, '回显里开关没打开');
    assert.deepEqual([...sf.bonds].sort(), [...SET].sort(), `回显的盟约是 ${JSON.stringify(sf.bonds)}`);
    // recompute the admitted count the long way, straight off the list the server itself builds
    const expect = await page.evaluate((s) => {
      const S = globalThis.__SP__;
      const pick = S.store.get().match.private.shop.modPickable;
      const ok = (id) => {
        const c = S.data.lookup('chess', id);
        const bs = c && Array.isArray(c.bonds) ? c.bonds : [];
        return bs.length > 0 && bs.every((b) => s.includes(b));
      };
      return pick.chess.filter(ok).length + (pick.diy || []).filter((d) => d.ok && ok(d.id)).length;
    }, SET);
    assert.equal(sf.count, expect, `服务端报可选 ${sf.count} 名，前端算出来 ${expect} 名`);
    assert.equal(p.shop.modPickable.chess.length, before, '自选/直购的列表跟着变窄了（口径是只管自动刷新）');
  });

  await check('面板把「当前可选 N 名」显示出来了', async () => {
    const t = await page.evaluate(() => document.querySelector('.spmod-shopfilter')?.textContent || '');
    assert.match(t, /当前可选 \d+ 名干员/, `面板上没有可选人数：${t.replace(/\s+/g, ' ').slice(0, 90)}`);
  });

  await check('打开后自动刷新出的干员全是所选盟约的子集', async () => {
    const all = [...new Set(await rollCollect(4))];
    assert.ok(all.length > 0, '打开后几次刷新一个干员都没出');
    const outside = await outsideOf(all);
    assert.equal(outside.length, 0, `出了集合外的干员：${outside.join(', ')}`);
    console.log(`      （刷新后见到的 ${all.length} 种干员全在所选盟约内）`);
  });

  await check('关掉阵营锁：服务端回显为关', async () => {
    await page.evaluate(() => { const b = document.querySelector('.spmod-shopfilter input[type=checkbox]'); if (b && b.checked) b.click(); });
    await sleep(900);
    assert.equal((await priv()).shop.modShopFilter.on, false, '服务端没关掉');
  });

  await check('不认识的盟约会被拒（服务端校验）', async () => {
    const r = await send('g.modShopFilter', { on: true, bonds: ['bond_not_a_bond'] });
    assert.notEqual(r, 'ok', `居然收下了：${r}`);
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-shopfilter-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1200)}`);
process.exit(fail ? 1 : 0);
