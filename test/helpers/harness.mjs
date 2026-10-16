// test/helpers/harness.mjs — the mod's own match harness.
//
// Upstream shipped a test suite up to 0.2.6 (`test/match/harness.js` plus the fakes it pulled in) and dropped the
// whole thing in 0.3.0: the release now carries only `test/helpers/battleHarness.js`, which builds a battle and
// nothing else. This file carries the small surface the mod's suites use, with the same shape as the harness it
// replaces, built only on modules the game still ships:
//
//   const h = makeMatch({ mode: 'coop', difficulty: 'NORMAL', humans: 1, bots: 1, seed: 7, fake: true });
//   h.start(); h.toPrep(1); const ps = h.ps('p_0'); …; h.invariants();
//
// Options: mode, difficulty, humans (count) | seats (explicit), bots, seed, matchNo, data, fake, registry,
// instant, timerScale, botRehearsal, clientCombat, onSend/onBroadcast.
//
// `fake: true` swaps in the upstream FakeBattle (./fakeBattle.js, vendored from v0.2.6 — it is self-contained), so a
// suite that only wants the match loop does not pay for a real simulation. Note the trade: FakeBattle is not the real
// Battle class, so the mod's battle-side hooks (`Battle.prototype._safe`) do not run under it. Suites that test those
// build their own match against the real engine (see verify-diy-slots.mjs).
//
// `clientCombat` defaults to FALSE here, as the upstream harness had it: the game's own default flipped to true in
// 0.3.0, and a headless suite has no browser to run the fights. Server-run combat still exists (`SP_COMBAT=server`
// is the production spelling of the same thing).

import assert from 'node:assert/strict';
import { FakeBattle } from './fakeBattle.mjs';
import { GAME_ROOT, imp } from './game-root.mjs';

export { GAME_ROOT };

const { Match } = await imp('server/match/Match.js');
const { VirtualScheduler } = await imp('server/match/scheduler.js');
const { getData } = await imp('server/data.js');
const { collectViolations } = await imp('server/match/invariants.js');

export const DATA = getData({ log: { info() {}, warn() {}, error() {} } });

export function makeMatch(o = {}) {
  const mode = o.mode ?? 'coop';
  const difficulty = o.difficulty ?? 'NORMAL';
  let seats = o.seats;
  if (!seats) {
    seats = [];
    const humans = o.humans ?? 1;
    const bots = mode === 'solo' ? 0 : (o.bots ?? 0);
    for (let i = 0; i < humans; i++) seats.push({ seat: seats.length, playerId: `p_${i}`, name: `P${i}`, isBot: false, connected: true });
    for (let i = 0; i < bots; i++) seats.push({ seat: seats.length, playerId: `ai_${i}`, name: `AI${i}`, isBot: true, connected: true });
  }
  const sched = new VirtualScheduler({ instantCombat: o.instant !== false });
  const logs = { error: [], warn: [] };
  const log = { info() {}, debug() {}, warn: (...a) => logs.warn.push(a.map(String).join(' ')), error: (...a) => logs.error.push(a.map(String).join(' ')) };
  const h = { sent: [], bc: [], ended: null, endedCount: 0, logs, sched, onSend: [], onBroadcast: [] };
  if (o.fake) {
    FakeBattle.reset();
    if (o.script) FakeBattle.script = o.script;
  }
  h.m = new Match({
    roomCode: 'TEST', mode, difficulty, seats, seed: o.seed ?? 1, matchNo: o.matchNo, data: o.data ?? DATA, log,
    send: (id, msg) => { for (const fn of h.onSend) fn(id, msg); h.sent.push([id, msg]); return true; },
    broadcast: (msg) => { for (const fn of h.onBroadcast) fn(msg); h.bc.push(msg); },
    onEnd: (s) => { h.ended = s; h.endedCount++; },
    scheduler: sched,
    registry: o.registry,
    BattleClass: o.fake ? FakeBattle : undefined,
    timerScale: o.timerScale,
    botRehearsal: o.botRehearsal ?? 0,
    clientCombat: o.clientCombat ?? false,
  });
  const m = h.m;
  h.start = () => { m.start(); return h; };
  h.ps = (id) => m.players.get(id);
  h.run = (pred, opts = {}) => sched.runUntil(pred, { maxSteps: 3e6, ...opts });
  /** run until the phase (and round) is reached */
  h.runToPhase = (phase, round = null, opts = {}) => {
    const ok = h.run(() => h.ended != null || (m.phase === phase && (round == null || m.round === round)), opts);
    assert.ok(ok && m.phase === phase && (round == null || m.round === round), `expected ${phase}${round != null ? ' R' + round : ''}, got ${m.phase} R${m.round}${h.ended ? ' (ended)' : ''}`);
    return h;
  };
  h.runToEnd = (opts = {}) => { h.run(() => h.ended != null, opts); assert.ok(h.ended, `match did not end (phase ${m.phase} R${m.round})`); return h.ended; };
  /** last message of a type sent to a player (unicast) */
  h.lastTo = (id, type) => { for (let i = h.sent.length - 1; i >= 0; i--) if (h.sent[i][0] === id && h.sent[i][1].t === type) return h.sent[i][1]; return null; };
  h.lastBc = (type) => { for (let i = h.bc.length - 1; i >= 0; i--) if (h.bc[i].t === type) return h.bc[i]; return null; };
  h.allTo = (id, type) => h.sent.filter(([pid, msg]) => pid === id && msg.t === type).map(([, msg]) => msg);
  h.flushAll = () => { sched.advance(200); m.flush(true); };
  h.invariants = () => checkInvariants(m);
  /** drive human decisions (info, band, 机变, ready) until `pred` holds */
  h.drive = (pred, { ready = true, band = 'band_bldsk', maxSteps = 3e6 } = {}) => {
    for (let i = 0; i < maxSteps; i++) {
      if (pred()) return true;
      if (h.ended) return !!pred();
      for (const ps of m.players.values()) {
        if (ps.isBot || ps.left) continue;
        if (m.phase === 'INFO_CHECK' && !ps.infoReady) m.handle(ps.playerId, { t: 'g.infoReady' });
        if (m.phase === 'BAND_DRAFT' && m.draftTurn() === ps.playerId) m.handle(ps.playerId, { t: 'g.band', bandId: band });
        if (m.phase === 'SP_DRAFT' && m.spTurn() === ps.playerId) {
          const idx = m.sp.cards.map((c) => c.idx).find((k) => m.sp.taken[k] == null);
          if (idx != null) m.handle(ps.playerId, { t: 'g.choice', idx });
        }
        if (ready && m.phase === 'PREP' && ps.alive && !ps.ready) {
          if (ps.personalChoice) m.handle(ps.playerId, { t: 'g.choice', idx: 0, choiceId: ps.personalChoice.id });
          if (!ps.tempEmpty) ps.resolveTemp();
          m.handle(ps.playerId, { t: 'g.ready', ready: true });
        }
      }
      if (pred()) return true;
      if (!sched.runNext()) return !!pred();
    }
    return !!pred();
  };
  /** reach PREP of round r (humans confirm/draft/ready automatically) */
  h.toPrep = (r = 1, opts = {}) => {
    const ok = h.drive(() => m.phase === 'PREP' && m.round === r, { ...opts, ready: true });
    assert.ok(ok, `could not reach PREP R${r} (phase ${m.phase} R${m.round}${h.ended ? ', ended' : ''})`);
    return h;
  };
  return h;
}

/**
 * Engine invariants (the game's own checker, server/match/invariants.js). Throws an AssertionError listing every
 * violation.
 *
 * The upstream harness ran a second, hand-written set of checks alongside this one "and they must agree". That set
 * pinned the internals it walked (`GEO.HAND_SIZE`, `ps.diyStock`, `pool.entries`), which is exactly the kind of thing
 * a game update moves — so it is dropped here rather than repaired: `collectViolations` is the game's own definition
 * of a well-formed match, and it is the one the engine is held to in production.
 */
export function checkInvariants(m) {
  const violations = collectViolations(m);
  assert.deepEqual(violations, [], `invariants violated (${m.phase} R${m.round}):\n  ${violations.join('\n  ')}`);
  return true;
}
