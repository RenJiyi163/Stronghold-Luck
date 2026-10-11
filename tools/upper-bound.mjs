#!/usr/bin/env node
// tools/upper-bound.mjs — the computed theoretical ceiling on income and on the layer engine.
//
//   node tools/upper-bound.mjs [--layers 0,0,2,4,6,9,32,65,101,136,180,172,228,152] [--json]
//
// Why computed and not played: the bounty channel is a fixed three-draw schedule (choices.json schedule[].spRounds
// = [3,9,11] in every co-op mode), so its total is bounded by arithmetic rather than by luck. Playing it out would
// only measure how close a run came to a number that can be derived.
//
// Two accounting lines, kept apart on purpose:
//   income   base `economy.income = min(3 + round, 12)` + the bounty ceiling + the layer-conversion bonds
//   layers   the per-round engine output, taken from a measured run (see notes/author-runs-20261006.md)
//
// The layer line is the input, not an output: everything that converts layers into resources is a function of it.

const BASE_INCOME = [0, 4, 5, 6, 7, 8, 9, 10, 11, 12, 12, 12, 12, 12, 12, 12]; // data/config.json economy.income
const BOUNTY_ROUNDS = [3, 9, 11];  // choices.json schedule[*].spRounds
const MAX_BOUNTY_PER_DRAFT = 6;    // a 3-coin "悬赏·XX" pays 3 in each of the next two battles
const VISI_GOLD_PER_LAYERS = 10;   // bonds.json visiShip: 每叠加10层获得2资金
const VISI_GOLD = 2;
const VISI_DISCOUNT_80 = 80;       // 首次达到80层: 所有【远见】干员购买价永久 -1
const VISI_DISCOUNT_150 = 150;     // 首次达到150层: 调度中心内所有干员购买价永久 -1
const MIRA_PER_LAYERS = 100;       // bonds.json miraShip: 每叠加100层获得20资金
const MIRA_GOLD = 20;

/** The author's Sargon run, gain per round from R1 (notes/author-runs-20261006.md). */
const MEASURED_SARGON = [0, 0, 2, 0, 4, 2, 0, 9, 32, 65, 101, 136, 180, 172, 228, 152];

function parseArgs(argv) {
  const out = { layers: null, json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--layers') out.layers = argv[++i].split(',').map(Number);
    else if (a === '--json') out.json = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return out;
}

function build(layerGains) {
  const rounds = [];
  let cumLayers = 0;
  let cumVisiGold = 0;
  let cumMiraGold = 0;
  let bounty = 0;
  for (let r = 1; r <= 15; r++) {
    const gain = layerGains[r] || 0;
    cumLayers += gain;

    // 远见 and 奇迹 pay out on thresholds crossed, so the cumulative layer count is what matters
    const visiGold = Math.floor(cumLayers / VISI_GOLD_PER_LAYERS) * VISI_GOLD - cumVisiGold;
    cumVisiGold += visiGold;
    const miraGold = Math.floor(cumLayers / MIRA_PER_LAYERS) * MIRA_GOLD - cumMiraGold;
    cumMiraGold += miraGold;

    const draft = BOUNTY_ROUNDS.includes(r) ? MAX_BOUNTY_PER_DRAFT : 0;
    bounty += draft;

    const base = BASE_INCOME[Math.min(r, BASE_INCOME.length - 1)];
    rounds.push({
      round: r, gain, cumLayers, base,
      bounty: draft, bountyCum: bounty,
      visi: visiGold, mira: miraGold,
      total: base + draft + visiGold + miraGold,
      disc80: cumLayers >= VISI_DISCOUNT_80,
      disc150: cumLayers >= VISI_DISCOUNT_150,
    });
  }
  return rounds;
}

const args = parseArgs(process.argv.slice(2));
const rounds = build(args.layers || MEASURED_SARGON);

if (args.json) { console.log(JSON.stringify(rounds, null, 2)); } else {
  console.log('假设：机变三次（R3/R9/R11）每次都拿满 3 资金悬赏并两次击倒；层数曲线用作者萨尔贡局实测。');
  console.log('      远见、奇迹按「每 10 层 2 金 / 每 100 层 20 金」记在累计层数上。\n');
  console.log('  回合  层数+/回  累计层数   基础  奖金  远见  奇迹   合计   里程碑');
  for (const r of rounds) {
    const mark = r.disc150 ? '全店 -1（150 层）' : r.disc80 ? '远见 -1（80 层）' : '';
    console.log(
      `  ${String(r.round).padStart(4)}  ${String(r.gain).padStart(8)}  ${String(r.cumLayers).padStart(8)}  ` +
      `${String(r.base).padStart(5)}  ${String(r.bounty).padStart(4)}  ${String(r.visi).padStart(4)}  ` +
      `${String(r.mira).padStart(4)}  ${String(r.total).padStart(6)}    ${mark}`,
    );
  }
  const baseTotal = rounds.reduce((a, r) => a + r.base, 0);
  const bountyTotal = rounds.reduce((a, r) => a + r.bounty, 0);
  const visiTotal = rounds.reduce((a, r) => a + r.visi, 0);
  const miraTotal = rounds.reduce((a, r) => a + r.mira, 0);
  console.log(`\n  15 回合合计：基础 ${baseTotal}   奖金 ${bountyTotal}   远见 ${visiTotal}   奇迹 ${miraTotal}` +
    `   合计 ${baseTotal + bountyTotal + visiTotal + miraTotal}`);
  console.log(`  奖金占比 ${(100 * bountyTotal / (baseTotal + bountyTotal + visiTotal + miraTotal)).toFixed(1)}%；` +
    `远见占比 ${(100 * visiTotal / (baseTotal + bountyTotal + visiTotal + miraTotal)).toFixed(1)}%`);
  const first = rounds.find((r) => r.visi > r.base);
  console.log(first
    ? `\n  第 ${first.round} 回合起，光远见一条换来的资金就超过基础收入（${first.visi} 对 ${first.base}）。`
    : '\n  这条层数曲线下，远见换来的资金始终没有超过基础收入。');
}
