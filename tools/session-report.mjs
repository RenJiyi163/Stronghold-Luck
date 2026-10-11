#!/usr/bin/env node
// tools/session-report.mjs — turn a recorded session (logs/session-*.jsonl) into a per-round development curve.
//
//   node tools/session-report.mjs [--file logs/session-....jsonl] [--seat p_xxxx] [--json]
//
// The recorder already captures what is needed: every `prep` event and every action of a human seat carries that
// seat's full `privateView` in `snap`, bonds included. Bond layers are cumulative on the seat, so the difference
// between two consecutive prep snapshots is everything the round paid out — prep-finish grants and battle grants
// together. Nothing extra has to be logged for a forced-draw run to be readable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const LOG_DIR = path.join(HERE, '..', 'logs');

function parseArgs(argv) {
  const out = { file: null, seat: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--file') out.file = argv[++i];
    else if (a === '--seat') out.seat = argv[++i];
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  if (!out.file) {
    const files = fs.existsSync(LOG_DIR)
      ? fs.readdirSync(LOG_DIR).filter((f) => f.endsWith('.jsonl')).sort()
      : [];
    if (!files.length) throw new Error(`no session log in ${LOG_DIR}`);
    out.file = path.join(LOG_DIR, files[files.length - 1]);
  }
  return out;
}

/** Bond layers of a snapshot: { bondId: layers }. */
function layersOf(snap) {
  const out = {};
  for (const b of (snap && snap.bonds) || []) {
    if (!b || !b.bondId) continue;
    out[b.bondId] = b.layers || 0;
  }
  return out;
}

const sum = (o) => Object.values(o).reduce((a, b) => a + b, 0);

function main() {
  const args = parseArgs(process.argv.slice(2));
  const lines = fs.readFileSync(args.file, 'utf8').split('\n').filter(Boolean);

  // A session file holds several matches back to back. `start` marks a new one; everything else belongs to the last.
  const matches = [];
  let cur = null;
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.k === 'start') { cur = { start: ev, rounds: new Map(), seats: new Map() }; matches.push(cur); continue; }
    if (!cur) continue;
    if (ev.k === 'prep' && ev.snap) {
      const seat = ev.snap.playerId;
      if (args.seat && seat !== args.seat) continue;
      const rec = cur.seats.get(seat) || { seat, band: ev.snap.bandId || null, byRound: new Map() };
      cur.seats.set(seat, rec);
      // enterPrep fires once per round before any action, so this is round N before its own grants land
      if (!rec.byRound.has(ev.round)) rec.byRound.set(ev.round, ev.snap);
    } else if (ev.k === 'act' && ev.snap && ev.snap.playerId && ev.round != null) {
      const seat = ev.snap.playerId;
      if (args.seat && seat !== args.seat) continue;
      // the last action of a round leaves the freshest snapshot; later ones replace earlier ones. The seat spends its
      // funds down before readying, so funds here is the end-of-prep balance, not the round's income.
      const rec = cur.seats.get(seat) || { seat, band: ev.snap.bandId || null, byRound: new Map() };
      cur.seats.set(seat, rec);
      rec.lastAct = rec.lastAct || new Map();
      rec.lastAct.set(ev.round, ev.snap);
    }
    if (ev.k === 'settle') {
      for (const s of ev.seats || []) {
        const rec = cur.seats.get(s.seat);
        if (rec) rec.lp = s.lpAfter;
      }
    }
  }

  const report = [];
  for (const m of matches) {
    for (const rec of m.seats.values()) {
      const rounds = [...rec.byRound.keys()].sort((a, b) => a - b);
      const rows = [];
      let prev = {};
      for (const r of rounds) {
        const startSnap = rec.byRound.get(r);
        const snap = (rec.lastAct && rec.lastAct.get(r)) || startSnap;
        const layers = layersOf(snap);
        const gained = {};
        for (const k of new Set([...Object.keys(layers), ...Object.keys(prev)])) {
          const d = (layers[k] || 0) - (prev[k] || 0);
          if (d) gained[k] = d;
        }
        const fundsStart = startSnap && startSnap.funds != null ? startSnap.funds : null;
        const fundsEnd = snap && snap.funds != null ? snap.funds : null;
        rows.push({
          round: r,
          level: snap.shop ? snap.shop.level : null,
          fundsStart,
          fundsEnd,
          spent: fundsStart != null && fundsEnd != null ? fundsStart - fundsEnd : null,
          board: snap.deployCount ?? null,
          total: sum(layers),
          gained: sum(gained),
          layers,
          gainedByBond: gained,
        });
        prev = layers;
      }
      report.push({
        mode: m.start.mode, difficulty: m.start.difficulty, stageId: m.start.stageId,
        seat: rec.seat, band: rec.band, rows,
      });
    }
  }

  if (args.json) { console.log(JSON.stringify(report, null, 2)); return; }

  console.log(`${path.basename(args.file)}: ${matches.length} match(es)`);
  for (const r of report) {
    console.log(`\n== ${r.mode} / ${r.difficulty} / ${r.stageId} / seat ${r.seat} / band ${r.band}`);
    if (!r.rows.length) { console.log('   (no prep snapshot — was this seat a bot?)'); continue; }
    console.log('   round  lvl  funds→  spent  board   Σlayers  +this round   top bonds');
    for (const row of r.rows) {
      const top = Object.entries(row.layers).sort((a, b) => b[1] - a[1]).slice(0, 4)
        .map(([k, v]) => `${k}:${v}`).join(' ');
      const money = `${row.fundsStart}→${row.fundsEnd}`;
      console.log(
        `   ${String(row.round).padStart(5)}  ${String(row.level).padStart(3)}  ${money.padStart(8)}  ` +
        `${String(row.spent).padStart(5)}  ${String(row.board).padStart(5)}  ${String(row.total).padStart(8)}  ` +
        `${String(row.gained).padStart(12)}   ${top}`,
      );
    }
  }
}

main();
