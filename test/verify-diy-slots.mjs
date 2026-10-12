// verify-diy-slots.mjs — 自选位（per-slot 盟约 / 特质）接缝自检。
//
//   node test/verify-diy-slots.mjs
//
// 不跑整局：把真正的安装过程装进这个进程（installServerPatch），用真实的 GameData / DataSource / PlayerState.setDiy，
// 配一个最小桩 match，然后走 `g.modDiy` 意图，看三件事：
//
//   1. 休整期侧 —— `ps.gd.chess(位子).bonds` 被换掉、`computeBonds` 跟着走；
//   2. 战斗侧 —— `DataSource.getChess(slotId, { diy })` 交出来的 def 的 `bonds` 与 `raw.garrisonIds` 跟着走
//      （战斗侧读的是 def，不是 ps.gd）；
//   3. 位子作用域 —— 没配的位子一个字节都不变。
//
// 覆盖不到的：真正上场以后的战斗表现（那要看两个 sim 各自的装载），以及面板那半（见 verify-diy-slots-ui.mjs）。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fsp.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const imp = (rel) => import(pathToFileURL(path.join(gameRoot, rel)).href);

const silent = { info() {}, warn() {}, error() {} };
const SLOT5 = 'chess_char_5_diy1_a';
const SLOT5_ELITE = 'chess_char_5_diy1_b';
const SLOT6 = 'chess_char_6_diy1_a';
/** 原型干员（不看持有、人人可用），所以任何一局的数据里都合法。 */
const PICK5 = { charId: 'char_601_cguard' };
const PICK6 = { charId: 'char_608_acpion' };

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

console.log('\nStronghold-Luck 自选位自检\n');

const { getData } = await imp('server/data.js');
const data = await getData({ log: silent });
const { GameData } = await imp('server/match/gamedata.js');
const { Match } = await imp('server/match/Match.js');
const { PlayerState } = await imp('server/match/PlayerState.js');
const { DataSource } = await imp('server/sim/simdata.js');
const { computeBonds } = await imp('server/match/bondsMeta.js');
const { installServerPatch } = await import(pathToFileURL(path.join(MOD_ROOT, 'src', 'server-patch.mjs')).href);

const installed = await installServerPatch(gameRoot, silent, { record: false });
assert.ok(!installed.missing.includes('PlayerState.prototype.setDiy'), `没挂上 setDiy：${installed.missing.join(', ')}`);
assert.ok(!installed.missing.includes('server/match/player/diy.js diyGameData'), `没拿到 diyGameData：${installed.missing.join(', ')}`);

const gd = new GameData(data, 'mode_solo');
/** The server's own FEATURE_KEYS, all on: what every check starts from. */
const ALL_ON = { shop: true, sandboxBands: true, sandboxPlace: true, sandboxUnit: true, diy: true, diyExtra: true, shopFilter: true };

/** A minimal match + seat: only the surface `handle` / `applyModDiy` / `refreshDiyStock` actually read.
 *  `withBot` adds a second, engine-driven seat — the game gives it the same empty `_diyRecords` Map a human gets
 *  (PlayerState.js:178), which is what made the 自造位子 leak onto bots. */
function world({ withBot = false } = {}) {
  const m = Object.create(Match.prototype);
  m.round = 1;
  m.phase = 'PREP';
  m.gd = gd;
  m.log = silent;
  m.flush = () => {};
  m.reportError = () => {};
  const seat = (playerId, isBot) => ({
    playerId, isBot, m, gd,
    diy: Object.freeze({}), _diyRecords: new Map(),
    diyStock: { entries: new Map() }, diyBanned: Object.freeze([]),
    board: new Map(), hand: new Array(9).fill(null), temp: new Array(5).fill(null),
    layers: {}, bonds: {}, bondCountBonus: {},
    recompute() { this.bonds = computeBonds(this.gd, this); },
    dirty() {},
  });
  const ps = seat('p_0', false);
  m.players = new Map([[ps.playerId, ps]]);
  const bot = withBot ? seat('p_1', true) : null;
  if (bot) m.players.set(bot.playerId, bot);
  // the config is PROCESS-WIDE (that is the whole point: the def patcher cannot see a seat), so every check starts by
  // clearing it — otherwise one check's kit would leak into the next (nothing to clear before setDiy: empty maps)
  Match.prototype.handle.call(m, 'p_0', { t: 'g.modDiy', slots: {} });
  // the master switches are process-wide too, so a check that turns one off must not leave it off for the next one
  Match.prototype.handle.call(m, 'p_0', { t: 'g.modEnable', features: ALL_ON });
  return { m, ps, bot };
}

/** The picks a seat holds: both forms of each slot, exactly what the game's own setDiy composes. The picked slots are
 *  also put on the BOARD, because a bond is counted by distinct base chess ON THE BOARD (bondsMeta.membership). */
function start(w, picks) {
  const ok = PlayerState.prototype.setDiy.call(w.ps, picks);
  assert.ok(ok, 'setDiy 拒绝了这组 picks');
  w.ps.diy = Object.freeze({ ...w.ps.diy });
  let col = 0;
  for (const slotId of Object.keys(picks)) w.ps.board.set(`0,${col++}`, { kind: 'chess', id: slotId, uid: col, items: [] });
  w.ps.bonds = computeBonds(w.ps.gd, w.ps);
  return w;
}

/** `send` takes just the `slots` map (the common case); `sendAll` the whole payload (`{ slots, extra }`). */
const send = (w, slots) => Match.prototype.handle.call(w.m, 'p_0', { t: 'g.modDiy', slots });
const sendAll = (w, msg) => Match.prototype.handle.call(w.m, 'p_0', { t: 'g.modDiy', ...msg });
const bondsOf = (ps, slotId) => (ps.gd.chess(slotId)?.bonds || []).slice();
const defOf = (slotId, pick) => new DataSource(data).getChess(slotId, { diy: pick });

await check('打上补丁之后，未配置的位子保持原样（阴性对照）', async () => {
  const w = start(world(), { [SLOT5]: PICK5, [SLOT6]: PICK6 });
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['emptyShip'], '原型干员的推导结果本该是协防干员');
  assert.deepEqual(bondsOf(w.ps, SLOT6), ['emptyShip']);
  assert.equal(w.ps.bonds.emptyShip?.count, 2, '两位协防干员本该凑成 2（协防阈值就是 2）');
});

await check('指定盟约：休整期侧的 bonds 换掉，计数跟着走', async () => {
  const w = start(world(), { [SLOT5]: PICK5, [SLOT6]: PICK6 });
  const res = send(w, { [SLOT5]: { bonds: ['egirShip', 'kjeragShip'] } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['egirShip', 'kjeragShip']);
  assert.equal(w.ps.bonds.egirShip?.count, 1, '阿戈尔没数到这个位子');
  assert.equal(w.ps.bonds.kjeragShip?.count, 1, '谢拉格没数到这个位子');
  assert.equal(w.ps.bonds.emptyShip?.count, 1, '协防本该只剩另一个位子（它自己也变了）');
});

await check('指定盟约：战斗侧的 def.bonds 也跟着换（精英形态一样）', async () => {
  const w = start(world(), { [SLOT5]: PICK5, [SLOT6]: PICK6 });
  send(w, { [SLOT5]: { bonds: ['egirShip'] } });
  const normal = defOf(SLOT5, PICK5);
  const elite = defOf(SLOT5_ELITE, PICK5);
  assert.ok(normal?.diyFor === SLOT5, `def 没有 diyFor：${JSON.stringify(normal?.diyFor)}`);
  assert.deepEqual(normal.bonds, ['egirShip'], '普通形态没吃到');
  assert.deepEqual(elite.bonds, ['egirShip'], '精锐形态没吃到');
  assert.deepEqual(elite.raw.bonds, ['egirShip'], 'def.raw 没同步');
});

await check('叠加：干员自己那条还在，再添一条', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const res = send(w, { [SLOT5]: { addBonds: ['yanShip'] } });
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['emptyShip', 'yanShip'], '叠加模式把原来的挤掉了');
});

await check('清空：替换成一个都不勾 = 这个位子不再算任何盟约', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  send(w, { [SLOT5]: { bonds: [] } });
  assert.deepEqual(bondsOf(w.ps, SLOT5), []);
  assert.equal(w.ps.bonds.emptyShip?.count, 0);
});

await check('特质：休整期侧写进 garrisonIds，战斗侧写进 def.raw.garrisonIds', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const res = send(w, { [SLOT5]: { garrisons: ['garrison_25_a'] } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  assert.deepEqual(w.ps.gd.chess(SLOT5).garrisonIds, ['garrison_25_a']);
  const def = defOf(SLOT5, PICK5);
  assert.deepEqual(def.raw.garrisonIds, ['garrison_25_a'], '战斗侧读的是 def.raw.garrisonIds，没写上');
  const elite = defOf(SLOT5_ELITE, PICK5);
  assert.deepEqual(elite.raw.garrisonIds, ['garrison_25_b'], '精锐形态该自动配到 _b 那条');
});

await check('位子作用域：只动勾了的位子，另一个位子一个字节都不变', async () => {
  const w = start(world(), { [SLOT5]: PICK5, [SLOT6]: PICK6 });
  const before = bondsOf(w.ps, SLOT6);
  send(w, { [SLOT5]: { bonds: ['yanShip'], garrisons: ['garrison_25_a'] } });
  assert.deepEqual(bondsOf(w.ps, SLOT6), before, '没配的位子被改了');
  assert.deepEqual(w.ps.gd.chess(SLOT6).garrisonIds, [], '没配的位子被塞了特质');
  assert.deepEqual(defOf(SLOT6, PICK6).raw.garrisonIds, []);
});

await check('还原：空配置把整个位子放回原样', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  send(w, { [SLOT5]: { bonds: ['yanShip'], garrisons: ['garrison_25_a'] } });
  const res = send(w, {});
  assert.deepEqual(res, { ok: true });
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['emptyShip']);
  assert.deepEqual(w.ps.gd.chess(SLOT5).garrisonIds, []);
  assert.deepEqual(defOf(SLOT5, PICK5).bonds, ['emptyShip']);
});

await check('本局禁用：新盟约全被禁的位子会失去库存（官方规则）', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  // the stock the game built once the bans were drawn, plus the ban set it was built under
  const cap = gd.poolCopies(SLOT5);
  assert.ok(cap > 0, `这个位子本该有库存，实得 ${cap}`);
  w.ps.diyStock.entries.set(SLOT5, { cap, left: cap, tier: 5, shopLevel: 5 });
  w.ps.__modDiyOff = new Set(['egirShip']);
  send(w, { [SLOT5]: { bonds: ['egirShip'] } });
  assert.equal(w.ps.diyStock.entries.has(SLOT5), false, '盟约全被禁的位子还留着库存');
  assert.deepEqual(w.ps.diyBanned, [SLOT5]);
  // and back: un-banning the bond hands the stock back
  send(w, { [SLOT5]: { bonds: ['yanShip'] } });
  assert.equal(w.ps.diyStock.entries.get(SLOT5)?.left, cap, '解禁之后库存没回来');
  assert.deepEqual(w.ps.diyBanned, []);
});

await check('不存在的盟约 / 特质 / 位子：一律拒掉，不静默丢弃', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  assert.equal(send(w, { [SLOT5]: { bonds: ['nopeShip'] } }).ok, undefined, '不存在的盟约被收下了');
  assert.match(send(w, { [SLOT5]: { bonds: ['nopeShip'] } }).detail || '', /没有可用的盟约或特质/);
  assert.equal(send(w, { [SLOT5]: { garrisons: ['garrison_zzz'] } }).ok, undefined, '不存在的特质被收下了');
  assert.equal(send(w, { chess_char_1_01_a: { bonds: ['yanShip'] } }).ok, undefined, '不存在的位子被收下了');
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['emptyShip'], '被拒的请求不该改动任何东西');
});

await check('特质数值：换成自己那份（minted id），原记录一个字节不动', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const res = send(w, { [SLOT5]: { garrisons: [{ id: 'garrison_25_a', bb: { count: 9 } }] } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const ids = w.ps.gd.chess(SLOT5).garrisonIds;
  assert.equal(ids.length, 1);
  assert.notEqual(ids[0], 'garrison_25_a', '改了数值却还在用原记录（会改到全局）');
  assert.equal(w.ps.gd.garrison(ids[0])?.bb?.count, 9, '休整期侧读不到改后的数值');
  assert.equal(w.ps.gd.garrison(ids[0])?.effectKey, 'SERVER_ADD_BOND_CHESS_ALL', '换了数值就把派发键弄丢了');
  assert.equal(w.ps.gd.garrison('garrison_25_a')?.bb?.count, 2, '原记录被改了');
  const def = defOf(SLOT5, PICK5);
  assert.deepEqual(def.raw.garrisonIds, ids, '战斗侧没拿到同一个 id');
  assert.equal((data.garrisons[ids[0]] || {}).bb, undefined, '数据表里被塞了一条（不该写数据）');
});

await check('盟约数值：两个副本都改（bb 与 buffs[0].bb），原记录不动', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const res = send(w, { [SLOT5]: { bonds: ['yanShip'], bondBb: { yanShip: { atk_per_stack: 0.5 } } } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  const rec = w.ps.gd.bond('yanShip');
  assert.equal(rec.bb.atk_per_stack, 0.5, '休整期侧读的 bb 没改');
  assert.equal(rec.buffs[0].bb.atk_per_stack, 0.5, '战斗侧读的是 buffs[0].bb，没改');
  assert.deepEqual(rec.thresholds, data.bonds.yanShip.thresholds, '只该动数值，阈值不该动');
  assert.equal(data.bonds.yanShip.bb.atk_per_stack, 0.009, '原记录被改了');
  // the counting still works through the patched record
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['yanShip']);
  assert.equal(w.ps.bonds.yanShip?.count, 1);
});

await check('还原：数值一起撤掉，记录回到原样', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  send(w, { [SLOT5]: { bonds: ['yanShip'], garrisons: [{ id: 'garrison_25_a', bb: { count: 9 } }] } });
  send(w, {});
  assert.equal(w.ps.gd.bond('yanShip'), data.bonds.yanShip, '撤掉之后盟约没回到原记录');
  assert.equal(w.ps.gd.garrison('garrison_25_a').bb.count, 2);
});

console.log('[携带技能]');

await check('改内置位子的携带技能：记录与那一座的 pick 都真的换掉', async () => {
  const w = start(world(), { [SLOT5]: { charId: 'char_003_kalts', skillIndex: 0 } });
  assert.equal(w.ps.gd.chess(SLOT5)?.skill?.index, 0, '起点不是 S1');
  const res = sendAll(w, { skills: { [SLOT5]: 2 } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  assert.equal(w.ps.gd.chess(SLOT5)?.skill?.index, 2, '普通形态没换');
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.skill?.index, 2, '精锐形态没换');
  assert.equal(w.ps.diy[SLOT5]?.skillIndex, 2, '这一座的 pick 没跟着（战斗里会退回原技能）');
  assert.equal(w.ps.gd.chess(SLOT5)?.skills?.find((x) => x.isDefault)?.index, 2, 'skills[] 的默认标记没跟着');
});

await check('原型干员的技能是数据里定的：给它换技能不会得逞，也不会把记录弄坏', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const before = w.ps.gd.chess(SLOT5)?.skill?.index;
  sendAll(w, { skills: { [SLOT5]: 0 } });
  assert.ok(w.ps.gd.chess(SLOT5), '记录被弄没了');
  assert.equal(w.ps.gd.chess(SLOT5)?.skill?.index, before, '原型干员的技能不该被改掉');
});

await check('改内置位子的模组：精锐形态带上它并激活，清掉就摘下来', async () => {
  const w = start(world(), { [SLOT5]: { charId: 'char_003_kalts', skillIndex: 2 } });
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.module?.id ?? null, null, '起点不该挂着模组');
  const res = sendAll(w, { mods: { [SLOT5]: 'uniequip_002_kalts' } });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.module?.id, 'uniequip_002_kalts', '精锐形态没带上');
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.module?.active, true, '模组没激活');
  assert.equal(w.ps.diy[SLOT5]?.uniEquipId, 'uniequip_002_kalts', '这一座的 pick 没跟着');
  assert.equal(w.ps.gd.chess(SLOT5)?.module?.active ?? false, false, '普通形态的模组不该生效（练度不够）');
  sendAll(w, { mods: { [SLOT5]: null } });
  assert.ok(!w.ps.gd.chess(SLOT5_ELITE)?.module?.active, '清掉之后还挂着模组');
});

await check('技能与模组一起改：两个都落在同一个记录上', async () => {
  const w = start(world(), { [SLOT5]: { charId: 'char_003_kalts', skillIndex: 0 } });
  sendAll(w, { skills: { [SLOT5]: 1 }, mods: { [SLOT5]: 'uniequip_002_kalts' } });
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.skill?.index, 1, '技能没换');
  assert.equal(w.ps.gd.chess(SLOT5_ELITE)?.module?.id, 'uniequip_002_kalts', '模组没带上');
  assert.equal(w.ps.diy[SLOT5]?.skillIndex, 1);
  assert.equal(w.ps.diy[SLOT5]?.uniEquipId, 'uniequip_002_kalts');
});

console.log('[更多位子（mod 自己造的位子）]');

await check('造一个 3 阶位子：两个形态都建出来，阶与 diyFor 都对', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  const res = sendAll(w, { extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }] });
  assert.deepEqual(res, { ok: true }, `意图被拒：${JSON.stringify(res)}`);
  assert.ok(w.ps.diy['mod_diy_1_a'], `ps.diy 里没有这个位子：${Object.keys(w.ps.diy).join(',')}`);
  const rec = w.ps.gd.chess('mod_diy_1_a');
  assert.equal(rec?.tier, 3, `阶不对：${rec?.tier}`);
  assert.equal(rec?.diyFor, 'mod_diy_1_a');
  assert.deepEqual(rec?.bonds, ['emptyShip']);
  assert.equal(w.ps.gd.tierOf('mod_diy_1_a'), 3);
  assert.equal(w.ps.gd.chess('mod_diy_1_b')?.isGolden, true, '精锐形态没建出来');
  assert.equal(w.ps._diyRecords.has('mod_diy_1_b'), true);
});

await check('造出来的位子战斗侧也解析得出（同一条 def 通路）', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  sendAll(w, { extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }] });
  const def = defOf('mod_diy_1_a', { charId: 'char_601_cguard' });
  assert.ok(def, '战斗侧解析不出这个位子');
  assert.equal(def.diyFor, 'mod_diy_1_a');
  assert.equal(def.tier, 3);
  assert.deepEqual(def.bonds, ['emptyShip']);
});

await check('造出来的位子和内置位子吃同一套 kit（盟约 / 特质 / 数值）', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  sendAll(w, {
    extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }],
    slots: { mod_diy_1_a: { bonds: ['siracusaShip'], garrisons: [{ id: 'garrison_25_a', bb: { count: 9 } }] } },
  });
  const rec = w.ps.gd.chess('mod_diy_1_a');
  assert.deepEqual(rec.bonds, ['siracusaShip']);
  assert.equal(rec.garrisonIds.length, 1);
  assert.equal(w.ps.gd.garrison(rec.garrisonIds[0])?.bb?.count, 9);
  assert.equal(defOf('mod_diy_1_a', { charId: 'char_601_cguard' }).bonds[0], 'siracusaShip');
});

await check('库存按它自己的阶来；撤掉位子时连库存一起收回', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  w.ps.__modDiyOff = new Set();
  sendAll(w, { extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }] });
  const entry = w.ps.diyStock.entries.get('mod_diy_1_a');
  assert.ok(entry, '没有给这个位子建库存');
  assert.equal(entry.left, gd.poolCopies('mod_diy_1_a'), '库存不是按 3 阶来的');
  assert.equal(entry.shopLevel, 3, '商店门槛不是这个位子的阶');
  send(w, {});
  assert.equal(w.ps.diyStock.entries.has('mod_diy_1_a'), false, '撤掉之后库存没收回去');
  assert.equal(w.ps.diy['mod_diy_1_a'], undefined, '撤掉之后 picks 里还留着');
  assert.ok(!w.ps.gd.chess('mod_diy_1_a'), '撤掉之后 chess 表里还留着');
});

await check('自造位子只长在真人座位上，bot 座位上不长（作者 2026-10-11 报的泄漏）', async () => {
  const w = world({ withBot: true });
  // initDiyStock runs for EVERY seat (banner: `for (const ps of this.order) ps.initDiyStock(off)`), so both carry the
  // banned set its wrapper records — which is what lets the config loop reach refreshDiyStock on either of them.
  w.ps.__modDiyOff = new Set();
  w.bot.__modDiyOff = new Set();
  sendAll(w, { extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }] });
  assert.equal(w.ps.diy['mod_diy_1_a'] != null, true, '真人座位没拿到自造位子');
  assert.equal(w.bot.diy['mod_diy_1_a'], undefined, 'bot 的 自选编队 里出现了自造位子');
  assert.equal(w.bot._diyRecords.has('mod_diy_1_a'), false, 'bot 的 _diyRecords 里出现了自造位子');
  assert.equal(w.bot.diyStock.entries.has('mod_diy_1_a'), false, 'bot 的库存里出现了自造位子（它的商店就能抽到）');
});

// ---- the master switches (总开关) ----------------------------------------------------------------------
const setFeatures = (w, features) => Match.prototype.handle.call(w.m, 'p_0', { t: 'g.modEnable', features });

await check('总开关：关掉「自造位子」，造出来的位子连同库存一起收回', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  w.ps.__modDiyOff = new Set();
  sendAll(w, { extra: [{ k: 1, tier: 3, pick: { charId: 'char_601_cguard' } }] });
  assert.ok(w.ps.diy['mod_diy_1_a'], '前置：这一步本该造出位子');
  assert.equal(w.ps.diyStock.entries.has('mod_diy_1_a'), true, '前置：这一步本该建出库存');
  setFeatures(w, { diyExtra: false });
  assert.equal(w.ps.diy['mod_diy_1_a'], undefined, '关掉之后 自选编队 里还留着自造位子');
  assert.equal(w.ps._diyRecords.has('mod_diy_1_a'), false, '关掉之后 _diyRecords 里还留着');
  assert.equal(w.ps.diyStock.entries.has('mod_diy_1_a'), false, '关掉之后库存还留着（商店还能抽到）');
});

await check('总开关：关掉「自选位」，盟约改回原样', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  send(w, { [SLOT5]: { bonds: ['egirShip'] } });
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['egirShip'], '前置：这一步本该换上盟约');
  setFeatures(w, { diy: false });
  assert.deepEqual(bondsOf(w.ps, SLOT5), ['emptyShip'], '关掉之后盟约没还回去');
});

await check('总开关：关掉之后连设置也不接受（入口就拒）', async () => {
  const w = start(world(), { [SLOT5]: PICK5 });
  setFeatures(w, { shopFilter: false });
  const res = Match.prototype.handle.call(w.m, 'p_0', { t: 'g.modShopFilter', on: true, bonds: [], mode: 'only' });
  assert.ok(res && res.error, '阵营锁关掉之后还接受了设置');
  // and the switch is read live: turning it back on lets the same intent through
  setFeatures(w, { shopFilter: true });
  const back = Match.prototype.handle.call(w.m, 'p_0', { t: 'g.modShopFilter', on: true, bonds: [], mode: 'only' });
  assert.deepEqual(back, { ok: true }, `重新打开之后仍被拒：${JSON.stringify(back)}`);
});

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
