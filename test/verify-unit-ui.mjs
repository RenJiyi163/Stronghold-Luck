// verify-unit-ui.mjs — the sandbox's unit rules (技能 / 技力 / 属性) through the real browser.
//
//   node test/verify-unit-ui.mjs [--port 3197] [--chrome <path>]
//
// Boots the modded launcher, walks into the first PREP of a solo ABYSS match and checks, through the panel and over the
// game's own socket:
//
//   面板     the 单位 section lists the chess table, a click names an operator and the server echoes the config back;
//   属性     an absolute value lands on that operator's def in THIS tab's sim (`/sim/simdata.js` getChess) and leaves
//            every other operator alone;
//   作用目标  这一名 covers only the named operator — pointing it elsewhere puts the old def back;
//   战场     with the operator deployed, the battle's own unit carries the new 生命 (the def reached the sim), the new
//            技力消耗 (the SkillRuntime hook wins over the kit's own SkillSpec) and the swapped 携带技能 (the server put
//            it in the spec's skillIndex and the browser resolved it).
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
/** Drive one of the unit section's number boxes / selects the way a click would (a real change event). */
const setUnitField = (sel, value) => page.evaluate((s, v) => {
  const el = document.querySelector(`input[data-field="${s}"], select[data-field="${s}"]`);
  if (!el) return false;
  el.value = v === null || v === undefined ? '' : String(v);
  el.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}, sel, value);

/**
 * A chess def as THIS tab's sim resolves it, through the very DataSource class the battle runner uses. Built from a fresh
 * fetch rather than the live default source: that one is only injected when the runner loads the sim (its first b.start),
 * which has not happened yet this early in a match.
 */
const pageDef = (id, loadout = null) => page.evaluate(async (cid, lo) => {
  const sim = await import('/sim/simdata.js');
  if (!globalThis.__LUCK_TEST_DS__) {
    const raw = {};
    for (const n of ['chess', 'enemies', 'tokens', 'stages', 'waves', 'bonds', 'items', 'garrisons', 'bands', 'effects', 'backups']) {
      try { const r = await fetch(`/data/${n}.json`, { cache: 'no-cache' }); if (r.ok) raw[n] = await r.json(); } catch { /* ignore */ }
    }
    globalThis.__LUCK_TEST_DS__ = new sim.DataSource(raw, null);
  }
  const d = globalThis.__LUCK_TEST_DS__.getChess(cid, lo);
  return d ? { maxHp: d.stats.maxHp, atk: d.stats.atk, def: d.stats.def, cost: d.stats.cost, skillId: d.skill?.id ?? null } : null;
}, id, loadout);

console.log(`\nStronghold-Luck 沙盒单位自检 — ${gameRoot}\n`);

let target = null;

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
  await page.evaluate(() => { (document.querySelector('.dband') || {})?.click?.(); });
  await sleep(600);
  await clickText('确认选择');
  assert.ok(await waitPhase('PREP', 60000), '没进到第一个休整期');
  await sleep(1500);

  // ---- 面板 ------------------------------------------------------------------------------------------
  console.log('[单位 · 面板]');
  await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
  await sleep(1000);
  await clickText('^沙盒$', '.spmod-segbtn');
  await sleep(900);

  // The probe: a MELEE operator THIS LEVEL can already buy (so it can be bought and deployed), cheap enough for the round
  // — and offering at least two skills, so the swap has something to switch to. Buyability comes from the panel's own
  // 在售 list (modPickable.chess is the level-gated pool), not from the unit table, which lists all 266 operators.
  target = await page.evaluate(async () => {
    const S = globalThis.__SP__;
    const { loadoutOptions } = await import('/shared/protocol.js');
    const pool = S.store.get().match.private.shop.modPickable.chess || [];
    const seen = new Set();
    for (const id of pool) {
      const rec = S.data.lookup('chess', id);
      if (!rec || rec.isGolden || seen.has(rec.baseId || id)) continue;
      seen.add(rec.baseId || id);
      if (rec.position !== 'MELEE') continue;
      if ((rec.price ?? 9) > 2) continue;
      const golden = rec.goldenId ? S.data.lookup('chess', rec.goldenId) : null;
      const opt = loadoutOptions(rec, golden);
      if (!opt.skills || opt.skills.length < 2) continue;
      const other = opt.skills.find((i) => i !== opt.defaultSkill);
      const srec = (rec.skills || []).find((s) => s.index === other);
      return { id, name: rec.name, skills: opt.skills, defaultSkill: opt.defaultSkill, wantSkill: other, wantSkillId: srec ? (srec.skillId ?? srec.id) : null };
    }
    return null;
  });
  await check('面板这一页列得出干员，且本局挑得到一名能换技能的近战', () => {
    assert.ok(target, '本局在售的近战里没有「便宜 + 两个以上技能」的（换一张图/重开一局再试）');
    assert.ok(target.wantSkillId, `${target.name} 的 S${target.wantSkill + 1} 没读到 skillId`);
    console.log(`      目标：${target.name}（${target.id}）· 技能 ${JSON.stringify(target.skills)} · 换成 S${target.wantSkill + 1}`);
  });
  await check('列表里能找到这名干员（整张干员表都在，不止在售的那些）', async () => {
    const n = await page.$$eval('.spmod-unit[data-unit]', (els) => els.length);
    assert.ok(n > 100, `单位列表只列了 ${n} 条`);
    const found = await page.evaluate((id) => !!document.querySelector(`.spmod-unit[data-unit="${id}"]`), target.id);
    assert.ok(found, `列表里没有 ${target.id}`);
  });

  await check('点一名干员 → 面板记下，服务端回显同一份配置', async () => {
    const hit = await page.evaluate((id) => {
      const b = document.querySelector(`.spmod-unit[data-unit="${id}"]`);
      if (!b) return false;
      b.click();
      return true;
    }, target.id);
    assert.ok(hit, '列表里没有这颗按钮');
    await sleep(900);
    const now = await priv();
    assert.ok(now.modUnits, '服务端没有 modUnits');
    assert.equal(now.modUnits.id, target.id, `服务端记的是 ${now.modUnits.id}`);
    assert.equal(now.modUnits.scope, 'one');
  });

  await check('填数值 → 服务端原样收下（属性 / 技力 / 倍率）', async () => {
    assert.ok(await setUnitField('maxHp', 12345), '找不到生命输入框');
    await sleep(300);
    await setUnitField('atk', 999);
    await sleep(300);
    await setUnitField('spCost', 7);
    await sleep(300);
    await setUnitField('initSp', 3);
    await sleep(300);
    await setUnitField('mult', 2);
    await sleep(900);
    const now = await priv();
    assert.equal(now.modUnits.stats.maxHp, 12345, `生命 = ${now.modUnits.stats.maxHp}`);
    assert.equal(now.modUnits.stats.atk, 999);
    assert.equal(now.modUnits.spCost, 7);
    assert.equal(now.modUnits.initSp, 3);
    assert.equal(now.modUnits.mult, 2);
    assert.equal(now.modUnits.on, true, '配置没被启用');
  });

  // ---- 浏览器这一侧的 sim -----------------------------------------------------------------------------
  console.log('\n[单位 · 浏览器这一侧]');
  await check('属性落在这一侧的 def 上（战斗跑在这个标签页里，这一半不能少）', async () => {
    const got = await pageDef(target.id);
    assert.ok(got, '拿不到这一名的 def');
    assert.equal(got.maxHp, 12345, `生命 = ${got.maxHp}`);
    assert.equal(got.atk, 999, `攻击 = ${got.atk}（填了绝对值，倍率不该再乘）`);
    assert.ok(Number.isFinite(got.def), `防御读不到：${got.def}`);
    assert.ok(got.cost !== 12345, '费用不该被倍率带着走');
  });

  await check('别的干员一个字节都没动（阴性对照）', async () => {
    const otherId = await page.evaluate((id) => {
      const b = [...document.querySelectorAll('.spmod-unit[data-unit]')].find((e) => e.getAttribute('data-unit') !== id);
      return b?.getAttribute('data-unit') || null;
    }, target.id);
    assert.ok(otherId, '列表里没有第二名干员');
    const other = await pageDef(otherId);
    assert.ok(other, `拿不到 ${otherId} 的 def`);
    assert.notEqual(other.maxHp, 12345, `连 ${otherId} 都被改了`);
  });

  await check('作用目标 = 这一名：指向别人时，这一名就回到原值', async () => {
    assert.equal((await pageDef(target.id)).maxHp, 12345, '前置条件不成立');
    const otherId = await page.evaluate((id) => {
      const b = [...document.querySelectorAll('.spmod-unit[data-unit]')].find((e) => e.getAttribute('data-unit') !== id);
      const x = b?.getAttribute('data-unit') || null;
      b?.click();
      return x;
    }, target.id);
    assert.ok(otherId, '找不到第二名干员');
    await sleep(900);
    const moved = await pageDef(target.id);
    assert.notEqual(moved.maxHp, 12345, `换成 ${otherId} 之后，${target.id} 还是被改着`);
    assert.equal((await pageDef(otherId)).maxHp, 12345, '新目标没吃上改动');
    // and put it back on our operator
    await page.evaluate((id) => document.querySelector(`.spmod-unit[data-unit="${id}"]`)?.click(), target.id);
    await sleep(700);
    assert.equal((await pageDef(target.id)).maxHp, 12345, '点回来之后没恢复');
  });

  const setScope = (label) => page.evaluate((t) => {
    const b = [...document.querySelectorAll('.spmod-segbtn')].find((e) => (e.textContent || '').trim() === t);
    b?.click();
    return !!b;
  }, label);

  await check(`换成 S${target.wantSkill + 1} → 服务端收下，spec 上也带出去（战斗侧才验得到）`, async () => {
    const ok = await page.evaluate((idx) => {
      const sel = [...document.querySelectorAll('.spmod-prof')].find((s) => s.tagName === 'SELECT' && /保持原样|S\d/.test(s.textContent));
      if (!sel) return false;
      sel.value = String(idx);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }, target.wantSkill);
    assert.ok(ok, '找不到技能下拉');
    await sleep(900);
    const now = await priv();
    assert.equal(now.modUnits.skill, target.wantSkill, `服务端记的技能是 ${now.modUnits.skill}`);
  });

  await check('作用目标：我的全部 / 全场都只在这台机器上改数值，服务端只在「全场」时才接管', async () => {
    const press = async (label, want) => {
      assert.ok(await setScope(label), `找不到「${label}」`);
      await sleep(900);
      const now = await priv();
      assert.equal(now.modUnits.scope, want, `服务端记的作用目标是 ${now.modUnits.scope}`);
      assert.equal(now.modUnits.appliedHere, want === 'all', `服务端 appliedHere = ${now.modUnits.appliedHere}`);
      // the browser half applies for every scope — this tab simulates the player's own field whatever the target is
      assert.equal((await pageDef(target.id)).maxHp, 12345, `${label} 下这一侧没生效`);
      const hasSel = await page.evaluate(() => [...document.querySelectorAll('.spmod-prof')].some((s) => s.tagName === 'SELECT' && /保持原样/.test(s.textContent)));
      assert.equal(hasSel, want === 'one', `${label} 下技能下拉的显隐不对`);
    };
    await press('我的全部', 'mine');
    await press('全场', 'all');
    await press('这一名', 'one');
    assert.equal((await priv()).modUnits.id, target.id, '切回来之后没回到这一名');
  });

  // ---- 战场 ------------------------------------------------------------------------------------------
  console.log('\n[单位 · 战场]');
  // Buy the probe and put it on the board, so this round's battle really fields it.
  const board = await page.evaluate(() => {
    const m = globalThis.__SP__.store.get().match;
    const stage = globalThis.__SP__.data.lookup('stages', m.public.stageId);
    const rows = Array.isArray(stage?.rows) ? stage.rows : [];
    const legend = stage && typeof stage.tiles === 'object' ? stage.tiles : {};
    const at = (r, c) => { const g = (rows[r] || '')[c]; return g != null ? legend[g] || null : null; };
    const spots = [];
    for (let r = 9; r <= 12; r++) for (let c = 2; c <= 10; c++) {
      const t = at(r, c);
      if (!t) continue;
      if (t.height === 'LOW' && (t.buildable === 'ALL' || t.buildable === 'MELEE')) spots.push([r, c]);
    }
    return { spots, hand: (m.private.hand || []).filter(Boolean).map((h) => ({ uid: h.uid, id: h.id })) };
  });
  await check('买得下这名干员、放得上棋盘', async () => {
    assert.equal(await send('g.modBuy', { id: target.id }), 'ok', '直购失败');
    await sleep(700);
    const hand = (await priv()).hand.filter(Boolean);
    const piece = hand.find((h) => h.id === target.id) || hand[hand.length - 1];
    assert.ok(piece, '手牌里没有这枚棋子');
    let placed = 'no-spot';
    for (const [r, c] of board.spots) {
      placed = await page.evaluate((u, rr, cc) => globalThis.__SP__.net.request('g.move', { uid: u, to: { area: 'board', row: rr, col: cc, dir: 'RIGHT' }, dir: 'RIGHT' })
        .then(() => 'ok', (e) => String(e?.detail || e?.code || e)), piece.uid, r, c);
      if (placed === 'ok') break;
    }
    assert.equal(placed, 'ok', `没找到能站的格子（试了 ${board.spots.length} 块）：${placed}`);
    target.uid = piece.uid;
  });

  await check('这一场战斗里的这一名，带着改过的数值 / 技力 / 技能', async () => {
    await page.keyboard.press('Escape');
    await sleep(400);
    await clickText('准备就绪', '.readybtn');
    await sleep(700);
    await clickText('^准备就绪', 'button:not(.readybtn)'); // the confirm dialog's own button, when funds are left
    let unit = null;
    const t0 = Date.now();
    while (Date.now() - t0 < 120000) {
      unit = await page.evaluate((id) => {
        const runner = globalThis.__SP_RUNNER__;
        if (!runner?._entries) return null;
        for (const e of runner._entries.values()) {
          const us = e?.battle?.allyUnits;
          if (!Array.isArray(us)) continue;
          const u = us.find((x) => x && x.defId === id);
          if (!u) continue;
          return { maxHp: u.base?.maxHp, spCost: u.skill?.baseSpCost, initSp: u.skill?.initSp, skillId: u.def?.skill?.id ?? null, kind: u.kind };
        }
        return null;
      }, target.id);
      if (unit) break;
      await sleep(300);
    }
    if (!unit) {
      console.log('      [diag] 阶段=', await phase(), ' 启动器=', out.slice(-600));
    }
    assert.ok(unit, '这一场战斗里没找到这一名（没部署？战斗没跑在浏览器里？）');
    assert.equal(unit.maxHp, 12345, `战斗里的生命是 ${unit.maxHp}（def 没传到 sim）`);
    assert.equal(unit.spCost, 7, `战斗里的技能消耗是 ${unit.spCost}（kit 自己的 SkillSpec 盖过了？reset 钩子没生效？）`);
    assert.equal(unit.initSp, 3, `初始技力是 ${unit.initSp}`);
    assert.equal(unit.skillId, target.wantSkillId, `携带技能是 ${unit.skillId}，期望 ${target.wantSkillId}`);
  });

  // ---- 收尾 ------------------------------------------------------------------------------------------
  await check('清除 → 两侧都回到原版', async () => {
    await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
    await sleep(700);
    const cleared = await page.evaluate(() => {
      const b = [...document.querySelectorAll('.spmod-sbbtn')].find((e) => /^清除$/.test((e.textContent || '').trim()));
      b?.click();
      return !!b;
    });
    assert.ok(cleared, '找不到清除按钮');
    await sleep(1000);
    const now = await priv();
    assert.equal(now.modUnits?.on, false, '服务端还开着');
    const back = await pageDef(target.id);
    assert.notEqual(back?.maxHp, 12345, '这一侧还改着');
  });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-unit-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  try { child.kill(); } catch { /* ignore */ }
  await sleep(400);
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1500)}`);
process.exit(fail ? 1 : 0);
