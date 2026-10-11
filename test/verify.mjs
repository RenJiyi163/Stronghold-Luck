// verify.mjs — end-to-end check of the pick-your-own shop against the real engine (no browser needed).
//
//   node test/verify.mjs [--game <dir>]
//
// Installs the patch into a bare Node process and drives a real Match through the game's own test harness
// (test/match/harness.js), then asserts the shop behaviour. Nothing here touches the game's files.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const gameArg = process.argv.indexOf('--game');
const cfg = JSON.parse(await fs.promises.readFile(path.join(HERE, '..', 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(gameArg >= 0 ? process.argv[gameArg + 1] : cfg.gameRoot || 'D:\\Stronghold-Protocol');
const imp = (rel) => import(pathToFileURL(path.join(gameRoot, rel)).href);

const log = { info: (m) => console.log('  ·', m), warn: (m) => console.log('  !', m), error: (m) => console.log('  x', m), debug: () => {} };

let pass = 0;
let fail = 0;
function check(name, fn) {
  try {
    fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}

console.log(`\nStronghold-Luck 自检 — 游戏目录 ${gameRoot}\n`);

const { installServerPatch, PICK_TYPE, BUY_TYPE, CONFIG_TYPE, SPEED_TYPE, AUTO_TYPE, MOD_LIMIT } = await import(pathToFileURL(path.join(HERE, '..', 'src', 'server-patch.mjs')).href);
// pickLimit 0 = 不限 here on purpose: the [自选]/[直购] blocks test the store mechanics, not the budget, which gets its
// own block below (the shipped default is 3, set from mod.config.json by the launcher). record → a throwaway temp dir.
const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-verify-'));
const status = await installServerPatch(gameRoot, log, { pickLimit: 0, record: true, logDir: LOG_DIR });
assert.ok(status.ok, `patch anchors missing: ${status.missing.join(', ')}`);
assert.ok(status.logFile, 'recorder did not open a log file');

const { C2S, validateC2S } = await imp('shared/protocol.js');
const { DATA, makeMatch, checkInvariants } = await imp('test/match/harness.js');

console.log('\n[意图注册]');
check('C2S 里有 g.modPick（服务端与浏览器共用同一张表）', () => {
  assert.ok(Object.hasOwn(C2S, PICK_TYPE));
  assert.equal(typeof C2S[PICK_TYPE].slot, 'function');
});
check('validateC2S 接受本意图、拒绝畸形负载', () => {
  assert.equal(validateC2S({ t: PICK_TYPE, slot: 0, id: 'chess_char_3_01_a' }), null);
  assert.ok(validateC2S({ t: PICK_TYPE, slot: '0', id: 'x' }));
  assert.ok(validateC2S({ t: PICK_TYPE, slot: 0, id: 42 }));
  assert.ok(validateC2S({ t: 'g.nopeNotReal', slot: 0, id: 'x' }));
});
check('C2S 里有 g.modBuy / g.modConfig', () => {
  assert.ok(Object.hasOwn(C2S, BUY_TYPE));
  assert.ok(Object.hasOwn(C2S, CONFIG_TYPE));
});
check('validateC2S 接受直购/配置、拒绝畸形负载', () => {
  assert.equal(validateC2S({ t: BUY_TYPE, id: 'chess_char_3_01_a' }), null);
  assert.ok(validateC2S({ t: BUY_TYPE, id: 42 }));
  assert.equal(validateC2S({ t: CONFIG_TYPE, pickLimit: 3 }), null);
  assert.equal(validateC2S({ t: CONFIG_TYPE, pickLimit: 0 }), null);
  assert.ok(validateC2S({ t: CONFIG_TYPE, pickLimit: -1 }));
  assert.ok(validateC2S({ t: CONFIG_TYPE, pickLimit: 1.5 }));
});

console.log('\n[自选：写入槽位]');
const h = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 6 }).start();
h.toPrep(1);
const m = h.m;
const ps = h.ps('p_0');
ps.funds = 50;
const pickable = ps.privateView().shop.modPickable;
assert.ok(pickable && Array.isArray(pickable.chess) && pickable.chess.length > 0, 'modPickable 随 privateView 下发');

const t1 = pickable.chess.find((id) => m.gd.tierOf(id) === 1);
// a real, in-pool, higher-tier base chess — straight from the data, so it exists regardless of the shop level
const t6 = Object.keys(DATA.chess).find((id) => {
  const c = DATA.chess[id];
  return c.visible && !c.isGolden && c.tier === 6 && m.pool.has(id) && m.pool.left(id) > 0;
});
assert.ok(t6, '数据里应该有 6 级干员');

check('privateView 带 shop.modPickable', () => assert.ok(pickable.chess.length > 0 && Array.isArray(pickable.item)));
// 自选编队 (0.2.0): a list of its own, so the preset rules above stay the preset rules — a seat without picks has an
// empty one (this harness builds a match without picks), and every entry carries its own 调度中心 gate.
// test/verify-diy-ui.mjs drives a real match that HAS picks, in the browser.
check('自选编队列表单独一份（diy），每条带自己的等级门槛', () => {
  assert.ok(Array.isArray(pickable.diy), 'pickable.diy 不是数组');
  for (const d of pickable.diy) {
    assert.equal(typeof d.id, 'string');
    assert.ok(Number.isInteger(d.level) && d.level > 0, `${d.id} 没有等级门槛`);
    assert.equal(typeof d.ok, 'boolean');
  }
});
check('可选列表全部在等级内', () => {
  for (const id of pickable.chess) assert.ok(m.gd.tierOf(id) <= ps.shop.level, `${id} tier ${m.gd.tierOf(id)} > ${ps.shop.level}`);
});
check('可选列表不含本局禁用干员', () => {
  const banned = new Set(m.pool.banned);
  for (const id of pickable.chess) assert.ok(!banned.has(id), `${id} 被禁用却出现在列表里`);
});

check('把 1 级干员写进 0 号槽', () => {
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t1 }), { ok: true });
  assert.equal(ps.shop.slots[0].id, t1);
  assert.equal(ps.shop.slots[0].kind, 'chess');
  assert.equal(ps.shop.slots[0].sold, false);
  assert.equal(ps.shop.slots[0].basePrice, m.gd.chessPrice(t1));
});
check('第二次写入：只改内容，不叠加', () => {
  const other = pickable.chess.find((id) => id !== t1 && m.gd.tierOf(id) === 1);
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: other }), { ok: true });
  assert.equal(ps.shop.slots[0].id, other);
});
check('等级不够 → 拒绝', () => {
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t6 }), { error: 'BAD_TARGET', detail: '调度中心等级不足' });
});
check('本局禁用的干员 → 拒（SOLD_OUT）', () => {
  const banned = m.pool.banned[0];
  assert.ok(banned, 'NORMAL 应该有被禁的干员');
  const r = m.handle('p_0', { t: PICK_TYPE, slot: 0, id: banned });
  assert.ok(r.error, `期望报错，实际 ${JSON.stringify(r)}`);
});
check('不存在的 id / 精锐 id → 拒绝', () => {
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: 'chess_nope_a' }).error);
  const anyBase = pickable.chess[0];
  const goldenId = m.gd.goldenIdOf(anyBase);
  if (goldenId) assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: goldenId }).error);
});
check('槽位号越界 → 拒绝', () => {
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: 99, id: t1 }).error);
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: -1, id: t1 }).error);
});

console.log('\n[买走之后]');
check('购买自选的槽位照常扣钱、进手牌', () => {
  const before = ps.funds;
  const price = ps.priceOf(ps.shop.slots[0]);
  assert.deepEqual(m.handle('p_0', { t: 'g.buy', slot: 0 }), { ok: true });
  assert.equal(ps.funds, before - price);
  assert.equal(ps.shop.slots[0].sold, true);
  assert.ok(ps.hand.some((p) => p && p.kind === 'chess'), '手牌里出现了这名干员');
});
check('已售出的槽位不能再自选', () => {
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t1 }), { error: 'BAD_TARGET', detail: '该槽位已售出' });
});
check('卡池不变量仍然成立', () => checkInvariants(m));

console.log('\n[等级解锁]');
check('满级后可以选 6 级干员', () => {
  ps.shop.level = 6;
  const p6 = ps.privateView().shop.modPickable.chess.find((id) => m.gd.tierOf(id) === 6);
  assert.ok(p6, '6 级列表里有 6 级干员');
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 1, id: p6 }), { ok: true });
  assert.equal(ps.shop.slots[1].id, p6);
  ps.shop.level = 1;
});

console.log('\n[装备槽]');
check('装备槽只收商店里的装备', () => {
  ps.shop.level = 1;
  ps.rollShop();
  const itemSlot = ps.shop.slots.length - 1;
  const good = ps.privateView().shop.modPickable.item[0];
  assert.ok(good, '有可选装备');
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: itemSlot, id: good }), { ok: true });
  assert.equal(ps.shop.slots[itemSlot].kind, 'item');
  assert.equal(ps.shop.slots[itemSlot].id, good);
});
check('装备槽拒收干员', () => {
  const itemSlot = ps.shop.slots.length - 1;
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: itemSlot, id: t1 }).error);
});
check('干员槽拒收装备', () => {
  const good = ps.privateView().shop.modPickable.item[0];
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: good }).error);
});

console.log('\n[直购]');
check('直购干员：扣钱、进手牌，不占槽位', () => {
  const pk = ps.privateView().shop.modPickable;
  const id = pk.chess.find((x) => m.gd.tierOf(x) === 1);
  assert.ok(id, '有 1 级可选干员');
  const price = ps.priceOf({ kind: 'chess', id, basePrice: m.gd.chessPrice(id) });
  const slotsBefore = ps.shop.slots.map((s) => (s ? s.id : null));
  ps.funds = 50;
  const before = ps.funds;
  assert.deepEqual(m.handle('p_0', { t: BUY_TYPE, id }), { ok: true });
  assert.equal(ps.funds, before - price);
  assert.ok(ps.hand.some((p) => p && p.kind === 'chess' && m.gd.baseIdOf(p.id) === id), '手牌里出现了这名干员');
  assert.deepEqual(ps.shop.slots.map((s) => (s ? s.id : null)), slotsBefore, '槽位一个都没动');
});
check('直购装备：扣钱、进手牌', () => {
  const pk = ps.privateView().shop.modPickable;
  const id = pk.item[0];
  assert.ok(id, '有可选装备');
  const price = ps.priceOf({ kind: 'item', id, basePrice: m.gd.itemPrice(id) });
  ps.funds = 50;
  const before = ps.funds;
  assert.deepEqual(m.handle('p_0', { t: BUY_TYPE, id }), { ok: true });
  assert.equal(ps.funds, before - price);
  assert.ok(ps.hand.some((p) => p && p.kind === 'item' && p.id === id), '手牌里出现了这件装备');
});
check('直购：等级不够 → 拒绝', () => {
  ps.shop.level = 1;
  assert.ok(m.handle('p_0', { t: BUY_TYPE, id: t6 }).error);
});
check('直购：不存在的 id → 拒绝', () => {
  assert.ok(m.handle('p_0', { t: BUY_TYPE, id: 'chess_nope_a' }).error);
});
check('直购后卡池不变量仍成立', () => checkInvariants(m));

console.log('\n[每回合额度]');
check('privateView 带 quota', () => {
  const q = ps.privateView().shop.modPickable.quota;
  assert.ok(q && Number.isInteger(q.used) && Number.isInteger(q.limit), JSON.stringify(q));
});
check('上限 3：三次动作内成功，第四次起 MOD_LIMIT（自选与直购共用）', () => {
  h.toPrep(2); // 进第 2 回合，额度随回合重置
  ps.funds = 60;
  assert.deepEqual(m.handle('p_0', { t: CONFIG_TYPE, pickLimit: 3 }), { ok: true });
  const pk = ps.privateView().shop.modPickable;
  const t1 = pk.chess.filter((x) => m.gd.tierOf(x) === 1);
  assert.ok(t1.length >= 2 && pk.item.length >= 1, 'round 2 有可选项');
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t1[0] }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: 1, id: t1[1] }), { ok: true });
  assert.deepEqual(m.handle('p_0', { t: PICK_TYPE, slot: ps.shop.slots.length - 1, id: pk.item[0] }), { ok: true });
  assert.equal(m.handle('p_0', { t: BUY_TYPE, id: t1[0] }).error, MOD_LIMIT, '第 4 次直购应被拒');
  assert.equal(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t1[0] }).error, MOD_LIMIT, '第 4 次自选应被拒');
});
check('改回 0 = 不限，继续可用', () => {
  assert.deepEqual(m.handle('p_0', { t: CONFIG_TYPE, pickLimit: 0 }), { ok: true });
  const id = ps.privateView().shop.modPickable.chess[0];
  assert.deepEqual(m.handle('p_0', { t: BUY_TYPE, id }), { ok: true });
  assert.ok(checkInvariants(m));
});

console.log('\n[原版行为不受影响]');
check('未知意图照旧 BAD_MSG（我们的包裹会放行给原实现）', () => {
  assert.deepEqual(m.handle('p_0', { t: 'g.notARealIntent' }), { error: 'BAD_MSG' });
});
check('原商店的随机刷新仍然工作', () => {
  const before = ps.shop.slots.map((s) => s?.id).join(',');
  ps.funds = 50;
  assert.deepEqual(m.handle('p_0', { t: 'g.refresh' }), { ok: true });
  assert.notEqual(ps.shop.slots.map((s) => s?.id).join(','), before);
});
check('准备就绪后不能再自选', () => {
  if (!ps.tempEmpty) ps.resolveTemp();
  m.handle('p_0', { t: 'g.ready', ready: true });
  assert.ok(m.handle('p_0', { t: PICK_TYPE, slot: 0, id: t1 }).error);
  m.handle('p_0', { t: 'g.ready', ready: false });
});

m.dispose();

console.log('\n[倍速]');
check('C2S 里有 g.modSpeed，校验范围 1–16 的整数', () => {
  assert.ok(Object.hasOwn(C2S, SPEED_TYPE));
  assert.equal(validateC2S({ t: SPEED_TYPE, n: 4 }), null);
  assert.ok(validateC2S({ t: SPEED_TYPE, n: 0 }));
  assert.ok(validateC2S({ t: SPEED_TYPE, n: 17 }));
  assert.ok(validateC2S({ t: SPEED_TYPE, n: 2.5 }));
  assert.ok(validateC2S({ t: SPEED_TYPE, n: '4' }));
});

{
  // a match of its own: this block swaps m.fields about, and the one above has already been disposed
  const hs = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 11 }).start();
  hs.toPrep(1);
  const ms = hs.m;
  const mps = hs.ps('p_0');

  check('privateView 带 modSpeed（服务端真值，面板据此点亮按钮）', () => {
    assert.equal(mps.privateView().modSpeed, ms.gameSpeed);
  });
  check('g.modSpeed 改的是 match.gameSpeed', () => {
    assert.deepEqual(ms.handle('p_0', { t: SPEED_TYPE, n: 4 }), { ok: true });
    assert.equal(ms.gameSpeed, 4);
    assert.equal(mps.privateView().modSpeed, 4);
  });
  check('越界 / 非整数 → 拒绝，且不改动', () => {
    assert.ok(ms.handle('p_0', { t: SPEED_TYPE, n: 0 }).error);
    assert.ok(ms.handle('p_0', { t: SPEED_TYPE, n: 17 }).error);
    assert.ok(ms.handle('p_0', { t: SPEED_TYPE, n: 2.5 }).error);
    assert.equal(ms.gameSpeed, 4);
  });

  // a live client battle: the field clock is game time, and the whole point of the rescale is that it does not
  // jump when the speed changes (a jump would skip or stall ticks — and so change the battle)
  const LIMIT = 110; // spec.timeLimit of the fake field below, in game seconds
  const GRACE = 15000; // RESULT_GRACE_MS (server/match/fields.js)
  const field = () => ({
    fieldId: 'f_speed', battleId: 'b_speed', kind: 'normal', mode: 'client', authority: 'p_0', cc: true,
    players: ['p_0'], spec: { timeLimit: LIMIT, players: [], kind: 'normal' }, done: false,
    startAt: ms.sched.now() - 5000, // 5 real seconds ago
  });
  const drop = (f) => { if (f.deadlineTimer) { ms.cancel(f.deadlineTimer); f.deadlineTimer = null; } };

  check('改倍速：战场时钟不跳，游戏时间连续', () => {
    ms.gameSpeed = 2;
    const f = field();
    ms.fields = [f];
    const gt = ms._fieldElapsed(f);
    assert.ok(Math.abs(gt - 10) < 0.2, `5 秒 ×2 应该是 10 游戏秒，实际 ${gt}`);
    assert.deepEqual(ms.handle('p_0', { t: SPEED_TYPE, n: 8 }), { ok: true });
    assert.equal(ms.gameSpeed, 8);
    assert.ok(Math.abs(ms._fieldElapsed(f) - gt) < 0.05, `时钟跳了：${gt} → ${ms._fieldElapsed(f)}`);
    drop(f);
    ms.fields = [];
  });

  check('新发出的 b.start 带上新倍速', () => {
    ms.gameSpeed = 8;
    assert.equal(ms._startMsg(field(), 'p_0').speed, 8);
  });

  check('改倍速：结算期限按「剩下的游戏时间 ÷ 新倍速」重算', () => {
    ms.gameSpeed = 8;
    const f = field();
    ms.fields = [f];
    const gt = ms._fieldElapsed(f); // 5 s × 8 = 40 游戏秒，剩 70
    assert.ok(Math.abs(gt - 40) < 0.3, `应该是 40 游戏秒，实际 ${gt}`);
    const remain = LIMIT - gt;
    const wait = (n) => f.startAt + (LIMIT / n) * 1000 + GRACE - ms.sched.now(); // === the armed deadline − now
    // slow down: the deadline must move out, or the server would take over a battle still on screen
    assert.deepEqual(ms.handle('p_0', { t: SPEED_TYPE, n: 1 }), { ok: true });
    const w1 = wait(1);
    assert.ok(Math.abs(w1 - (remain * 1000 + GRACE)) < 80, `1× 应剩约 ${remain.toFixed(0)}s，实际 ${((w1 - GRACE) / 1000).toFixed(1)}s`);
    // …and speed back up: proportionally sooner
    assert.deepEqual(ms.handle('p_0', { t: SPEED_TYPE, n: 8 }), { ok: true });
    const w8 = wait(8);
    assert.ok(Math.abs(w8 - (remain / 8 * 1000 + GRACE)) < 80, `8× 应剩约 ${(remain / 8).toFixed(1)}s，实际 ${((w8 - GRACE) / 1000).toFixed(1)}s`);
    assert.ok(Math.abs((w1 - GRACE) - 8 * (w8 - GRACE)) < 200, `慢下来以后期限没有按比例往后推：${w1} vs ${w8}`);
    drop(f);
    ms.fields = [];
  });

  ms.gameSpeed = 2;
  ms.dispose();
}

console.log('\n[自动倒转]');

check('C2S 里有 g.modAuto，五个字段一并校验', () => {
  assert.ok(Object.hasOwn(C2S, AUTO_TYPE));
  const ok = { t: AUTO_TYPE, on: true, cardId: 'chess_char_3_13_a', cycles: 5, equipCoins: true, idCard: false };
  assert.equal(validateC2S(ok), null);
  assert.ok(validateC2S({ ...ok, on: 'yes' }));
  assert.ok(validateC2S({ ...ok, cardId: '' }));
  assert.ok(validateC2S({ ...ok, cycles: 0 }));
  assert.ok(validateC2S({ ...ok, equipCoins: 1 }));
});

{
  // a match of its own: the loop buys and sells, so it must not run on the disposed/borrowed ones above
  const ha = makeMatch({ mode: 'solo', difficulty: 'NORMAL', seed: 21 }).start();
  ha.toPrep(3);
  const ma = ha.m;
  const ps = ha.ps('p_0');
  ps.shop.level = 6;
  ps.funds = 200;

  // a stable carrier for 商业包装方案 (the band's "合同"): the loop only ever touches what IT buys, so this
  // operator — bought once and kept — is what makes the every-8-sells payoff fire while 至简 comes and goes
  const pick = ps.privateView().shop.modPickable.chess.filter((id) => id !== 'chess_char_3_13_a');
  ps.modBuyDirect(pick.find((id) => ps.gd.tierOf(id) === 1) || pick[0]);
  const carrier = ps.allChess()[0];
  ps.acquireItem('chess_item_5_07_e_a', { source: 'test' });
  const pack = ps.hand.find((p) => p && p.id === 'chess_item_5_07_e_a');
  assert.ok(carrier && pack, `造不出「商业包装方案」的承载者（买到了 ${carrier && carrier.id}，道具 ${!!pack}）`);
  ps.equip(pack.uid, carrier.uid);

  const funds0 = ps.funds;
  const chess0 = ps.allChess().length;
  const auto = (over = {}) => ({ t: AUTO_TYPE, on: true, cardId: 'chess_char_3_13_a', cycles: 20, equipCoins: true, idCard: false, ...over });

  check('modPickable.pool = 本局协议里有的卡，与等级无关、不含隐藏卡', () => {
    const pk = ps.privateView().shop.modPickable;
    assert.ok(Array.isArray(pk.pool) && pk.pool.length > 0, 'privateView 没带 pool');
    assert.ok(pk.pool.every((id) => ma.gd.chess(id)?.visible), 'pool 里有隐藏卡（visible:false）');
    assert.ok(!pk.pool.includes('chess_char_1_05_a'), '红豆（隐藏卡）混进了 pool');
    assert.ok(pk.pool.every((id) => ma.pool.has(id)), 'pool 里有本局禁用的卡');
    // 等级只筛 chess（现在买得到的），不筛 pool：开局等级 1，自动倒转的目标表照旧是全本局的
    ps.shop.level = 1;
    const low = ps.privateView().shop.modPickable;
    assert.ok(low.pool.some((id) => ma.gd.tierOf(id) > 1), 'pool 跟着等级一起缩水了');
    assert.ok(low.pool.every((id) => low.chess.includes(id) || ma.gd.tierOf(id) > 1 || ma.pool.left(id) < 1),
      'chess 里混进了 pool 外、又没被等级/存量理由排除的卡');
    ps.shop.level = 6;
  });

  check('跑一批：接受、资金不减、没吃每回合额度', () => {
    assert.deepEqual(ma.handle('p_0', auto()), { ok: true });
    assert.ok(ps.funds >= funds0, `资金掉了：${funds0} → ${ps.funds}`);
    const view = ps.privateView();
    assert.equal(view.shop.modPickable.quota.used, 0, '额度被自动循环吃掉了');
    assert.ok(view.modAuto && view.modAuto.done > 0, `没跑动：${JSON.stringify(view.modAuto)}`);
  });

  check('只卖自己买的：至简没留在手上，且卖满 8 次白嫖到了干员', () => {
    const own = ps.allChess();
    assert.ok(!own.some((p) => p.id === 'chess_char_3_13_a'), '循环买进来的至简没卖干净');
    assert.ok(own.length > chess0, `卖满 8 次没白嫖到干员（${chess0} → ${own.length}）`);
  });

  check('目标卡会合成精锐时停手（不吞玩家已有的干员）', () => {
    const need = ps.gd.mergeCount('chess_char_3_13_a');
    for (let i = 1; i < need; i++) ps.acquireChess('chess_char_3_13_a', { source: 'test' }); // 再买一张就会合并
    assert.ok(ps.completesChessMerge('chess_char_3_13_a'), '没造出「再买会合并」的状态');
    const f = ps.funds;
    assert.deepEqual(ma.handle('p_0', auto({ cycles: 5 })), { ok: true });
    assert.equal(ps.funds, f, '明明会合并还买了一通');
    assert.equal(ps.privateView().modAuto.stop, 'would-merge');
  });

  check('掉落物：目标卡掉出来的币会被装备掉，不留手里', () => {
    ps.funds = 200;
    assert.deepEqual(ma.handle('p_0', auto({ cardId: 'chess_char_3_03_a', cycles: 3 })), { ok: true }); // 诗怀雅
    assert.ok(!ps.hand.some((p) => p && typeof p.id === 'string' && p.id.startsWith('chess_item_1_03_e')), '还留着没装备的盟约之币');
  });

  check('停表：on:false 只记录、不动手', () => {
    const f = ps.funds;
    assert.deepEqual(ma.handle('p_0', auto({ on: false })), { ok: true });
    assert.equal(ps.funds, f);
    assert.equal(ps.privateView().modAuto.on, false);
  });

  check('循环跑完，引擎不变量仍成立', () => { checkInvariants(ma); });
  ma.dispose();
}

console.log('\n[记录]');
const readLog = () => fs.readFileSync(status.logFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));

check('跑一局带 AI 的合作对局并回收日志', () => {
  const h2 = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 7, fake: true }).start();
  h2.toPrep(1);
  const ps2 = h2.ps('p_0');
  ps2.funds = 60;
  const idA = ps2.privateView().shop.modPickable.chess[0];
  h2.m.handle('p_0', { t: PICK_TYPE, slot: 0, id: idA });
  h2.m.handle('p_0', { t: PICK_TYPE, slot: 0, id: idA }); // 同槽同 id：成功但空转
  h2.toPrep(2);
  h2.m.dispose();
  assert.ok(readLog().length > 0, '日志是空的');
});

const events = readLog();
check('日志里有 start / round / prep / act / settle 五类事件', () => {
  const kinds = new Set(events.map((e) => e.k));
  for (const k of ['start', 'round', 'prep', 'act', 'settle']) assert.ok(kinds.has(k), `缺 ${k}：${[...kinds].join(',')}`);
});
check('AI 座位的动作也记了（ai:true）', () => {
  assert.ok(events.some((e) => e.k === 'act' && e.ai === true), '没有 AI 动作');
});
check('被拒的动作标了 ok:false 并带 err', () => {
  assert.ok(events.some((e) => e.k === 'act' && e.ok === false && e.err), '没有被拒的动作');
});
check('空转动作标了 noop:true', () => {
  assert.ok(events.some((e) => e.k === 'act' && e.fn === 'modPickSlot' && e.noop === true), '没有标出空转');
});
check('回合事件带本回合的来敌计划', () => {
  assert.ok(events.some((e) => e.k === 'round' && e.wave && (e.wave.spawns?.length || e.wave.boss)), 'round 事件没带来敌计划');
});
check('结算事件带 LP 前后', () => {
  assert.ok(events.some((e) => e.k === 'settle' && e.seats?.some((x) => Number.isInteger(x.lpBefore) && Number.isInteger(x.lpAfter))), 'settle 事件缺 LP 前后');
});

check('日志里有 auto 摘要（一批一行，不逐动作刷屏）', () => {
  assert.ok(events.some((e) => e.k === 'auto' && e.cardId), '没有 auto 事件');
});

console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
process.exit(fail ? 1 : 0);
