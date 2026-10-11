// verify-auto.mjs — 自动买卖 (g.modAuto) against a REAL match.
//
//   node test/verify-auto.mjs
//
// The loop's 'shop' mode is the one that has to work with no modification at all, so it cannot be checked against a
// stub: it needs a seat whose shop really rolls, whose `buy` / `sell` / `refresh` really charge and really move pool
// copies. This boots the engine in-process (the same way solver/runner.mjs does — a VirtualScheduler, so it runs in
// virtual time), installs the mod over it, plays into the first PREP, and then drives the intent.
//
// What it pins:
//   1. 'shop' mode buys a target out of a slot, cashes in what it drops, sells it back, and the loop makes progress;
//   2. 'shop' mode still works with EVERY master switch off (that is the whole point of it);
//   3. 'refresh' on hunts for a target that is not on the table, and gives up instead of spinning when it is not there;
//   4. 'direct' mode is refused once the 自选商店 group is off (it is a gameplay change and belongs to that group);
//   5. the run never touches anything it did not buy: a piece the seat already held is still there afterwards;
//   6. SEVERAL ticked targets share one loop — a batch buys more than one of them, keeping its own tally (`bought`);
//   7. the class gate: a 'deferred' target (payout lands next 休整期) is skipped while the shop's rolls are free and is
//      taken once they cost money — see ./auto-rules.js and the loop's `isRefreshFree`.

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fsp.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const imp = (rel) => import(pathToFileURL(path.join(gameRoot, rel)).href);
const { AUTO_CARDS } = await import(pathToFileURL(path.join(MOD_ROOT, 'public', 'auto-rules.js')).href);

const silent = { info() {}, warn() {}, error() {} };
const { installServerPatch, ENABLE_TYPE, AUTO_TYPE } = await import(pathToFileURL(path.join(MOD_ROOT, 'src', 'server-patch.mjs')).href);
const status = await installServerPatch(gameRoot, silent, { record: false });
assert.ok(status.ok, `installServerPatch 失败：缺失 ${status.missing.join(', ')}`);

const { Match } = await imp('server/match/Match.js');
const { getData } = await imp('server/data.js');
const { VirtualScheduler } = await imp('server/match/scheduler.js');
const { PHASE } = await imp('shared/constants.js');
const data = getData({ log: silent });

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e?.message || e}`);
  }
}

/** Step the virtual scheduler until `pred(m)` holds (or it runs dry). */
function stepTo(sched, m, pred, maxSteps = 500000) {
  let n = 0;
  while (!pred(m) && n++ < maxSteps) if (!sched.runNext()) break;
}

/**
 * A match with ONE human seat (the mod's intents are refused for a bot — `seatFor`), stepped into its first PREP.
 *
 * The lobby is driven through the game's own intents: the seat has to confirm the briefing and take a strategy, and
 * only the deadline for BATTLE_CHECK is left to the clock. Nothing here is a mod intent, so the mod is not involved in
 * reaching the state under test.
 */
function intoPrep(seed = 1) {
  const seats = [
    { seat: 0, playerId: 'p_0', name: 'P', isBot: false, connected: true },
    { seat: 1, playerId: 'p_1', name: 'B', isBot: true, connected: true },
  ];
  const sched = new VirtualScheduler({ instantCombat: true });
  const errors = [];
  const m = new Match({
    roomCode: 'AUTOTEST', mode: 'coop', difficulty: 'ABYSS', seats, seed, matchNo: 1, data,
    log: { info() {}, debug() {}, warn() {}, error: (...a) => errors.push(a.map(String).join(' ')) },
    scheduler: sched, send: () => true, broadcast: () => {}, onEnd: () => {},
  });
  const g = (msg) => Match.prototype.handle.call(m, 'p_0', msg);
  m.start();
  stepTo(sched, m, (x) => x.phase === PHASE.INFO_CHECK);
  g({ t: 'g.infoReady' });
  stepTo(sched, m, (x) => x.phase === PHASE.BAND_DRAFT);
  // A single-human match drafts UNTIMED (phases.js: `untimed = this.soloUntimed`), so nothing advances it on its own
  // and there is no skip to spend. Finish it the way the turn timer would: `finishBandDraft` hands the default band to
  // whoever has not picked. One internal call, and it keeps the harness out of the draft UI's business.
  if (m.phase === PHASE.BAND_DRAFT) m.finishBandDraft(false);
  stepTo(sched, m, (x) => x.phase === PHASE.PREP);
  assert.equal(m.phase, PHASE.PREP, `没有走到 PREP（停在 ${m.phase}）`);
  return { m, ps: m.players.get('p_0'), sched, errors };
}

const AUTO = (m, msg) => Match.prototype.handle.call(m, 'p_0', { t: AUTO_TYPE, ...msg });
const ENABLE = (m, features) => Match.prototype.handle.call(m, 'p_0', { t: ENABLE_TYPE, features });
const ALL_OFF = { shop: false, sandboxBands: false, sandboxPlace: false, sandboxUnit: false, diy: false, diyExtra: false, shopFilter: false };
const ALL_ON = { shop: true, sandboxBands: true, sandboxPlace: true, sandboxUnit: true, diy: true, diyExtra: true, shopFilter: true };

/** Put `id` into the `nth` unsold chess slot and hand the seat plenty of funds. Returns the slot index. */
function stock(ps, id, nth = 0) {
  const slots = ps.shop.slots || [];
  const free = [];
  for (let i = 0; i < slots.length; i++) if (slots[i] && slots[i].kind === 'chess' && !slots[i].sold) free.push(i);
  const idx = free[nth];
  if (idx == null) { throw new Error('这一局的商店里没有可用的干员槽位'); }
  slots[idx].id = id;
  slots[idx].basePrice = ps.gd.chessPrice(id); // the slot carries the price of whatever was rolled into it
  slots[idx].sold = false;
  ps.funds = 200;
  return idx;
}

/**
 * A catalogue card this match's data knows and the seat can buy right now (buying a copy must not merge into one we
 * already hold). It does not have to be whatever the shop rolled — `stock` writes it into a slot.
 */
function pickTarget(ps) {
  const c = AUTO_CARDS.find((x) => x.economy && ps.gd.chess(x.id) && !ps.completesChessMerge(x.id));
  assert.ok(c, '没有可用的倒转目标（目录里的经济牌这一版数据都不认，或被持有到会合并）');
  return c.id;
}

await check('商店模式：买到手 → 卖掉，循环推进，且不碰原有库存', async () => {
  const { m, ps } = intoPrep(11);
  ENABLE(m, ALL_ON);
  const target = pickTarget(ps);
  // a piece the loop must leave alone: a plain hand chess it did not buy
  const owned = [...ps.allChess()].map((p) => p.uid);
  stock(ps, target);
  const gold0 = ps.funds;
  const res = AUTO(m, { on: true, cardIds: [target], cycles: 5, equipCoins: true, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const echo = ps.privateView().modAuto;
  assert.ok(echo.done > 0, `一轮都没跑成（stop=${echo.stop}）`);
  assert.equal(echo.bought[target], echo.done, '买到的东西与 tally 对不上');
  assert.notEqual(ps.funds, gold0, '资金没有任何变化，说明买/卖没有真的发生');
  const after = [...ps.allChess()].map((p) => p.uid);
  for (const uid of owned) assert.ok(after.includes(uid), `循环卖掉了它没买的棋子（uid ${uid}）`);
});

await check('商店模式：总开关全关也照跑（它不改玩法）', async () => {
  const { m, ps } = intoPrep(12);
  ENABLE(m, ALL_OFF);
  const target = pickTarget(ps);
  stock(ps, target);
  const res = AUTO(m, { on: true, cardIds: [target], cycles: 5, equipCoins: true, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const echo = ps.privateView().modAuto;
  assert.ok(echo.done > 0, `全关之后跑不动了（stop=${echo.stop}）`);
  ENABLE(m, ALL_ON); // leave the process as we found it
});

await check('刷新：免费刷滚到上限收手，收费刷接着刷到钱光', async () => {
  const { m, ps } = intoPrep(13);
  ENABLE(m, ALL_ON);
  // A card the shop can never serve, so the hunt never ends by itself: the roll is tier-gated by the 调度中心
  // (`pool.roll({ maxTier: shop.level })`), so a card above this level's max tier never turns up.
  //
  // It also has to be a 当期 economy card: the 下期 ones are gated out while the rolls are free and the non-economy
  // ones while they are paid, so either arm would stop on the class gate before rolling at all.
  const maxTier = Number(ps.shop.level) || 1;
  const target = AUTO_CARDS.filter((c) => c.cls === 'now' && c.economy).map((c) => c.id)
    .find((id) => Number(ps.gd.chess(id)?.tier) > maxTier);
  assert.ok(target, `这一局的调度中心 Lv.${maxTier} 已经够得着所有当期经济牌，换一局`);
  const price = Number(ps.gd.refreshPrice);
  assert.ok(price > 0, '这一版的刷新价是 0，本测试的前提不成立');
  // 免费刷：一滚不花钱，不收手就会一直转，所以 40 次不见目标就停
  ps.shop.freeRefreshes = 0;
  ps.layers.miraShip = 100;
  ps.funds = 1000;
  let res = AUTO(m, { on: true, cardIds: [target], cycles: 5, equipCoins: true, idCard: false, refresh: true, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  let echo = ps.privateView().modAuto;
  assert.ok(echo.refreshes > 0, '一次刷新都没按下去');
  assert.equal(echo.done, 0, `不该买进任何一张（done=${echo.done}）`);
  assert.equal(echo.stop, 'no-target', `免费刷的停因不是 no-target（实为 ${echo.stop}）`);
  assert.ok(echo.refreshes <= 40, `免费刷滚了 ${echo.refreshes} 次，越过了上限`);
  // 收费刷：每一滚都记在账上，作者的话是「没碰到经济牌就接着刷」，所以由钱来收口，不另设上限
  ps.layers.miraShip = 0;
  ps.funds = price * 60;
  res = AUTO(m, { on: true, cardIds: [target], cycles: 5, equipCoins: true, idCard: false, refresh: true, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  echo = ps.privateView().modAuto;
  assert.equal(echo.free, false, '这一批该是收费刷');
  assert.ok(echo.refreshes > 40, `收费刷只滚了 ${echo.refreshes} 次就停了，该接着刷`);
  assert.notEqual(echo.stop, 'no-target', '收费刷不该栽在 miss 上限上');
});

await check('直购模式：自选商店那一组关掉之后被拒', async () => {
  const { m, ps } = intoPrep(14);
  const target = pickTarget(ps);
  ENABLE(m, ALL_OFF);
  const res = AUTO(m, { on: true, cardIds: [target], cycles: 3, equipCoins: true, idCard: false, refresh: false, mode: 'direct' });
  assert.deepEqual(res, { ok: true }, `意图本身该被接受（由 loop 记停因）：${JSON.stringify(res)}`);
  assert.equal(ps.privateView().modAuto.stop, 'direct-off', '直购在自选商店关掉之后仍然被执行了');
  ENABLE(m, ALL_ON);
});

await check('多目标：几张勾选的卡共用同一个循环，各买各的', async () => {
  const { m, ps } = intoPrep(15);
  ENABLE(m, ALL_ON);
  // two 当期 cards the seat does not hold, both stocked into the table at once
  const [a, b] = AUTO_CARDS.filter((c) => c.cls === 'now' && c.economy && ps.gd.chess(c.id) && !ps.completesChessMerge(c.id)).slice(0, 2);
  assert.ok(a && b, '这一版数据里凑不出两张当期目标');
  stock(ps, a.id);
  stock(ps, b.id, 1);
  const res = AUTO(m, { on: true, cardIds: [a.id, b.id], cycles: 2, equipCoins: true, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const echo = ps.privateView().modAuto;
  assert.equal(echo.done, 2, `两张都该买到（done=${echo.done}, stop=${echo.stop}）`);
  assert.equal(echo.bought[a.id], 1, `${a.name} 没被买到`);
  assert.equal(echo.bought[b.id], 1, `${b.name} 没被买到`);
});

await check('类别闸门：手里攥着免费次数时不下手「下期」牌', async () => {
  const { m, ps } = intoPrep(16);
  ENABLE(m, ALL_ON);
  assert.ok(Number(ps.gd.refreshPrice) > 0, '这一版的刷新价是 0，本测试的前提不成立');
  const c = AUTO_CARDS.find((x) => x.cls === 'deferred' && ps.gd.chess(x.id) && !ps.completesChessMerge(x.id));
  assert.ok(c, '这一版数据里没有可用的下期目标');
  // 已有的免费刷新次数是确定免费的：这一滚不花钱，下期牌就是白占手牌，一轮都不该跑
  ps.shop.freeRefreshes = 1;
  ps.layers.miraShip = 0;
  stock(ps, c.id);
  const res = AUTO(m, { on: true, cardIds: [c.id], cycles: 3, equipCoins: false, idCard: false, refresh: true, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const echo = ps.privateView().modAuto;
  assert.equal(echo.done, 0, `免费次数在手时不该买下期牌（done=${echo.done}）`);
  assert.equal(echo.stop, 'all-deferred', `停因应为 all-deferred（实为 ${echo.stop}）`);
});

await check('类别闸门：奇迹满一百按免费刷（不买下期牌），不满一百按收费刷（买）', async () => {
  const { m, ps } = intoPrep(17);
  ENABLE(m, ALL_ON);
  assert.ok(Number(ps.gd.refreshPrice) > 0, '这一版的刷新价是 0，本测试的前提不成立');
  const c = AUTO_CARDS.find((x) => x.cls === 'deferred' && ps.gd.chess(x.id) && !ps.completesChessMerge(x.id));
  assert.ok(c, '这一版数据里没有可用的下期目标');
  ps.shop.freeRefreshes = 0; // 只有奇迹层数这一个变量
  // 奇迹满一百（含一百）：按免费刷那一套
  ps.layers.miraShip = 100;
  stock(ps, c.id);
  let res = AUTO(m, { on: true, cardIds: [c.id], cycles: 3, equipCoins: false, idCard: false, refresh: true, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  let echo = ps.privateView().modAuto;
  assert.equal(echo.done, 0, `奇迹满一百时不该买下期牌（done=${echo.done}）`);
  assert.equal(echo.stop, 'all-deferred', `停因应为 all-deferred（实为 ${echo.stop}）`);
  assert.equal(echo.free, true, '服务端没把这一批判成「免费刷」那一套');
  // 还差一层：按收费刷那一套，下期牌值得抓（下期的钱顶掉这一滚的开销）
  ps.layers.miraShip = 99;
  stock(ps, c.id);
  res = AUTO(m, { on: true, cardIds: [c.id], cycles: 2, equipCoins: false, idCard: false, refresh: true, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  echo = ps.privateView().modAuto;
  assert.ok(echo.done > 0, `奇迹不满一百时该抓下期牌（done=${echo.done}, stop=${echo.stop}）`);
  assert.equal(echo.free, false, '服务端没把这一批判成「收费刷」那一套');
});

await check('收费刷只抓经济牌：焰尾在收费刷被跳过，免费刷照抓', async () => {
  const { m, ps } = intoPrep(18);
  ENABLE(m, ALL_ON);
  const yan = AUTO_CARDS.find((c) => !c.economy && ps.gd.chess(c.id) && !ps.completesChessMerge(c.id));
  assert.ok(yan, '这一版数据里没有可用的非经济目标');
  ps.shop.freeRefreshes = 0;
  ps.layers.miraShip = 0; // 收费刷
  stock(ps, yan.id);
  let res = AUTO(m, { on: true, cardIds: [yan.id], cycles: 2, equipCoins: false, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  let echo = ps.privateView().modAuto;
  assert.equal(echo.done, 0, `收费刷时不该抓 ${yan.name}（done=${echo.done}）`);
  assert.equal(echo.stop, 'no-economy', `停因应为 no-economy（实为 ${echo.stop}）`);
  ps.layers.miraShip = 100; // 免费刷
  stock(ps, yan.id);
  res = AUTO(m, { on: true, cardIds: [yan.id], cycles: 2, equipCoins: false, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  echo = ps.privateView().modAuto;
  assert.ok(echo.done > 0, `免费刷时该抓 ${yan.name}（done=${echo.done}, stop=${echo.stop}）`);
  assert.equal(echo.free, true, '这一批该是免费刷');
});

await check('收费刷：买进卖出不亏的牌也抓（远见减价之后，非经济牌一样可倒）', async () => {
  const { m, ps } = intoPrep(19);
  ENABLE(m, ALL_ON);
  const c = AUTO_CARDS.find((x) => !x.economy && ps.gd.chess(x.id) && !ps.completesChessMerge(x.id));
  assert.ok(c, '这一版数据里没有可用的非经济目标');
  const sell = Number(ps.gd.sellPrice(c.id));
  assert.ok(sell > 0, `${c.name} 卖不出钱，本测试的前提不成立`);
  ps.shop.freeRefreshes = 0;
  ps.layers.miraShip = 0; // 收费刷
  // 原价：买价高过卖价，这一圈是亏的，收费刷不抓（阴性对照）
  stock(ps, c.id);
  let res = AUTO(m, { on: true, cardIds: [c.id], cycles: 2, equipCoins: false, idCard: false, refresh: false, mode: 'shop' });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  let echo = ps.privateView().modAuto;
  assert.equal(echo.done, 0, `原价时不该抓 ${c.name}（done=${echo.done}）`);
  assert.equal(echo.stop, 'no-economy', `停因应为 no-economy（实为 ${echo.stop}）`);
  // 远见减价之后：买价压到跟卖价一样，这一圈不花钱，于是跟至简一样可抓可卖
  const orig = ps.priceOf;
  ps.priceOf = () => sell;
  try {
    stock(ps, c.id);
    res = AUTO(m, { on: true, cardIds: [c.id], cycles: 2, equipCoins: false, idCard: false, refresh: false, mode: 'shop' });
    assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
    echo = ps.privateView().modAuto;
    assert.ok(echo.done > 0, `买卖不亏时该抓 ${c.name}（done=${echo.done}, stop=${echo.stop}）`);
  } finally {
    ps.priceOf = orig;
  }
});

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
