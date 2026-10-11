#!/usr/bin/env node
// test/verify-solver.mjs — the solver's own acceptance checks. Run before trusting any number the solver prints.
//
//   node test/verify-solver.mjs
//
// Checks, in order of how much they would cost to get wrong:
//   1. anchors      the three Match seams the policy plugs into still exist and match the copied skeleton
//   2. determinism  the same seed twice produces byte-identical outcomes
//   3. parity       SolverMatch + the built-in policy reproduces the stock Match exactly. This is the load-bearing
//                   check: it proves the copied scheduleBotPrep skeleton did not change behaviour. If it ever fails,
//                   every solver number is measuring a different game than the one the author plays.
//   4. legality     a deliberately sloppy policy produces engine errors of zero and refused actions above zero
//   5. invariants   engine invariants hold at every phase/round boundary

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runMatch } from '../solver/runner.mjs';
import { SolverMatch, checkAnchors } from '../solver/plugins/SolverMatch.mjs';
import { setPolicy, BUILTIN } from '../solver/policy/index.mjs';
import { makeRandom } from '../solver/policy/random.mjs';
import { FORK } from '../solver/policy/fork.mjs';
import { resetParams } from '../solver/policy/params.mjs';
import { outcomeOf } from '../solver/eval/reward.mjs';
import { bankByName } from '../solver/eval/seeds.mjs';
import { runEpisode, dims, KINDS } from '../solver/env/env.mjs';
import { trainPG } from '../solver/env/pg.mjs';
import { initParams, makeScorer, sampleIndex, accumulateGrad, makeGradWs, valueOf, accumulateValueGrad, N, EMB } from '../solver/env/net.mjs';

const SEEDS = [1, 2, 3];
let failures = 0;
const section = (name) => console.log(`\n== ${name}`);
const ok = (msg) => console.log(`   ok  ${msg}`);
function check(cond, msg) {
  if (cond) { ok(msg); return true; }
  failures++;
  console.log(`   FAIL ${msg}`);
  return false;
}

const sig = (o) => JSON.stringify(o);

// 1 -------------------------------------------------------------------------------------------------
section('anchors');
{
  const problems = checkAnchors();
  check(problems.length === 0, `the three policy seams and DELAYS/PHASE are intact${problems.length ? `: ${problems.join('; ')}` : ''}`);
}

// 2 -------------------------------------------------------------------------------------------------
section('determinism');
{
  for (const seed of SEEDS) {
    const a = outcomeOf(runMatch({ seed }).summary);
    const b = outcomeOf(runMatch({ seed }).summary);
    check(sig(a) === sig(b), `seed ${seed} reproduces exactly (rounds=${a.roundsPassed}, reason=${a.reason})`);
  }
}

// 3 -------------------------------------------------------------------------------------------------
section('parity: SolverMatch + built-in policy vs stock Match');
{
  setPolicy(BUILTIN);
  for (const seed of SEEDS) {
    const stock = outcomeOf(runMatch({ seed }).summary);
    const viaSeam = outcomeOf(runMatch({ seed, MatchClass: SolverMatch }).summary);
    check(sig(stock) === sig(viaSeam), `seed ${seed} identical through the seam (rounds=${stock.roundsPassed}, reason=${stock.reason})`);
  }
  setPolicy(null);
}

// 3b ------------------------------------------------------------------------------------------------
section('parity: the forked seat AI vs the stock bot (default parameters)');
{
  resetParams();
  setPolicy(FORK);
  for (const seed of SEEDS) {
    const stock = outcomeOf(runMatch({ seed }).summary);
    const fork = outcomeOf(runMatch({ seed, MatchClass: SolverMatch }).summary);
    check(sig(stock) === sig(fork), `seed ${seed} the fork reproduces the stock bot (rounds=${stock.roundsPassed}, reason=${stock.reason})`);
  }
  setPolicy(null);
}

// 4 -------------------------------------------------------------------------------------------------
section('legality: a sloppy policy is refused, never crashes');
{
  const pol = makeRandom({ illegalRate: 0.2 });
  setPolicy(pol);
  const r = runMatch({ seed: 7, MatchClass: SolverMatch, invariants: true });
  setPolicy(null);
  check(r.errorCount === 0, `engine errors 0 (got ${r.errorCount})${r.errors.length ? `: ${r.errors.slice(0, 2).join(' | ')}` : ''}`);
  check(r.rejects > 0, `refused actions > 0 (got ${r.rejects}); a legality harness that never sees a rejection tests nothing`);
  check(r.violations.length === 0, `engine invariants held at every boundary${r.violations.length ? `: ${r.violations.slice(0, 2).join(' ; ')}` : ''}`);
  check(r.ok, `the match still reached a summary (rounds=${outcomeOf(r.summary).roundsPassed})`);
}

// 5 -------------------------------------------------------------------------------------------------
section('invariants under the built-in policy');
{
  const r = runMatch({ seed: 11, invariants: true });
  check(r.errorCount === 0 && r.violations.length === 0,
    `clean${r.violations.length ? `: ${r.violations.slice(0, 2).join(' ; ')}` : ''} (rounds=${outcomeOf(r.summary).roundsPassed})`);
}

// 6 -------------------------------------------------------------------------------------------------
section('env: one episode under a learner policy');
{
  const rng = (() => { let a = 5; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const theta = initParams(rng);
  const mkPolicy = () => {
    const sc = makeScorer(theta);
    let s = 99;
    const rnd = () => { s |= 0; s = (s + 0x6D2B79F5) | 0; let t = Math.imul(s ^ (s >>> 15), 1 | s); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    return ({ g, bids, feats, ids, n }) => {
      sc.forward(g, feats, ids, n, bids);
      const p = sc.softmax(n);
      return { idx: sampleIndex(p, n, rnd) };
    };
  };
  const a = runEpisode({ seed: 5, policy: mkPolicy(), budget: 16 });
  const b = runEpisode({ seed: 5, policy: mkPolicy(), budget: 16 });
  check(a.decisions > 0, `decisions recorded (${a.decisions}, dims g=${dims().g} f=${dims().f})`);
  check(a.errorCount === 0, `engine errors 0 (got ${a.errorCount})${a.errors.length ? `: ${a.errors.slice(0, 2).join(' | ')}` : ''}`);
  check(sig(a.outcome) === sig(b.outcome), `same seed + same policy → identical outcome (rounds=${a.outcome.roundsPassed}); common random numbers depend on it`);
  check(a.outcome.roundsPassed > 0, `the match actually ran (${a.outcome.roundsPassed} rounds)`);
}

// 7 -------------------------------------------------------------------------------------------------
section('gradient: the backward pass against a float64 finite difference');
{
  // The scaled forward, in float64, so the reference is not fighting float32 cancellation: a central difference in
  // float32 through 103-term dot products is noise, which is exactly how a wrong ReLU mask hid here for a while.
  const rng = (() => { let a = 7; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const theta = initParams(rng);
  const n = 5;
  const g = Float32Array.from({ length: N.g }, () => rng() - 0.5);
  const f = Float32Array.from({ length: n * dims().f }, () => rng());
  const R = N.idRows;
  const ids = new Int32Array(n * R).fill(-1);
  for (let i = 0; i < n; i++) {
    ids[i * R] = 1 + (i % 5);                       // kind row
    ids[i * R + 1] = 12 + i;                        // card row
    if (i % 2 === 0) ids[i * R + 2] = i + 1;        // item row (some rows stay -1 by design)
    for (let r = 3; r < R; r++) ids[i * R + r] = (7 * i + 3 * r) % 40;  // neighbour cards
  }
  // Board identity: a mix of real card rows and -1, so the scatter into embCard is exercised on both branches.
  const idsBoard = N.boardRows
    ? Int32Array.from({ length: N.boardRows }, (_, s) => (s % 5 === 0 ? -1 : (11 * s) % 40))
    : new Int32Array(0);
  const idx = 2;
  const adv = 0.7;
  const ent = 0.03;
  const NUMF = dims().f - 10;
  const ROWOFF = N.rowTable.map((t) => (t === 0 ? N.oKind : (t === 2 ? N.oItem : N.oCard)));

  const objective = (t) => {
    const bembb = new Float64Array(N.boardRows * EMB);
    for (let s = 0; s < N.boardRows; s++) {
      const row = idsBoard[s];
      if (row < 0) continue;
      for (let k = 0; k < EMB; k++) bembb[s * EMB + k] = t[N.oCard + row * EMB + k];
    }
    const x = new Float64Array(N.inDim);
    const loc = new Float64Array(N.local);
    const tv = new Float64Array(N.rank);
    for (let k = 0; k < N.rank; k++) {
      let b = 0;
      for (let j = 0; j < N.g; j++) b += t[N.oV + k * N.g + j] * g[j];
      tv[k] = b;
    }
    x.set(bembb, N.g);
    const lg = [];
    for (let i = 0; i < n; i++) {
      x.fill(0, 0, N.gv);
      for (let k = 0; k < N.g; k++) x[k] = g[k];
      for (let k = 0; k < bembb.length; k++) x[N.g + k] = bembb[k];
      loc.fill(0);
      for (let r = 0; r < R; r++) {
        const row = ids[i * R + r];
        if (row < 0) continue;
        for (let k = 0; k < EMB; k++) loc[r * EMB + k] = t[ROWOFF[r] + row * EMB + k];
      }
      for (let k = 0; k < NUMF; k++) loc[R * EMB + k] = f[i * dims().f + 10 + k];
      let acc = t[N.ob2];
      for (let j = 0; j < N.hidden; j++) {
        let s = t[N.ob1 + j];
        const base = N.oW1 + j * N.inDim;
        for (let k = 0; k < N.gv; k++) s += t[base + k] * x[k];
        for (let k = 0; k < N.local; k++) s += t[base + N.gv + k] * loc[k];
        acc += t[N.oW2 + j] * (s > 0 ? s : 0);
      }
      for (let k = 0; k < N.rank; k++) {
        let sk = 0;
        for (let q = 0; q < N.local; q++) sk += t[N.oU + k * N.local + q] * loc[q];
        acc += sk * tv[k];
      }
      lg.push(acc);
    }
    let mx = -Infinity;
    for (const v of lg) mx = Math.max(mx, v);
    let sum = 0;
    for (const v of lg) sum += Math.exp(v - mx);
    let H = 0;
    for (const v of lg) { const q = Math.exp(v - mx) / sum; if (q > 0) H -= q * Math.log(q); }
    return adv * (lg[idx] - (mx + Math.log(sum))) + ent * H;
  };

  const grad = new Float32Array(N.total);
  accumulateGrad(theta, grad, g, idsBoard, f, ids, n, idx, adv, ent, makeGradWs());
  const base = Array.from(theta);
  const h = 1e-6;
  let worst = 0;
  const probes = [N.ob2, N.oW2 + 3, N.ob1 + 3];
  // One probe per path, so a wrong term in any single one of them is visible instead of being averaged away:
  //   embCard via a candidate row, embCard via the BOARD block, embItem, embKind, the numeric columns (W1 local),
  //   the W1 columns over the state block, and both bilinear factor tables.
  for (const row of [13, 29]) for (let t = 0; t < 3; t++) probes.push(N.oCard + row * EMB + t);
  const boardRow = [...idsBoard].find((r) => r >= 0);
  if (boardRow != null) for (let t = 0; t < 3; t++) probes.push(N.oCard + boardRow * EMB + t);
  for (let t = 0; t < 3; t++) probes.push(N.oItem + 2 * EMB + t);
  for (let t = 0; t < 3; t++) probes.push(N.oKind + 3 * EMB + t);
  for (const j of [0, 7, 31]) probes.push(N.oW1 + j * N.inDim + N.gv + 20);
  for (const j of [0, 7, 31]) probes.push(N.oW1 + j * N.inDim + 30);
  for (let k = 0; k < 3; k++) probes.push(N.oU + k * N.local + 5);
  for (let k = 0; k < 3; k++) probes.push(N.oV + k * N.g + 9);
  let compared = 0;
  for (const i of probes) {
    const up = base.slice();
    up[i] += h;
    const dn = base.slice();
    dn[i] -= h;
    const num = (objective(up) - objective(dn)) / (2 * h);
    // a probe that moves nothing (b2 shifts every logit equally, so the softmax cannot see it) is not a comparison
    if (Math.abs(num) + Math.abs(grad[i]) < 1e-6) continue;
    compared++;
    const err = Math.abs(num - grad[i]) / Math.max(1e-9, Math.abs(num) + Math.abs(grad[i]));
    if (err > worst) worst = err;
  }
  // ~3e-3 is the float32 floor of the analytic path's multi-term dot products; anything above is a real mismatch
  check(compared >= 12 && worst < 1e-2,
    `analytic gradient matches a float64 central difference on ${compared} probes (worst relative error ${worst.toExponential(2)})`);
}

// 8 -------------------------------------------------------------------------------------------------
section('value head: a step moves the critic TOWARD its target');
{
  // The optimiser adds whatever the head accumulates, so the value head has to accumulate the descent direction of
  // its squared error. Accumulating the plain error instead makes the critic diverge in proportion to the learning
  // rate, which it did for two whole runs before anyone looked.
  const ws = makeGradWs();
  let ok = 0;
  for (const seed of [3, 9]) {
    let a = seed;
    const rng = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    const theta = initParams(rng);
    // The critic reads [g | board identity]; the identity tail is zeros here, which is a valid state.
    const g = Float32Array.from({ length: N.gv }, () => rng() - 0.5);
    const v0 = valueOf(theta, g, ws);
    for (const target of [v0 + 1.5, v0 - 1.5]) {
      const grad = new Float32Array(N.total);
      accumulateValueGrad(theta, grad, g, v0, target, ws);
      const t2 = Float32Array.from(theta);
      for (let i = N.oWv; i < N.total; i++) t2[i] += 0.001 * grad[i];
      const d = valueOf(t2, g, ws) - v0;
      if (Math.sign(d) === Math.sign(target - v0)) ok++;
    }
  }
  check(ok === 4, `all 4 probes move toward the target (${ok}/4)`);
}

// 9 -------------------------------------------------------------------------------------------------
section('mechanism: `refresh` is offered, and taking it is accepted');
{
  // `refresh` was dead in this project for its whole life: the live PlayerState.shop has no `refreshPrice` (that field
  // exists only in the privateView snapshot), so the enumerator's `ps.funds >= ps.shop.refreshPrice` compared against
  // undefined and offered zero refresh candidates. Nothing caught it, because every check here looked at the engine
  // and the engine was fine. This one looks at the candidate list.
  const REFRESH = KINDS.indexOf('refresh');
  const rng = (() => { let a = 13; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const theta = initParams(rng);
  const sc = makeScorer(theta);
  let offered = 0;
  let chosen = 0;
  // No placement provider, so `rejects` counts only this seat's own refused actions. With one, the provider's refused
  // moves land in the same counter and the assertion below would be reading the wrong thing.
  const r = runEpisode({
    seed: 5, budget: 8, noMove: true,
    policy: ({ g, bids, feats, ids, n }) => {
      sc.forward(g, feats, ids, n, bids);
      let idx = 0;
      for (let i = 0; i < n; i++) if (ids[i * N.idRows] === REFRESH) { idx = i; break; }
      for (let i = 0; i < n; i++) if (ids[i * N.idRows] === REFRESH) offered++;
      if (ids[idx * N.idRows] === REFRESH) chosen++;
      return { idx };
    },
  });
  check(r.decisions > 0, `the episode ran (${r.decisions} decisions)`);
  check(offered > 0, `refresh was in the candidate list ${offered} times; the defect made this exactly 0`);
  check(chosen > 0, `a policy that picks refresh whenever it is offered actually picked it ${chosen} times`);
  check(r.rejects === 0, `the engine refused none of them (rejects=${r.rejects})`);
}

// 10 ------------------------------------------------------------------------------------------------
section('training: `--seed` reaches the sampling stream even when `--init` fixes the weights');
{
  // The other defect that cost a night: with `--init`, nothing else in the run was seeded, so two runs of the same
  // configuration were bit-identical and the "at least 2 independent repeats" rule could not be executed. The disk
  // still had the evidence, in a file that labelled two identical readings as different seeds. Keep the init fixed
  // and vary only the seed: anything other than an identical pair of vectors proves the seed is reaching the stream.
  const tmp = path.join(os.tmpdir(), `solver-init-${process.pid}.f32`);
  const seedRng = (() => { let a = 4242; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();
  const init = initParams(seedRng);
  fs.writeFileSync(tmp, Buffer.from(init.buffer, init.byteOffset, init.byteLength));
  const bank = bankByName('smoke');
  const runOne = async (seed) => {
    const { theta: t } = await trainPG({
      generations: 1, episodes: 1, workers: 1, budget: 8, bank, seed, init: tmp,
      noMove: true, layout: 'builtin', omit: ['ready'], onLog: () => {},
    });
    return t;
  };
  const a = await runOne(111);
  const b = await runOne(112);
  let diff = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) diff++;
  check(a.length === N.total, `the trainer returned a full parameter vector (${a.length} floats)`);
  check(diff > 0, `two seeds differ in ${diff} of ${a.length} parameters after one generation on the same init file`);
  fs.unlinkSync(tmp);
}

console.log(failures === 0 ? '\nall checks passed' : `\n${failures} check(s) FAILED`);
process.exit(failures === 0 ? 0 : 1);
