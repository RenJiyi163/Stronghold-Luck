#!/usr/bin/env node
// tools/author-vs-ai.mjs — read the recorded sessions and compare the human seat against the three AI seats
// that sat in the SAME matches. Everything here comes from the recorder's own events; nothing is inferred.
//
//   node tools/author-vs-ai.mjs [--file logs/session-....jsonl]... [--json]
//
// Why the paired reading matters: the human seat and its three AI teammates face the same map, the same wave
// schedule and the same round, so "damage taken per round" is comparable without any cross-run modelling.
// Reported per match and pooled, plus the exit reason, because a match that ended by elimination and one that
// ended because the player closed the tab are not the same event.

import fs from 'node:fs';
import path from 'node:path';

function parseArgs(argv) {
  const out = { files: [], json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.files.push(argv[++i]);
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.files.length) {
    const dir = path.join(process.cwd(), 'logs');
    out.files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort().map((f) => path.join(dir, f));
  }
  return out;
}

function loadMatches(file) {
  const matches = [];
  let cur = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if (ev.k === 'start') { cur = { file, start: ev, settles: [], end: null }; matches.push(cur); continue; }
    if (!cur) continue;
    if (ev.k === 'settle') cur.settles.push(ev);
    else if (ev.k === 'end') cur.end = ev;
  }
  return matches;
}

const files = parseArgs(process.argv.slice(2)).files;
const jsonOut = process.argv.includes('--json');
const matches = files.flatMap(loadMatches);

const rows = [];
for (const m of matches) {
  const seats = new Map();
  for (const s of m.settles) {
    for (const seat of s.seats || []) {
      if (!seat || typeof seat.seat !== 'string') continue;
      const r = seats.get(seat.seat) || { seat: seat.seat, dmg: 0, rounds: 0, lpStart: seat.lpBefore, lpEnd: seat.lpBefore, leaked: 0, elimRound: null };
      r.dmg += seat.damage || 0;
      r.leaked += seat.leaks || 0;
      r.rounds += 1;
      r.lpEnd = seat.lpAfter;
      if (seat.eliminated && r.elimRound == null) r.elimRound = s.round;
      seats.set(seat.seat, r);
    }
  }
  const endSeats = new Map();
  for (const s of (m.end && m.end.seats) || []) endSeats.set(s.seat, s);
  const human = [...seats.values()].find((s) => !s.seat.startsWith('ai_'));
  rows.push({ humanSeat: human ? human.seat : null,
    file: path.basename(m.file),
    mode: m.start.mode, difficulty: m.start.difficulty, stageId: m.start.stageId,
    reason: m.end ? m.end.outcome.reason : '(no end event)',
    lastRound: m.end ? m.end.round : (m.settles.length ? m.settles[m.settles.length - 1].round : 0),
    seats: [...seats.values()].map((s) => {
      const e = endSeats.get(s.seat);
      return {
        ...s,
        ai: s.seat.startsWith('ai_'),
        aliveAtEnd: e ? e.alive : null,
        lpAtEnd: e ? e.lp : null,
        levelAtEnd: e ? e.level : null,
        boardAtEnd: e ? e.boardN : null,
        bondsAtEnd: e ? (e.bonds || []).reduce((a, b) => a + (b.layers || 0), 0) : null,
      };
    }),
  });
  rows[rows.length - 1].human = rows[rows.length - 1].seats.find((s) => !s.ai) || null;
}

// ---- pooled -----------------------------------------------------------------------------------------------
const num = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? num(xs) / xs.length : NaN);
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };

const playable = rows.filter((r) => r.lastRound >= 1 && r.human && r.human.rounds > 0);
const humanDpr = playable.map((r) => r.human.dmg / r.human.rounds);
const aiDpr = [];
const pairs = [];
for (const r of playable) {
  const ais = r.seats.filter((s) => s.ai);
  const a = mean(ais.map((s) => s.dmg / s.rounds));
  aiDpr.push(a);
  pairs.push(r.human.dmg / r.human.rounds - a);
}

console.log(`\n=== matches: ${rows.length} total, ${playable.length} with a played human seat ===\n`);
console.log('file                          stage              reason      endR  human(lp dmg/r  lvl  board)      ai teammates (lp dmg/r lvl board)');
for (const r of rows) {
  const h = r.human;
  const ais = r.seats.filter((s) => s.ai);
  const fmt = (s) => `${String(s.lpAtEnd).padStart(3)} ${String(s.dmg).padStart(4)} ${(s.dmg / Math.max(1, s.rounds)).toFixed(2).padStart(5)} lvl${String(s.levelAtEnd).padStart(2)} b${String(s.boardAtEnd).padStart(2)}`;
  console.log(`${r.file.slice(8, 30).padEnd(28)}  ${String(r.stageId).padEnd(18)} ${r.reason.padEnd(11)} ${String(r.lastRound).padStart(4)}  ${h ? fmt(h) : '(none)'}   ${ais.map(fmt).join(' | ')}`);
}

console.log(`\n--- exit reasons ---`);
const byReason = {};
for (const r of rows) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
console.log(byReason);

console.log(`\n--- human seat, pooled over ${playable.length} played matches ---`);
console.log(`  rounds played total          ${num(playable.map((r) => r.human.rounds))}`);
console.log(`  damage taken total           ${num(playable.map((r) => r.human.dmg))}`);
console.log(`  damage per round             ${mean(humanDpr).toFixed(3)}  (sd ${sd(humanDpr).toFixed(3)}, n=${humanDpr.length})`);
console.log(`  leaks per round              ${(num(playable.map((r) => r.human.leaked)) / num(playable.map((r) => r.human.rounds))).toFixed(3)}`);
console.log(`  ended at LP 0                ${playable.filter((r) => r.human.lpAtEnd === 0).length} / ${playable.length}`);
console.log(`  eliminated (settle flag)     ${playable.filter((r) => r.human.elimRound != null).length} / ${playable.length}`);
console.log(`  level at end                 ${mean(playable.map((r) => r.human.levelAtEnd)).toFixed(2)}`);
console.log(`  starting LP                  ${[...new Set(playable.map((r) => r.human.lpStart))].sort((a, b) => a - b).join(', ')}`);

console.log(`\n--- the three AI teammates in the SAME matches ---`);
console.log(`  damage per round             ${mean(aiDpr).toFixed(3)}  (sd ${sd(aiDpr).toFixed(3)})`);
const aiAll = playable.flatMap((r) => r.seats.filter((s) => s.ai));
console.log(`  ended at LP 0                ${aiAll.filter((s) => s.lpAtEnd === 0).length} / ${aiAll.length}`);
console.log(`  level at end                 ${mean(aiAll.map((s) => s.levelAtEnd)).toFixed(2)}`);
console.log(`  starting LP                  ${[...new Set(aiAll.map((s) => s.lpStart))].sort((a, b) => a - b).join(', ')}`);
console.log(`  board at end                 ${mean(aiAll.map((s) => s.boardAtEnd)).toFixed(2)}`);

// Survival is the metric that is comparable across a human seat and a bot seat: the round at which the seat's LP
// reaches 0. It is censored for seats that were still alive when the match stopped, so both columns are reported as
// "died at round k" counts rather than as a single mean.
const surv = playable.map((r) => ({
  file: r.file, stage: r.stageId, reason: r.reason,
  human: r.human.rounds, humanDied: r.human.elimRound != null,
  ai: r.seats.filter((s) => s.ai).map((s) => ({ k: s.rounds, died: s.elimRound != null })),
}));
console.log(`\n--- survival round (the round a seat's LP reaches 0) ---`);
console.log('file/stage                     human  teammates(died?)            reason');
for (const s of surv) {
  console.log(`  ${s.file.slice(8, 24)} ${s.stage.slice(0, 16).padEnd(16)} ${String(s.human).padStart(3)}${s.humanDied ? 'D' : ' '}   `
    + `${s.ai.map((a) => `${a.k}${a.died ? 'D' : ' '}`).join(' ').padEnd(24)} ${s.reason}`);
}
const hd = surv.filter((s) => s.humanDied).map((s) => s.human);
console.log(`  human died in ${hd.length}/${surv.length} matches  rounds ${hd.slice().sort((a, b) => a - b).join(', ')}`);
console.log(`  human death round: mean ${mean(hd).toFixed(2)}  sd ${sd(hd).toFixed(2)}  n ${hd.length}`);
const aid = playable.flatMap((r) => r.seats.filter((s) => s.ai && s.elimRound != null)).map((s) => s.rounds);
console.log(`  AI  death round:   mean ${mean(aid).toFixed(2)}  sd ${sd(aid).toFixed(2)}  n ${aid.length}  (${aid.length}/${playable.length * 3} AI seats died)`);
const survPairs = surv.filter((s) => s.humanDied).map((s) => {
  const d = s.ai.filter((a) => a.died).map((a) => a.k);
  return d.length ? s.human - mean(d) : null;
}).filter((x) => x != null);
if (survPairs.length) {
  console.log(`  paired (human death round − its match's dead AI mean): ${mean(survPairs).toFixed(2)} ± ${(sd(survPairs) / Math.sqrt(survPairs.length)).toFixed(2)}  n ${survPairs.length}`);
}

console.log(`\n--- paired difference, human minus its own match's AI mean (negative = human loses less) ---`);
console.log(`  mean  ${mean(pairs).toFixed(3)}   sd ${sd(pairs).toFixed(3)}   n ${pairs.length}`);
console.log(`  se    ${(sd(pairs) / Math.sqrt(pairs.length)).toFixed(3)}`);

if (jsonOut) {
  const out = path.join(path.dirname(files[0] || '.'), 'author-vs-ai.json');
  fs.writeFileSync(out, JSON.stringify({ rows, humanDpr, aiDpr, pairs }, null, 2));
  console.log(`\nwrote ${out}`);
}
