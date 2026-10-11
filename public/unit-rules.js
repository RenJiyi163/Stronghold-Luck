// unit-rules.js — the sandbox's per-operator overrides (携带技能 / 技力 / 属性), shared by both halves.
//
// The SAME file is imported by the server patch (Node, read from this mod's public/) and by the browser panel
// (/mod/unit-rules.js is served by the launcher), so the two processes always compute the same def from the same config.
// Nothing here touches a live object: `applyUnitOverride` RETURNS THE SAME def when nothing applies (callers compare defs
// by pointer — sim/content/index.js syncUnitLoadout swaps a unit's def only when it is a different object), else a frozen
// shallow copy, leaving the DataSource's own frozen cache untouched.
//
// Why the def and not the unit: the battle spec carries no stats — each side resolves them from data/chess.json through
// `DataSource.getChess(id, loadout)` (server/sim/simdata.js), so one wrapper on that method covers the operator's whole
// body on both sides. 技力 is NOT reachable that way (a kit's own SkillSpec `spCost` / `initSp` wins over the def's — see
// skills.js SkillRuntime), so that half is applied to the runtime instead (side by side, the patchers' `reset` hook).

/**
 * The per-operator numbers the panel edits. Absolute values; an empty field means "leave it alone". `MULT_FIELDS` is the
 * subset 总倍率 also scales — 费用 and 再部署 stay out of it: scaling those breaks the prep economy instead of buffing the
 * operator, which is not what "总倍率" reads as.
 */
export const UNIT_FIELDS = Object.freeze([
  ['maxHp', '生命'], ['atk', '攻击'], ['def', '防御'], ['res', '法抗'],
  ['aspd', '攻速'], ['blockCnt', '阻挡'], ['spRecovery', '技力回复'],
  ['cost', '费用'], ['respawnTime', '再部署'], ['tauntLevel', '嘲讽'], ['massLevel', '重量'],
]);
export const MULT_FIELDS = Object.freeze(new Set(['maxHp', 'atk', 'def', 'res', 'aspd', 'blockCnt', 'spRecovery', 'tauntLevel', 'massLevel']));

/** 这一名 / 我的全部 / 全场. */
export const UNIT_SCOPES = Object.freeze(['one', 'mine', 'all']);
export const SCOPE_LABEL = Object.freeze({ one: '这一名', mine: '我的全部', all: '全场' });

export const UNIT_LIMITS = Object.freeze({
  sp: [0, 99999],      // 技力需求 / 初始技力
  stat: [0, 1e9],      // one absolute stat
  mult: [0.01, 10000], // 总倍率
  idLen: 64,
  skill: 9,            // shared/protocol.js LOADOUT_LIMITS.skillIndex
});

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

/** The bare chess id: a golden piece (`…_b`) and its normal twin are the same operator to every rule here. */
export const baseChessId = (id) => String(id ?? '').replace(/_b$/, '_a');

/**
 * A clean copy of a raw config, or null when there is nothing to read. Never throws: unknown keys are dropped, numbers
 * clamped, an unparsable field falls back to "leave it alone". The shape is what both sides store and what the intent
 * carries.
 * @param {any} raw
 * @returns {{ on: boolean, pin: boolean, scope: 'one'|'mine'|'all', id: string|null, skill: number|null,
 *             spCost: number|null, initSp: number|null, mult: number, stats: Record<string, number> }|null}
 */
export function normalizeUnitCfg(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const scope = UNIT_SCOPES.includes(raw.scope) ? raw.scope : 'one';
  const id = typeof raw.id === 'string' && raw.id.length > 0 && raw.id.length <= UNIT_LIMITS.idLen ? raw.id : null;
  const skill = Number.isInteger(raw.skill) && raw.skill >= 0 && raw.skill <= UNIT_LIMITS.skill ? raw.skill : null;
  const spCost = isNum(raw.spCost) ? clamp(raw.spCost, UNIT_LIMITS.sp) : null;
  const initSp = isNum(raw.initSp) ? clamp(raw.initSp, UNIT_LIMITS.sp) : null;
  const mult = isNum(raw.mult) && raw.mult > 0 ? clamp(raw.mult, UNIT_LIMITS.mult) : 1;
  const stats = {};
  if (raw.stats && typeof raw.stats === 'object' && !Array.isArray(raw.stats)) {
    for (const [k] of UNIT_FIELDS) if (isNum(raw.stats[k])) stats[k] = clamp(raw.stats[k], UNIT_LIMITS.stat);
  }
  return {
    on: !!raw.on,
    pin: raw.pin !== false,
    scope,
    // 换技能 only ever means the one named operator — every operator has its own skill table, so it cannot be widened
    id: scope === 'one' ? id : null,
    skill: scope === 'one' ? skill : null,
    spCost,
    initSp,
    mult,
    stats,
  };
}

/** Whether the config covers chess `chessId`. Scopes 我的全部 / 全场 are "every operator of the field this runs in" — which
 *  field that is, is the PROCESS's business (the browser simulates the player's own, the server the AI seats'). */
export function unitCovers(cfg, chessId) {
  if (!cfg || !cfg.on) return false;
  if (cfg.scope !== 'one') return true;
  return !!cfg.id && baseChessId(chessId) === baseChessId(cfg.id);
}

/** Whether the config asks for anything at all — an enabled but empty config is a no-op on both sides. */
export function unitHasEffect(cfg) {
  if (!cfg || !cfg.on) return false;
  if (cfg.spCost != null || cfg.initSp != null) return true;
  if (cfg.scope === 'one' && cfg.skill != null) return true;
  if (cfg.mult !== 1) return true;
  return Object.keys(cfg.stats).length > 0;
}

/**
 * `def` with the stats override applied. The SAME object when nothing applies; else a frozen shallow copy with a frozen
 * `stats`. `def.stats` is what everything downstream reads (sim battle/players.js `_makeAlly` copies it into `unit.base`,
 * content/index.js `swapDef` too), so rewriting it here is the whole body.
 * @param {object} cfg normalizeUnitCfg output
 * @param {any} def a DataSource chess def
 */
export function applyUnitOverride(cfg, def) {
  if (!unitHasEffect(cfg) || !def || typeof def !== 'object' || !def.stats) return def;
  const st = def.stats;
  const next = { ...st };
  let changed = false;
  for (const [k] of UNIT_FIELDS) {
    const o = cfg.stats[k];
    if (o != null) {
      if (next[k] !== o) { next[k] = o; changed = true; }
      continue;
    }
    if (cfg.mult !== 1 && MULT_FIELDS.has(k) && isNum(st[k])) {
      const v = st[k] * cfg.mult;
      if (v !== st[k]) { next[k] = v; changed = true; }
    }
  }
  if (!changed) return def;
  return Object.freeze({ ...def, stats: Object.freeze(next) });
}

/**
 * A per-process patcher: holds the active config and memoises the rewritten def by the original one, so a def that the
 * DataSource already cached keeps its identity (`getChess` hands out the same object every call; content/index.js
 * `syncUnitLoadout` re-swaps a unit's def whenever it sees a different one).
 */
export function createUnitPatcher() {
  let cfg = null;
  let memo = new WeakMap();
  return {
    /** Install a new config (normalized already, or null). Drops the memo — the next def lookup rebuilds it. */
    set(next) { cfg = next || null; memo = new WeakMap(); },
    get cfg() { return cfg; },
    /** The def to use for `chessId` right now. Never allocates when the config does not cover it. */
    def(chessId, def) {
      if (!def || !cfg || !cfg.on || !unitCovers(cfg, chessId)) return def;
      const hit = memo.get(def);
      if (hit) return hit;
      const d = applyUnitOverride(cfg, def);
      memo.set(def, d);
      return d;
    },
  };
}
