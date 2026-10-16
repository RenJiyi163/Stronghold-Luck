// verify-duck-extra.mjs — 鸭爵（神秘顾客）当额外策略时也会触发换敌。
//
//   node test/verify-duck-extra.mjs
//
// 鸭爵的效果不是一个 `band:` 处理函数，而是注册在 `global:bands_ducklord` 下的全局处理函数，它的「我持不持鸭爵」判据
// 读的是各座位实时的 `ps.bandId`（ctx.bandId() / ctx.teammates()）。外挂的额外策略存在 `ps.modBands` 里，全局函数看不见，
// 所以它当副策略时整段被跳过。外挂的修法见 server-patch.mjs 的 duckAsExtra：在已包装的 dispatch 里补跑这一段，
// 调用期间把持鸭爵座位的 bandId 遮成 `band_ducklord`，跑完还原。
//
// 这条自检不跑整局：它把真正的安装过程装进这个进程（installServerPatch），用真正的 `MetaRegistry` +
// `EffectDispatcher`（也就是真正的 makeCtx / dispatch 分派链）配一个桩 match，注册一个**判据与游戏那份逐字相同**的
// 鸭爵 global，然后看它在四种座位配置下各被调用几次。跑得快，覆盖的正是那条接缝。
//
// 不覆盖的：游戏那份 duckGlobal 本体（它没被改）。它依赖的 `round_start_all_player_change_enemy_2` 带 `round: 5`，
// 且 `min: 0`（每回合 1/3 概率一位都不换），所以走真实对局去验会很慢且看运气——换个位置验更划算。

import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fsp.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const imp = (rel) => import(pathToFileURL(path.join(gameRoot, rel)).href);

const DUCK = 'band_ducklord';
const silent = { info() {}, warn() {}, error() {} };

const { MetaRegistry, EffectDispatcher } = await imp('server/match/effectsMeta.js');
const { installServerPatch } = await import(pathToFileURL(path.join(MOD_ROOT, 'src', 'server-patch.mjs')).href);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

console.log('\nStronghold-Luck 鸭爵（额外策略）自检\n');

const installed = await installServerPatch(gameRoot, silent, { record: false });
assert.ok(!installed.missing.includes('EffectDispatcher.prototype.dispatch'),
  `补丁没挂上 dispatch：${installed.missing.join(', ') || '(无缺失报告)'}`);

/** A stub match + seats: only the surface `makeCtx` / `duckAsExtra` actually read. */
function world(seats) {
  const players = seats.map((s, i) => ({
    playerId: s.playerId, seat: i, name: s.playerId, bandId: s.bandId, modBands: s.modBands || [],
    bonds: {}, effects: [], layers: {},
    // the rest of a dispatch's walk reads these; empty is enough (no bond / item / persistent-effect handlers here)
    board: new Map(), hand: [], temp: [],
  }));
  // gd.band: the game's own band step of a dispatch reads it (effectsMeta.js `band: this.m.gd.band(ps.bandId)`).
  // No `band:` handler is registered here — the duck is a global — so null is the honest answer.
  const gd = { raw: {}, bondIds: [], band: () => null, enemy: () => ({ rank: 'NORMAL' }) };
  for (const p of players) p.gd = gd;
  const m = {
    round: 5, modeId: 'mode_solo', difficulty: 'ABYSS', isSolo: true, isCoop: false, roomCode: 'ducktest',
    gd, log: silent,
    rngMeta: { int: (n) => Math.max(0, n - 1), shuffle: (a) => a, pick: (a) => a[0] },
    alivePlayers: () => players,
  };
  return { m, players };
}

/** A registry holding one global under the duck's own key, whose gate is the game's gate verbatim, recording calls. */
function registry() {
  const reg = new MetaRegistry();
  const calls = [];
  reg.global('bands_ducklord', {
    onBattleStart(ctx, ev) {
      const self = ctx.bandId();
      const mates = ctx.teammates().map((t) => t.bandId());
      if (self !== DUCK && !mates.includes(DUCK)) return; // the game's own `held` test
      calls.push({ self, mates, pushed: ev.spawns.length });
      ev.spawns.push({ enemyKey: 'duck_swap' }); // what duckReplace does, in one line
    },
  });
  return { reg, calls };
}

/** Dispatch onBattleStart once per seat, each with its own event — what the engine does per field. */
function run(w, reg) {
  const d = new EffectDispatcher(w.m, reg);
  for (const ps of w.players) d.dispatch(ps, 'onBattleStart', { kind: 'normal', round: 5, spawns: [{ enemyKey: 'x' }] });
  return d;
}

await check('鸭爵只在额外策略里时：每个座位各补跑一次，判据看见鸭爵', async () => {
  const w = world([{ playerId: 'a', bandId: 'band_x', modBands: [DUCK] }, { playerId: 'b', bandId: 'band_y' }]);
  const { reg, calls } = registry();
  run(w, reg);
  assert.equal(calls.length, 2, `鸭爵 global 被调用了 ${calls.length} 次，期望 2（每个座位一次）`);
  assert.equal(calls[0].self, DUCK, `持鸭爵的座位遮罩后 ctx.bandId() = ${calls[0].self}，期望 ${DUCK}`);
  assert.ok(calls[1].mates.includes(DUCK), `队友那一次没从 teammates() 看到鸭爵：${JSON.stringify(calls[1].mates)}`);
  assert.equal(calls[0].pushed, 1, '换敌没落到出怪表上');
});

await check('遮罩用完就还原：跑完之后各座位的 bandId 一个字节都没变', async () => {
  const w = world([{ playerId: 'a', bandId: 'band_x', modBands: [DUCK] }, { playerId: 'b', bandId: 'band_y' }]);
  const { reg } = registry();
  run(w, reg);
  assert.equal(w.players[0].bandId, 'band_x', `座位的 bandId 被留成了 ${w.players[0].bandId}`);
  assert.equal(w.players[1].bandId, 'band_y', `座位的 bandId 被留成了 ${w.players[1].bandId}`);
});

await check('鸭爵是主策略时：只由原本那一次跑，不重复换敌', async () => {
  const w = world([{ playerId: 'a', bandId: DUCK }, { playerId: 'b', bandId: 'band_y' }]);
  const { reg, calls } = registry();
  run(w, reg);
  assert.equal(calls.length, 2, `鸭爵 global 跑了 ${calls.length} 次，期望 2（原本的全局那一遍，主策略对每个座位都成立）`);
});

await check('主策略与额外策略同时有鸭爵：仍然是 2 次，不叠加', async () => {
  const w = world([{ playerId: 'a', bandId: DUCK }, { playerId: 'b', bandId: 'band_y', modBands: [DUCK] }]);
  const { reg, calls } = registry();
  run(w, reg);
  assert.equal(calls.length, 2, `跑了 ${calls.length} 次，期望 2（主策略已经在场，补跑要跳过）`);
});

await check('谁都没有鸭爵：一次都不跑（阴性对照）', async () => {
  const w = world([{ playerId: 'a', bandId: 'band_x' }, { playerId: 'b', bandId: 'band_y', modBands: ['band_other'] }]);
  const { reg, calls } = registry();
  run(w, reg);
  assert.equal(calls.length, 0, `不该跑，却跑了 ${calls.length} 次`);
});

await check('额外策略里有别的策略（不是鸭爵）：不会误触发鸭爵', async () => {
  const w = world([{ playerId: 'a', bandId: 'band_x', modBands: ['band_sciurus'] }, { playerId: 'b', bandId: 'band_y' }]);
  const { reg, calls } = registry();
  run(w, reg);
  assert.equal(calls.length, 0, `不该跑，却跑了 ${calls.length} 次`);
});

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
