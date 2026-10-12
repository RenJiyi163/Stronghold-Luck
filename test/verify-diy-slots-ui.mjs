// verify-diy-slots-ui.mjs — 自选位（per-slot 盟约 / 特质）through the real browser panel.
//
//   node test/verify-diy-slots-ui.mjs [--port 3198] [--chrome <path>]
//
// Boots the modded launcher, sets 自选编队 picks over the game's own `room.diy` intent, plays into the first PREP of a
// solo ABYSS match, then drives the panel's new 自选位 page and reads the server back through the game's own store:
//
//   * the page lists the match's own slots and names the operator sitting in each;
//   * clicking a 盟约 chip changes what the SERVER holds (`m.private.modDiy`) and what it counts (`m.private.bonds`);
//   * a slot nobody configured keeps its own derived bond (the negative control);
//   * 加特质 opens a searchable list and the picked 特质 reaches the server;
//   * 还原 puts the slot back.
//
// The kit is per browser and pushed once a match is under way, so the same run also checks it survives a reload.
// Nothing here writes to the game folder.

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

const SLOT5 = 'chess_char_5_diy1_a';
const SLOT6 = 'chess_char_6_diy1_a';
/** Two 原型干员: a prototype keeps its stock whatever the drawn bans are, so the list is non-empty in any match. */
const PICKS = { [SLOT5]: { charId: 'char_601_cguard' }, [SLOT6]: { charId: 'char_608_acpion' } };
/** 阿戈尔: unreachable for a 自选 piece's own derived bonds (no 势力 maps to it), so it is the loud case. */
const BOND = 'egirShip';
/** 获得时自身所属盟约层数 +2 — a 休整期 特质 whose effect is visible in the player's own state. */
const GARRISON = 'garrison_25_a';

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
/** The server's own view of the kit (what the patch holds, echoed back on every private view). */
const serverState = () => page.evaluate(() => {
  const p = globalThis.__SP__.store.get().match.private;
  return { slots: p.modDiy?.slots || {}, extra: p.modDiy?.extra || [], diy: Object.keys(p.diy || {}) };
});
/** Click one chip of the 自选位 page (only that slot's row matches the selector). */
const clickBond = (slot, bond) => page.evaluate((s, b) => {
  const el = document.querySelector(`.spmod-bondchip[data-slot="${s}"][data-bond="${b}"]`);
  if (!el) return 'no chip';
  el.click();
  return 'ok';
}, slot, bond);

console.log(`\nStronghold-Luck 自选位界面自检 — ${gameRoot}\n`);

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

  const set = await page.evaluate((picks) => globalThis.__SP__.net.request('room.diy', { picks })
    .then(() => 'ok', (e) => String(e?.detail || e?.code || e)), PICKS);
  assert.equal(set, 'ok', `room.diy 被拒：${set}`);

  await clickText('^开始模拟$');
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

  console.log('[自选位页]');
  await page.evaluate(() => {
    localStorage.removeItem('spmod.diySlots');
    document.querySelector('.spmod-fab')?.click();
  });
  await sleep(1200);
  await clickText('^自选位$', '.spmod-segbtn');
  await sleep(1000);

  const page1 = await page.evaluate(() => ({
    rows: [...document.querySelectorAll('.spmod-diyslot')].map((r) => r.getAttribute('data-slot')),
    who: [...document.querySelectorAll('.spmod-diywho')].map((e) => e.textContent.trim()),
    chips: document.querySelectorAll('.spmod-diyslot .spmod-bondchip').length,
    errors: 0,
  }));
  await check('自选位页列出本局的每个位子，并写出坐在上面的干员', () => {
    for (const s of Object.keys(PICKS)) assert.ok(page1.rows.includes(s), `没列出 ${s}（列出的是 ${page1.rows.join(',')}）`);
    assert.ok(page1.who.some((t) => t.includes('预备干员-近卫')), `没认出近卫原型：${page1.who.join(' | ')}`);
    assert.ok(page1.who.some((t) => t.includes('郁金香')), `没认出郁金香：${page1.who.join(' | ')}`);
    assert.ok(page1.chips > 0, '一条盟约的勾都没画出来');
  });

  console.log('[指定盟约]');
  const before = await serverState();
  await check('阴性对照：还没配的位子不出现服务端的 kit 里', () => {
    assert.equal(before.slots[SLOT5], undefined, `没配的位子不该出现：${JSON.stringify(before.slots)}`);
    assert.equal(Object.keys(before.slots).length, 0, `不该有任何配置：${JSON.stringify(before.slots)}`);
  });
  await check('勾一个盟约：没勾过盟约的位子默认「跟随干员」，一点就转成「替换」', async () => {
    assert.equal(await clickBond(SLOT5, BOND), 'ok', '没找到阿戈尔的勾');
    await sleep(1500);
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT5]?.bonds, [BOND], `服务端收到的是 ${JSON.stringify(s.slots[SLOT5])}`);
    assert.deepEqual(s.slots[SLOT5]?.addBonds, [], '替换模式下不该带 addBonds');
    assert.equal(s.slots[SLOT6], undefined, '没碰的位子被改了');
  });
  await check('再勾一条：两条都在，服务端跟着', async () => {
    assert.equal(await clickBond(SLOT5, 'kjeragShip'), 'ok');
    await sleep(1500);
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT5]?.bonds?.slice().sort(), ['egirShip', 'kjeragShip']);
  });
  await check('点掉一条：只剩另一条', async () => {
    assert.equal(await clickBond(SLOT5, BOND), 'ok');
    await sleep(1500);
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT5]?.bonds, ['kjeragShip']);
  });
  await check('切到「叠加」：原来那条留着，服务端收到 addBonds', async () => {
    const click = (mode) => page.evaluate((s, m) => {
      document.querySelector(`.spmod-diyslot[data-slot="${s}"] .spmod-segbtn[data-mode="${m}"]`)?.click();
    }, SLOT5, mode);
    await click('add');
    await sleep(1500);
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT5]?.bonds, null, `叠加模式不该给 bonds：${JSON.stringify(s.slots[SLOT5])}`);
    assert.deepEqual(s.slots[SLOT5]?.addBonds, ['kjeragShip']);
    await click('replace');
    await sleep(1200);
  });

  await check('一键全选：能生效的盟约全勾上，「绝技」不在里面而且点不动', async () => {
    await page.evaluate((s) => document.querySelector(`.spmod-segbtn[data-bondall="${s}"]`)?.click(), SLOT6);
    await sleep(1800);
    const s = await serverState();
    const bonds = s.slots[SLOT6]?.bonds || [];
    assert.equal(bonds.length, 22, `能生效的盟约本该是 22 条（23 条里「绝技」不数成员），实得 ${bonds.length}`);
    assert.ok(!bonds.includes('suntShip'), '「绝技」被勾上了');
    const dead = await page.evaluate((sl) => {
      const c = document.querySelector(`.spmod-bondchip[data-slot="${sl}"][data-bond="suntShip"]`);
      return c ? { disabled: !!c.disabled, dead: c.className.includes('is-dead') } : null;
    }, SLOT6);
    assert.ok(dead && dead.disabled && dead.dead, `「绝技」那条没被关掉：${JSON.stringify(dead)}`);
  });
  await check('一键清空：这个位子一条盟约都不留', async () => {
    await page.evaluate((s) => document.querySelector(`.spmod-segbtn[data-bondnone="${s}"]`)?.click(), SLOT6);
    await sleep(1600);
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT6]?.bonds, [], `清空之后还剩：${JSON.stringify(s.slots[SLOT6])}`);
  });
  await check('用默认：把「新位子默认」那几条补上（默认是调和）', async () => {
    await page.evaluate((s) => document.querySelector(`.spmod-segbtn[data-bonddef="${s}"]`)?.click(), SLOT6);
    await sleep(1600);
    const s = await serverState();
    const got = [...(s.slots[SLOT6]?.bonds || []), ...(s.slots[SLOT6]?.addBonds || [])];
    assert.ok(got.includes('maniShip'), `默认没补上：${JSON.stringify(s.slots[SLOT6])}`);
  });

  console.log('[加特质]');
  await check('加特质：搜得到、点得上、到得了服务端', async () => {
    const opened = await page.evaluate((s) => {
      const b = document.querySelector(`.spmod-sbbtn[data-garadd="${s}"]`);
      if (!b) return 'no button';
      b.click();
      return 'ok';
    }, SLOT5);
    assert.equal(opened, 'ok', '没有「＋ 加特质」按钮');
    await sleep(900);
    const n = await page.$$eval('.spmod-gar', (els) => els.length);
    assert.ok(n > 0, '特质候选一条都没列出来（特质表没载入？）');
    // search by id: the list is capped at 60 of ~250 records, so the wanted one may not be in the first page
    await page.evaluate((s, g) => {
      const inp = document.querySelector(`.spmod-diyslot[data-slot="${s}"] input.spmod-search[data-garquery]`);
      inp.value = g;
      inp.dispatchEvent(new Event('input', { bubbles: true }));
    }, SLOT5, GARRISON);
    await sleep(1000);
    const hit = await page.evaluate((s, g) => {
      const el = document.querySelector(`.spmod-gar[data-slot="${s}"][data-garrison="${g}"]`);
      if (!el) return 'no candidate';
      el.click();
      return 'ok';
    }, SLOT5, GARRISON);
    assert.equal(hit, 'ok', `搜不到 ${GARRISON}`);
    await sleep(1500);
    const s = await serverState();
    assert.equal(s.slots[SLOT5]?.garrisons?.length, 1, `服务端收到 ${JSON.stringify(s.slots[SLOT5]?.garrisons)}`);
  });

  await check('特质选择器：只列普通形态那一条、按触发时机分组、标明来自哪张卡', async () => {
    // the previous check left a search term in the box; clear it so the full grouped list is drawn
    await page.evaluate((slot) => {
      const i = document.querySelector(`.spmod-diyslot[data-slot="${slot}"] input[data-garquery]`);
      if (i) { i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); }
    }, SLOT5);
    await sleep(1000);
    const info = await page.evaluate((slot) => {
      const row = document.querySelector(`.spmod-diyslot[data-slot="${slot}"]`);
      const items = [...row.querySelectorAll('.spmod-gar')];
      return {
        groups: [...row.querySelectorAll('.spmod-gargroup')].map((g) => g.textContent.trim()),
        ids: items.map((b) => b.getAttribute('data-garrison')),
        withSrc: items.filter((b) => b.querySelector('.spmod-garsrc')).length,
        srcSample: items.find((b) => b.querySelector('.spmod-garsrc'))?.querySelector('.spmod-garsrc').textContent || '',
      };
    }, SLOT5);
    assert.ok(info.groups.length >= 2, `没按触发时机分组：${JSON.stringify(info.groups)}`);
    assert.ok(info.ids.length > 5, `候选太少：${info.ids.length}`);
    const elite = info.ids.filter((id) => id.endsWith('_b'));
    assert.equal(elite.length, 0, `把精锐那一条也列出来了：${elite.join(',')}`);
    assert.ok(info.withSrc > 0, '没有一条标了来自哪张卡');
    assert.match(info.srcSample, /来自/, `来源标注不对：${info.srcSample}`);
  });

  console.log('[数值]');
  await check('填盟约数值：改到的是这一条盟约的键，服务端收到 bondBb', async () => {
    assert.equal(await clickBond(SLOT5, 'yanShip'), 'ok');
    await sleep(1400);
    await page.evaluate((s) => document.querySelector(`.spmod-sbbtn[data-diynum="${s}"]`)?.click(), SLOT5);
    await sleep(900);
    const box = await page.evaluate((s) => {
      const block = document.querySelector(`.spmod-diyslot[data-slot="${s}"] .spmod-bbsection[data-bb="bond:yanShip"]`);
      if (!block) return 'no block';
      const inp = block.querySelector('input[data-field="yanShip:atk_per_stack"]');
      if (!inp) return `keys: ${[...block.querySelectorAll('input')].map((i) => i.getAttribute('data-field')).join(',')}`;
      inp.value = '0.5';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }, SLOT5);
    assert.equal(box, 'ok', `没找到 atk_per_stack 的输入框：${box}`);
    await sleep(1500);
    const s = await serverState();
    assert.equal(s.slots[SLOT5]?.bondBb?.yanShip?.atk_per_stack, 0.5, `服务端收到 ${JSON.stringify(s.slots[SLOT5]?.bondBb)}`);
  });
  await check('填特质数值：服务端按位子记一份', async () => {
    const out = await page.evaluate((s) => {
      const row = document.querySelector(`.spmod-diyslot[data-slot="${s}"]`);
      const blocks = [...row.querySelectorAll('.spmod-bbsection')];
      const block = blocks.find((b) => (b.getAttribute('data-bb') || '').startsWith('garrison:'));
      if (!block) return `no block (有 ${blocks.map((b) => b.getAttribute('data-bb')).join('|') || '零个区块'})`;
      const inp = block.querySelector('input');
      if (!inp) return `no input: ${block.outerHTML.slice(0, 240)}`;
      inp.value = '9';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.getAttribute('data-field');
    }, SLOT5);
    assert.ok(!out.startsWith('no '), `没找到特质的输入框：${out}`);
    await sleep(1500);
    const s = await serverState();
    const gid = Object.keys(s.slots[SLOT5]?.garrisonBb || {})[0];
    assert.ok(gid, `服务端没收到特质数值：${JSON.stringify(s.slots[SLOT5]?.garrisonBb)}`);
    assert.equal(Object.values(s.slots[SLOT5].garrisonBb)[0][out.split(':')[1]], 9);
  });

  console.log('[特质默认]');
  await check('特质默认：能给自己定一套', async () => {
    const opened = await page.evaluate(() => {
      const b = document.querySelector('.spmod-sbbtn[data-defgaradd]');
      if (!b) return 'no button';
      b.click();
      return 'ok';
    });
    assert.equal(opened, 'ok', '没有「特质默认」的加号');
    await sleep(900);
    await page.evaluate((g) => {
      const i = document.querySelector('input[data-garquery="default"]');
      if (i) { i.value = g; i.dispatchEvent(new Event('input', { bubbles: true })); }
    }, GARRISON);
    await sleep(900);
    const hit = await page.evaluate((g) => {
      const el = document.querySelector(`.spmod-gar[data-slot="default"][data-garrison="${g}"]`);
      if (!el) return 'no candidate';
      el.click();
      return 'ok';
    }, GARRISON);
    assert.equal(hit, 'ok', `默认里加不进那条特质：${hit}`);
    await sleep(1200);
    const chips = await page.evaluate(() => [...document.querySelectorAll('.spmod-garchip[data-slot="default"]')].map((c) => c.getAttribute('data-garrison')));
    assert.deepEqual(chips, [GARRISON], `默认那一条没进去：${JSON.stringify(chips)}`);
  });
  await check('用默认：给一个位子补上默认那几条特质', async () => {
    await page.evaluate((s) => document.querySelector(`.spmod-sbbtn[data-garde="${s}"]`)?.click(), SLOT6);
    await sleep(1700);
    const s = await serverState();
    assert.ok((s.slots[SLOT6]?.garrisons || []).includes(GARRISON), `「用默认」没补上：${JSON.stringify(s.slots[SLOT6])}`);
  });

  console.log('[自造位子]');
  await check('加一个位子、按到 3 阶、挑一名原型干员：服务端收到 extra 并把它建出来', async () => {
    await page.evaluate(() => document.querySelector('.spmod-sbbtn[data-diyadd]')?.click());
    await sleep(1200);
    const rows = await page.$$eval('.spmod-diyslot', (els) => els.length);
    assert.ok(rows >= 2, `加了位子却没多出一行（共 ${rows} 行）`);
    await page.evaluate(() => {
      const sel = document.querySelector('select[data-diytier]');
      sel.value = '3';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(1200);
    // 「＋ 加一个位子」 opens the picker itself; only click if something closed it
    const opened = await page.evaluate(() => {
      if (document.querySelector('input[data-diypickquery]')) return 'open';
      const btn = document.querySelector('.spmod-sbbtn[data-diypick]');
      if (!btn) return 'no button';
      btn.click();
      return 'clicked';
    });
    assert.ok(opened !== 'no button', `没有「选干员」按钮：${opened}`);
    await sleep(900);
    await page.evaluate(() => {
      const inp = document.querySelector('input[data-diypickquery]');
      if (inp) { inp.value = '预备干员'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(900);
    const hit = await page.evaluate(() => {
      const el = document.querySelector('.spmod-unit[data-diyop="char_601_cguard"]');
      if (el) { el.click(); return 'ok'; }
      const all = [...document.querySelectorAll('.spmod-unit[data-diyop]')];
      const inp = document.querySelector('input[data-diypickquery]');
      return `no candidate: 列出 ${all.length} 名；搜索框 ${inp ? '在' : '不在'}；第一行 ${all[0]?.getAttribute('data-diyop') || '-'}`;
    });
    assert.equal(hit, 'ok', `挑不到预备干员-近卫：${hit}`);
    await sleep(1800);
    const st = await page.evaluate(() => globalThis.__SP__.store.get().match.private);
    const extra = st.modDiy?.extra || [];
    assert.equal(extra.length, 1, `服务端没收到 extra：${JSON.stringify(extra)}`);
    assert.equal(extra[0].tier, 3, `阶不对：${extra[0].tier}`);
    assert.equal(extra[0].pick?.charId, 'char_601_cguard');
    assert.ok(Object.keys(st.diy || {}).some((id) => id.startsWith('mod_diy_')), `这一座没拿到自造位子：${Object.keys(st.diy || {}).join(',')}`);
  });
  await check('自造位子在本机数据里也认得出来（面板 / 卡片 / 模拟都用同一张表）', async () => {
    const seen = await page.evaluate(() => {
      const id = Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_'));
      const rec = globalThis.__SP__.data.lookup('chess', id);
      const slots = globalThis.__SP__.data.get('backups')?.diy?.slots || {};
      return { id, tier: rec?.tier ?? null, slotTier: slots[id]?.tier ?? null };
    });
    assert.ok(seen.id, '这一座没有自造位子');
    assert.equal(seen.tier, 3, `本机的 chess 表里阶不对：${seen.tier}`);
    assert.equal(seen.slotTier, 3, `本机的 diy.slots 里没有这个位子：${seen.slotTier}`);
  });
  await check('自造位子自带「新位子默认」那几条（调和），也照样能加别的', async () => {
    const id = await page.evaluate(() => Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_')));
    const seeded = await serverState();
    assert.ok((seeded.slots[id]?.addBonds || []).includes('maniShip'), `新位子没带上默认的盟约：${JSON.stringify(seeded.slots[id])}`);
    assert.ok((seeded.slots[id]?.garrisons || []).includes(GARRISON), `新位子没带上默认的特质：${JSON.stringify(seeded.slots[id])}`);
    assert.equal(await clickBond(id, 'egirShip'), 'ok', '自造位子那一行没有盟约的勾');
    await sleep(1600);
    const s = await serverState();
    const got = [...(s.slots[id]?.bonds || []), ...(s.slots[id]?.addBonds || [])];
    assert.ok(got.includes('egirShip') && got.includes('maniShip'), `服务端没收下：${JSON.stringify(s.slots[id])}`);
  });
  await check('携带技能：自造位子挑持有干员默认带三技能，也能改成二技能', async () => {
    const id = await page.evaluate(() => Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_')));
    assert.ok(id, '这一条之前没建出自造位子');
    await page.evaluate(() => {
      if (!document.querySelector('input[data-diypickquery]')) document.querySelector('.spmod-sbbtn[data-diypick]')?.click();
    });
    await sleep(900);
    await page.evaluate(() => {
      const i = document.querySelector('input[data-diypickquery]');
      if (i) { i.value = '凯尔希'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(1000);
    const hit = await page.evaluate(() => {
      const el = document.querySelector('.spmod-unit[data-diyop="char_003_kalts"]');
      if (!el) return 'no candidate';
      el.click();
      return 'ok';
    });
    assert.equal(hit, 'ok', `挑不到凯尔希：${hit}`);
    await sleep(1800);
    let s = await serverState();
    const picked = (s.extra || []).find((e) => e.pick && e.pick.charId === 'char_003_kalts');
    assert.ok(picked, `服务端没收到这名干员：${JSON.stringify(s.extra)}`);
    assert.equal(picked.pick.skillIndex, 2, `默认该带三技能（索引 2），实得 ${picked.pick.skillIndex}`);
    const changed = await page.evaluate((slot) => {
      const sel = document.querySelector(`select[data-diyskill="${slot}"]`);
      if (!sel) return 'no select';
      if (sel.disabled) return `select disabled（选项：${[...sel.options].map((o) => o.textContent).join('|')}）`;
      sel.value = '1';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return 'ok';
    }, id);
    assert.equal(changed, 'ok', `自造位子的技能下拉没用：${changed}`);
    await sleep(1600);
    s = await serverState();
    const after = (s.extra || []).find((e) => e.pick && e.pick.charId === 'char_003_kalts');
    assert.equal(after?.pick?.skillIndex, 1, `改成二技能没生效：${JSON.stringify(after)}`);
  });
  await check('模组：自造位子上挑得动，挑完服务端收得到', async () => {
    const id = await page.evaluate(() => Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_')));
    const seen = await page.evaluate((slot) => {
      const sel = document.querySelector(`select[data-diymod="${slot}"]`);
      return sel ? { disabled: !!sel.disabled, opts: [...sel.options].map((o) => ({ v: o.value, t: o.textContent })) } : null;
    }, id);
    assert.ok(seen && !seen.disabled, `模组下拉用不了：${JSON.stringify(seen)}`);
    assert.ok(seen.opts.length >= 2, `模组候选太少：${JSON.stringify(seen.opts)}`);
    assert.match(seen.opts[0].t, /不带模组/, `第一项该是「不带模组」：${seen.opts[0].t}`);
    const want = await page.evaluate((slot) => {
      const sel = document.querySelector(`select[data-diymod="${slot}"]`);
      const opt = [...sel.options].find((o) => o.value);
      if (!opt) return null;
      sel.value = opt.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return opt.value;
    }, id);
    assert.ok(want, '没有可挑的模组');
    await sleep(1700);
    const s = await serverState();
    const e = (s.extra || []).find((x) => x.pick && x.pick.charId === 'char_003_kalts');
    assert.equal(e?.pick?.uniEquipId, want, `服务端收到的是 ${JSON.stringify(e?.pick)}`);
  });
  await check('原型干员的模组也挑不动（数据里就没给）', async () => {
    const off = await page.evaluate((sl) => {
      const sel = document.querySelector(`select[data-diymod="${sl}"]`);
      return sel ? { disabled: !!sel.disabled, text: sel.options[0]?.textContent || '' } : null;
    }, SLOT6);
    assert.ok(off && off.disabled, `原型干员的模组下拉该是灰的：${JSON.stringify(off)}`);
  });

  await check('原型干员的技能是数据里定的：下拉是灰的，并写明原因', async () => {
    const off = await page.evaluate((sl) => {
      const sel = document.querySelector(`select[data-diyskill="${sl}"]`);
      return sel ? { disabled: !!sel.disabled, text: sel.options[0]?.textContent || '' } : null;
    }, SLOT6);
    assert.ok(off && off.disabled, `原型干员的技能下拉该是灰的：${JSON.stringify(off)}`);
    assert.match(off.text, /原型干员/, `没写明原因：${off.text}`);
  });

  await check('移除自造位子：服务端跟着收回去', async () => {
    await page.evaluate(() => document.querySelector('.spmod-sbbtn[data-diyremove]')?.click());
    await sleep(1800);
    const st = await page.evaluate(() => globalThis.__SP__.store.get().match.private);
    assert.equal((st.modDiy?.extra || []).length, 0, `extra 没收回去：${JSON.stringify(st.extra)}`);
    assert.ok(!Object.keys(st.diy || {}).some((id) => id.startsWith('mod_diy_')), `picks 里还留着：${Object.keys(st.diy || {}).join(',')}`);
  });

  console.log('[真的生效吗：1 阶自造位子，买下来摆上场，看盟约栏]');
  let liveId = null;
  await check('1 阶自造位子 + 改过数值的特质：买下来的那一刻就按我填的数叠层', async () => {
    await page.evaluate(() => document.querySelector('.spmod-sbbtn[data-diyadd]')?.click());
    await sleep(1100);
    await page.evaluate(() => {
      const s = document.querySelector('select[data-diytier]');
      s.value = '1';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await sleep(1100);
    await page.evaluate(() => {
      const i = document.querySelector('input[data-diypickquery]');
      if (i) { i.value = '预备干员-重装'; i.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(900);
    const picked = await page.evaluate(() => {
      const el = document.querySelector('.spmod-unit[data-diyop="char_602_cdfend"]');
      if (!el) return 'no candidate';
      el.click();
      return 'ok';
    });
    assert.equal(picked, 'ok', `挑不到预备干员-重装：${picked}`);
    await sleep(1700);
    liveId = await page.evaluate(() => Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_')));
    assert.ok(liveId, '自造位子没落到这一座');

    // 「获得时自身所属盟约层数+2」那条特质：新位子自带默认，可能已经挂上了；没挂就点上去
    const hadIt = await page.evaluate((s, g) => {
      const row = document.querySelector(`.spmod-diyslot[data-slot="${s}"]`);
      return [...row.querySelectorAll('.spmod-garchip')].some((c) => c.getAttribute('data-garrison') === g);
    }, liveId, GARRISON);
    if (!hadIt) {
      await page.evaluate((s) => document.querySelector(`.spmod-sbbtn[data-garadd="${s}"]`)?.click(), liveId);
      await sleep(900);
      await page.evaluate((s, g) => {
        const i = document.querySelector(`.spmod-diyslot[data-slot="${s}"] input.spmod-search[data-garquery]`);
        if (i) { i.value = g; i.dispatchEvent(new Event('input', { bubbles: true })); }
      }, liveId, GARRISON);
      await sleep(900);
      const added = await page.evaluate((s, g) => {
        const el = document.querySelector(`.spmod-gar[data-slot="${s}"][data-garrison="${g}"]`);
        if (!el) return 'no candidate';
        el.click();
        return 'ok';
      }, liveId, GARRISON);
      assert.equal(added, 'ok', `没找到那条特质：${added}`);
      await sleep(1400);
    }
    await page.evaluate((s) => document.querySelector(`.spmod-sbbtn[data-diynum="${s}"]`)?.click(), liveId);
    await sleep(900);
    const numHit = await page.evaluate((s, g) => {
      const block = document.querySelector(`.spmod-diyslot[data-slot="${s}"] .spmod-bbsection[data-bb="garrison:${g}"]`);
      const inp = block && block.querySelector(`input[data-field^="${g}:"]`);
      if (!inp) return 'no input';
      inp.value = '9';
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return inp.getAttribute('data-field');
    }, liveId, GARRISON);
    assert.ok(!String(numHit).startsWith('no '), `特质数值的输入框没找到：${numHit}`);
    await sleep(1500);

    const snap = () => page.evaluate(() => {
      const p = globalThis.__SP__.store.get().match.private;
      const b = p.bonds || [];
      const e = b.find((x) => x.bondId === 'emptyShip');
      return {
        layers: e ? e.layers : 0,
        count: e ? e.count : 0,
        list: b.map((x) => `${x.bondId}:${x.count}/${x.layers}${x.off ? '(off)' : ''}`).join(' '),
        hand: (p.hand || []).filter(Boolean).map((q) => q.id).join(','),
        modDiy: JSON.stringify(p.modDiy || null).slice(0, 300),
      };
    });
    const before = await snap();
    const bought = await page.evaluate((x) => globalThis.__SP__.net.request('g.modBuy', { id: x }).then(() => 'ok', (e) => String(e?.detail || e?.code || e)), liveId);
    assert.equal(bought, 'ok', `买不下来：${bought}`);
    await sleep(1600);
    const after = await snap();
    assert.equal(after.layers - before.layers, 9,
      `特质没按我填的数值叠：前 ${JSON.stringify(before)}\n 后 ${JSON.stringify(after)}`);
  });
  await check('摆到场上：盟约栏真的数到它；把盟约勾掉，栏里就少一个', async () => {
    assert.ok(liveId, '上一条没建出位子');
    const uid = await page.evaluate((x) => {
      const h = globalThis.__SP__.store.get().match.private.hand || [];
      const p = h.find((q) => q && q.id === x);
      return p ? p.uid : null;
    }, liveId);
    assert.ok(uid, '手牌里没有它');
    // 摆位走沙盒的「解锁布置地块」，一个请求就够：拿手牌里那一枚往棋盘上一放
    const unlocked = await page.evaluate(() => globalThis.__SP__.net.request('g.modPlace', { on: true, cap: null })
      .then(() => 'ok', (e) => String(e?.detail || e?.code || e)));
    assert.equal(unlocked, 'ok', `解锁布置地块没开起来：${unlocked}`);
    await sleep(800);
    const moved = await page.evaluate(async (u) => {
      for (const [row, col] of [[10, 10], [10, 9], [9, 10], [11, 10], [10, 11]]) {
        const r = await globalThis.__SP__.net.request('g.move', { uid: u, to: { area: 'board', row, col }, dir: 'RIGHT' })
          .then(() => 'ok', (e) => String(e?.detail || e?.code || e));
        if (r === 'ok') return `ok ${row},${col}`;
      }
      return 'no tile';
    }, uid);
    assert.ok(String(moved).startsWith('ok'), `摆不上场：${moved}`);
    await sleep(1600);
    const count = () => page.evaluate((x) => {
      const b = globalThis.__SP__.store.get().match.private.bonds || [];
      const e = b.find((q) => q.bondId === 'emptyShip');
      return e ? e.count : 0;
    }, liveId);
    assert.equal(await count(), 1, '摆上场了，盟约栏却没数到它');

    // 切成「替换」再点另一条盟约：它就不该再算协防了（新位子默认是「叠加」，点一下只会再加一条）
    await page.evaluate((sl) => {
      const row = document.querySelector(`.spmod-diyslot[data-slot="${sl}"]`);
      row?.querySelector('.spmod-segbtn[data-mode="replace"]')?.click();
    }, liveId);
    await sleep(1500);
    assert.equal(await clickBond(liveId, 'yanShip'), 'ok', '那一行没有盟约的勾');
    await sleep(1800);
    const after = await page.evaluate(() => {
      const p = globalThis.__SP__.store.get().match.private;
      const e = (p.bonds || []).find((q) => q.bondId === 'emptyShip');
      return e ? e.count : 0;
    });
    assert.equal(after, 0, '换成别的盟约之后还算协防干员');
    // the piece's own card is composed on THIS side from the store's own tables, so the store has to carry the kit too
    const shown = await page.evaluate((id) => {
      const p = globalThis.__SP__.store.get().match.private;
      const charId = p.diy?.[id]?.charId;
      return globalThis.__SP__.data.get('backups')?.diy?.operators?.[charId]?.bonds || null;
    }, liveId);
    assert.ok(Array.isArray(shown) && shown.includes('yanShip') && !shown.includes('emptyShip'),
      `本机的卡片那份没跟上：${JSON.stringify(shown)}`);
    await page.evaluate(() => globalThis.__SP__.net.request('g.modPlace', { on: false, cap: null }).catch(() => {}));
  });

  console.log('[还原与持久化]');
  await check('还原：位子回到干员本来的盟约、且不带特质', async () => {
    await page.evaluate((s) => document.querySelector(`.spmod-diyslot[data-slot="${s}"] .spmod-sbbtn[data-diyreset]`)?.click(), SLOT5);
    await sleep(1500);
    const s = await serverState();
    assert.equal(s.slots[SLOT5], undefined, `还原之后服务端还留着 ${JSON.stringify(s.slots[SLOT5])}`);
    const kept = await page.evaluate((sl) => {
      const row = document.querySelector(`.spmod-diyslot[data-slot="${sl}"]`);
      return {
        on: [...row.querySelectorAll('.spmod-bondchip.is-on')].length,
        gars: row.querySelectorAll('.spmod-garchip').length,
      };
    }, SLOT5);
    assert.equal(kept.on, 0, '还原之后盟约的勾没清掉');
    assert.equal(kept.gars, 0, '还原之后特质还留着');
  });
  await check('配置按浏览器记住，刷新后自己回到服务端', async () => {
    assert.equal(await clickBond(SLOT5, BOND), 'ok');
    await sleep(1500);
    await page.reload({ waitUntil: 'networkidle2' });
    await sleep(2500);
    if ((await phase()) !== 'PREP') await waitPhase('PREP', 30000);
    await sleep(2500); // the push rides the first private view of the reconnected match
    const s = await serverState();
    assert.deepEqual(s.slots[SLOT5]?.bonds, [BOND], `刷新后服务端是 ${JSON.stringify(s.slots[SLOT5])}`);
  });
  // ---- the master switches (总开关) -------------------------------------------------------------------
  // The panel page and the server's rollback, end to end: turning the group off must take back what is already in
  // effect, not merely stop accepting new settings.
  console.log('[总开关]');
  await check('总开关页列出每一组，关掉「自选位」就把已经配好的 kit 整个撤回去', async () => {
    // the previous check reloaded the page, so the panel is closed and the head is not in the DOM yet
    await page.evaluate(() => document.querySelector('.spmod-fab')?.click());
    await sleep(900);
    assert.ok(await clickText('^开关$', '.spmod-segbtn'), '表头里没有「开关」这个页签');
    await sleep(900);
    const rows = await page.evaluate(() => [...document.querySelectorAll('.spmod-enablerow')].map((r) => r.getAttribute('data-enable')));
    for (const k of ['shop', 'sandboxBands', 'sandboxPlace', 'sandboxUnit', 'diy', 'diyExtra', 'shopFilter']) {
      assert.ok(rows.includes(k), `开关页少了「${k}」这一组（列出的是 ${rows.join(',')}）`);
    }
    const before = await serverState();
    assert.deepEqual(before.slots[SLOT5]?.bonds, [BOND], `前置：这个位子本该配着：${JSON.stringify(before.slots)}`);
    assert.equal(await page.evaluate(() => {
      const b = document.querySelector('.spmod-enablerow[data-enable="diy"] input');
      if (!b) return 'no box';
      b.click();
      return 'ok';
    }), 'ok', '找不到「自选位」那一行的勾');
    await sleep(2000);
    const after = await serverState();
    assert.equal(Object.keys(after.slots).length, 0, `关掉之后服务端还留着 kit：${JSON.stringify(after.slots)}`);
    const echo = await page.evaluate(() => globalThis.__SP__.store.get().match.private.modEnable);
    assert.equal(echo?.diy, false, `服务端回显的开关不对：${JSON.stringify(echo)}`);
    // and the page says so too, without a reload
    const dim = await page.evaluate(() => !!document.querySelector('.spmod-enablerow[data-enable="diy"] input:not(:checked)'));
    assert.ok(dim, '面板上那个勾没跟着变');
    // put it back, so the next run of this file starts from the defaults the others assume
    await page.evaluate(() => document.querySelector('.spmod-enablerow[data-enable="diy"] input')?.click());
    await sleep(1500);
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().match.private.modEnable?.diy), true, '打开了但服务端没跟上');
  });
  // The 自造位子 are composed ON THE CLIENT and injected into the game's own 自选编队 screen, so switching the group off
  // has to stop the client injecting them too — not merely stop the server accepting new ones. This is the regression:
  // the slots used to linger after the switch went off (visible, but refusing every pick).
  await check('总开关：关掉「自造位子」，面板和这一局的数据里都不再有它', async () => {
    assert.ok(await clickText('^自选位$', '.spmod-segbtn'), '表头里没有「自选位」页签');
    await sleep(900);
    await page.evaluate(() => document.querySelector('.spmod-sbbtn[data-diyadd]')?.click());
    await sleep(1000);
    await page.evaluate(() => {
      const inp = document.querySelector('input[data-diypickquery]');
      if (inp) { inp.value = '预备干员'; inp.dispatchEvent(new Event('input', { bubbles: true })); }
    });
    await sleep(800);
    assert.equal(await page.evaluate(() => {
      const el = document.querySelector('.spmod-unit[data-diyop="char_601_cguard"]');
      if (!el) return 'no candidate';
      el.click();
      return 'ok';
    }), 'ok', '挑不到预备干员-近卫');
    await sleep(1800);
    const id = await page.evaluate(() => Object.keys(globalThis.__SP__.store.get().match.private.diy || {}).find((x) => x.startsWith('mod_diy_')));
    assert.ok(id, '自造位子没落到这一座');
    const carried = () => page.evaluate((x) => !!globalThis.__SP__.data.get('chess')?.[x], id);
    assert.ok(await carried(), '前置：本机的 chess 表里本该挂着这个自造位子');

    assert.ok(await clickText('^开关$', '.spmod-segbtn'), '表头里没有「开关」页签');
    await sleep(900);
    await page.evaluate(() => document.querySelector('.spmod-enablerow[data-enable="diyExtra"] input')?.click());
    await sleep(2200);
    const st = await page.evaluate(() => globalThis.__SP__.store.get().match.private);
    assert.equal((st.modDiy?.extra || []).length, 0, `服务端还留着 extra：${JSON.stringify(st.modDiy?.extra)}`);
    assert.equal(st.modEnable?.diyExtra, false, `服务端回显没跟上：${st.modEnable?.diyExtra}`);
    assert.equal(await carried(), false, '本机的 chess 表里还挂着那个自造位子（游戏界面会照样把它画出来）');
    assert.ok(await clickText('^自选位$', '.spmod-segbtn'), '表头里没有「自选位」页签');
    await sleep(900);
    assert.equal(await page.evaluate(() => !!document.querySelector('.spmod-sbbtn[data-diyadd]')), false, '关掉之后面板还留着「＋ 加一个位子」');
    assert.equal(await page.evaluate(() => document.querySelectorAll('.spmod-offnote').length > 0), true, '关掉之后那一节没有换成说明文字');

    // turning it back on brings the group (and its kept config) back
    assert.ok(await clickText('^开关$', '.spmod-segbtn'), '表头里没有「开关」页签');
    await sleep(900);
    await page.evaluate(() => document.querySelector('.spmod-enablerow[data-enable="diyExtra"] input')?.click());
    await sleep(2200);
    assert.equal(await carried(), true, '重新打开后自造位子没回来');
    assert.equal(await page.evaluate(() => globalThis.__SP__.store.get().match.private.modEnable?.diyExtra), true, '打开了但服务端没跟上');
  });
  await page.evaluate(() => { localStorage.removeItem('spmod.diySlots'); localStorage.removeItem('spmod.enable'); });
} catch (e) {
  fail++;
  console.log(`  ✗ 流程中断：${e.message}`);
  await page.screenshot({ path: path.join(os.tmpdir(), 'luck-diyslots-stuck.png') }).catch(() => {});
} finally {
  await browser.close().catch(() => {});
  await stop();
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
if (fail) console.log(`\n启动器输出：\n${out.slice(-1200)}`);
process.exit(fail ? 1 : 0);
