// slot-rules.js — the 自选位 (DIY slot) overrides: which 盟约 a slot's piece carries, which 特质 it bears, and the numbers
// those effects run with. Everything is keyed by the SLOT, never by the operator: whoever the player slots there inherits
// it (the author's rule, 2026-10-10 — 「作用于那个位置，哪个干员在那个位置上，它就应用那些效果」).
//
// Shared by both halves exactly like unit-rules.js: the server patch imports it from this mod's public/, the browser panel
// imports it as /mod/slot-rules.js. Nothing here touches a live object — `applySlotOverride` RETURNS THE SAME record when
// nothing applies (callers compare records by pointer), else a frozen shallow copy, so the game's own frozen 自选 records
// and the DataSource's frozen cache stay untouched.
//
// Why the slot key: a composed 自选 record carries its slot in `diyFor` (shared/diy.js diyRecordOf sets it to the slot's
// base id; the elite form carries the same base id), which is what both the prep record and the sim def are keyed on.
//
// Where each field lands (verified against the 0.2.2 release):
//   * `bonds`       — the composed record's own `bonds`. The prep side counts through it (bondsMeta.pieceBonds reads
//                     `gd.chess(id).bonds`, and `ps.gd` is the 自选 data view); the battle side through `def.bonds`
//                     (sim content/support unitBonds).
//   * `garrisonIds` — the composed record's own `garrisonIds`. The prep side reads it off `ps.gd.chess(id)`; the battle
//                     side reads `def.raw.garrisonIds` ONLY (simdata normalizeChess does not copy the field onto the def's
//                     own level), so the def patch has to write it into `raw`.

export const SLOT_LIMITS = Object.freeze({ idLen: 64, num: 1e9, garrisons: 16 });

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= SLOT_LIMITS.idLen;
const clampNum = (v) => Math.min(SLOT_LIMITS.num, Math.max(-SLOT_LIMITS.num, v));

/** The slot base id of a 自选 chess id: its `_b` elite twin and its `_a` normal form are the same slot. */
export const slotBaseId = (id) => String(id ?? '').replace(/_b$/, '_a');

/** `data` is a `{ bonds, garrisons }` map pair (the server's `gd.raw`, the browser's data store) or null = no check. */
const known = (data, kind, id) => !data || !isObj(data[kind]) || Object.prototype.hasOwnProperty.call(data[kind], id);

/**
 * A clean id list out of `raw[key]`: `{ ids: null }` when the field is absent (absent = 保持原样, `[]` = 清空), and
 * `{ bad: true }` when anything named is not a real id of `kind` — the caller refuses rather than silently dropping it
 * (a stale id after a game update should be visible, not quietly change what the slot carries).
 */
function idListOf(raw, key, data, kind) {
  if (!Array.isArray(raw[key])) return { ids: null };
  const out = [];
  for (const id of raw[key]) {
    if (!isId(id) || !known(data, kind, id)) return { bad: true };
    if (!out.includes(id)) out.push(id);
  }
  return { ids: out };
}

/** The `bb` patch of one assigned effect: numbers only. */
function bbOf(v) {
  if (!isObj(v)) return null;
  const out = {};
  for (const [k, n] of Object.entries(v)) if (isNum(n) && k.length <= SLOT_LIMITS.idLen) out[k] = clampNum(n);
  return Object.keys(out).length ? out : null;
}

/**
 * A clean copy of one slot's config, or null when there is nothing to do. Never throws. The shape is what both sides
 * store and what the intent carries.
 *
 * A 特质 comes in an `_a` (normal) / `_b` (elite) pair; the panel always names the `_a` id and the pair is resolved here
 * (`elite` = the `_b` twin when the data has one, else null), so a config survives the piece being merged to 精锐.
 * @param {any} raw
 * @param {{ bonds?: object, garrisons?: object }|null} [data] the effect tables, for id validation
 * @returns {{ bonds: string[]|null, addBonds: string[], garrisons: Array<{ id: string, elite: string|null, bb: object|null }> }|null}
 */
export function normalizeSlotCfg(raw, data = null) {
  if (!isObj(raw)) return null;
  const bonds = idListOf(raw, 'bonds', data, 'bonds');
  if (bonds.bad) return null;
  const addBonds = idListOf(raw, 'addBonds', data, 'bonds');
  if (addBonds.bad) return null;
  if (Array.isArray(raw.garrisons) && raw.garrisons.length > SLOT_LIMITS.garrisons) return null;
  const garrisons = [];
  for (const g of Array.isArray(raw.garrisons) ? raw.garrisons : []) {
    const named = isObj(g) ? g.id : g;
    const id = isId(named) ? named.replace(/_b$/, '_a') : null;
    if (!id || !known(data, 'garrisons', id)) return null;
    if (garrisons.some((x) => x.id === id)) continue;
    const twin = id.replace(/_a$/, '_b');
    const elite = twin !== id && known(data, 'garrisons', twin) ? twin : null;
    garrisons.push({ id, elite, bb: isObj(g) ? bbOf(g.bb) : null });
  }
  // the author's own numbers for a 盟约 (a partial `bb` patch). Only the numbers are editable: the 盟约's own mechanics
  // are hand-written per bond id in the game and cannot be swapped out (see the header note about 合成盟约 below).
  const bondBb = {};
  if (isObj(raw.bondBb)) {
    for (const [bondId, patch] of Object.entries(raw.bondBb)) {
      if (!known(data, 'bonds', bondId)) return null;
      const bb = bbOf(patch);
      if (bb) bondBb[bondId] = bb;
    }
  }
  const cfg = { bonds: bonds.ids, addBonds: addBonds.ids || [], garrisons, bondBb };
  return slotHasEffect(cfg) ? cfg : null;
}

/** Whether a normalized config asks for anything (an empty one is a no-op on both sides). */
export function slotHasEffect(cfg) {
  if (!cfg) return false;
  return cfg.bonds !== null || (Array.isArray(cfg.addBonds) && cfg.addBonds.length > 0)
    || (Array.isArray(cfg.garrisons) && cfg.garrisons.length > 0)
    || (isObj(cfg.bondBb) && Object.keys(cfg.bondBb).length > 0);
}

/**
 * The deterministic id of a 特质 whose numbers the author edited: the same (slot, garrison) mints the same id on both
 * processes, so the two sims and the prep side all resolve the same record without anything crossing the wire.
 */
export function mintGarrisonId(slotId, garrisonId) {
  return `gm_${garrisonId}_${slotBaseId(slotId)}`;
}

/** The bond ids a config grants (the replaced set plus the added ones), for the panel's summary. */
export function slotBondIds(cfg) {
  if (!slotHasEffect(cfg)) return [];
  return [...new Set([...(cfg.bonds || []), ...(cfg.addBonds || [])])];
}

const sameList = (a, b) => {
  const x = Array.isArray(a) ? a : [];
  const y = Array.isArray(b) ? b : [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

/**
 * `rec` (a composed 自选 record, or a sim def's `raw`) with this slot's bonds / 特质 applied. THE SAME object when nothing
 * changes; else a frozen shallow copy with both field arrays frozen.
 * @param {ReturnType<typeof normalizeSlotCfg>} cfg
 * @param {any} rec
 */
export function applySlotOverride(cfg, rec) {
  if (!slotHasEffect(cfg) || !rec || typeof rec !== 'object') return rec;
  const golden = !!rec.isGolden;
  const slotId = rec.diyFor || '';
  const garrisonIds = (Array.isArray(rec.garrisonIds) ? rec.garrisonIds : []).slice();
  for (const g of cfg.garrisons) {
    const want = golden && g.elite ? g.elite : g.id;
    // the author's own numbers need a record of their own: a minted id, resolved from the battle / prep data (see
    // syntheticGarrisons below). A 特质 left at its stock numbers keeps its real id.
    const id = g.bb ? mintGarrisonId(slotId, want) : want;
    if (!garrisonIds.includes(id)) garrisonIds.push(id);
  }
  const bonds = cfg.bonds !== null
    ? [...new Set([...cfg.bonds, ...cfg.addBonds])]
    : [...new Set([...(Array.isArray(rec.bonds) ? rec.bonds : []), ...cfg.addBonds])];
  if (sameList(bonds, rec.bonds) && sameList(garrisonIds, rec.garrisonIds)) return rec;
  return Object.freeze({ ...rec, bonds: Object.freeze(bonds), garrisonIds: Object.freeze(garrisonIds) });
}

/**
 * A sim `def` with this slot's override applied: `def.bonds` (what sim content/support unitBonds reads) plus `def.raw`,
 * whose `garrisonIds` is what the battle-side 特质 installer reads (`garrisons/battle.js garrisonIdsOf`).
 * @param {ReturnType<typeof normalizeSlotCfg>} cfg
 * @param {any} def a DataSource chess def
 */
export function applySlotDefOverride(cfg, def) {
  if (!slotHasEffect(cfg) || !def || typeof def !== 'object') return def;
  const raw = applySlotOverride(cfg, def.raw);
  if (raw === def.raw) return def;
  return Object.freeze({ ...def, bonds: raw.bonds, garrisonIds: raw.garrisonIds, raw });
}

/**
 * A per-process patcher holding the per-slot configs and memoising each rewritten record by the original one, so a record
 * the DataSource already cached keeps its identity (the idiom of unit-rules.js createUnitPatcher).
 */
export function createSlotPatcher() {
  let cfgs = new Map();
  let memo = new WeakMap();
  const slotOf = (v) => (v && typeof v.diyFor === 'string' ? slotBaseId(v.diyFor) : null);
  return {
    /** Install the whole config map (slotBaseId → normalized cfg, or an empty map). Drops the memo. */
    set(next) { cfgs = next instanceof Map ? next : new Map(); memo = new WeakMap(); },
    /** The config of a slot base id, or null. */
    cfgOf(slotId) { return cfgs.get(slotBaseId(slotId)) || null; },
    /** The slot base ids that have a config (for a rebuild to walk). */
    get slots() { return [...cfgs.keys()]; },
    /** `[slotBaseId, cfg]` pairs in data order (the number builders walk these). */
    entries() { return [...cfgs.entries()]; },
    /** Whether any slot has a config at all (lets the callers skip the whole path). */
    get empty() { return cfgs.size === 0; },
    /** The patched composed record for a 自选 record. Never allocates when nothing applies. */
    rec(rec) {
      const s = slotOf(rec);
      if (!s) return rec;
      const hit = memo.get(rec);
      if (hit) return hit;
      const out = applySlotOverride(cfgs.get(s) || null, rec);
      memo.set(rec, out);
      return out;
    },
    /** The patched sim def for a def carrying `diyFor`. Never allocates when nothing applies. */
    def(def) {
      const s = slotOf(def);
      if (!s) return def;
      const hit = memo.get(def);
      if (hit) return hit;
      const out = applySlotDefOverride(cfgs.get(s) || null, def);
      memo.set(def, out);
      return out;
    },
  };
}

/**
 * The 特质 records a config needs that the data does not have: every assigned 特质 whose numbers the author edited, as
 * `{ [mintedId]: record }` (the stock record with `bb` merged over). The 特质 installer dispatches by `effectKey` and
 * reads the record's own `bb`, so a minted id works everywhere a stock one does.
 * @param {Array<[string, ReturnType<typeof normalizeSlotCfg>]>} entries [slotBaseId, cfg] pairs
 * @param {{ garrisons?: object }|null} base the data's own table
 */
export function syntheticGarrisons(entries, base) {
  const out = {};
  for (const [slotId, cfg] of entries) {
    if (!cfg) continue;
    for (const g of cfg.garrisons) {
      if (!g.bb) continue;
      for (const form of [g.id, g.elite]) {
        const src = form ? base?.[form] : null;
        if (!src) continue;
        const id = mintGarrisonId(slotId, form);
        if (out[id]) continue;
        out[id] = Object.freeze({ ...src, garrisonId: id, bb: Object.freeze({ ...(src.bb || {}), ...g.bb }) });
      }
    }
  }
  return out;
}

/**
 * The 盟约 records carrying the author's numbers: `bb` AND `buffs[0].bb` patched (the battle reads them through
 * `buffParams(rec, 'env_gbuff_new')`, the prep side reads `bb`). ONE value per 盟约: the game has a single record per
 * bond id and its battle mechanic is hand-written per id, so a per-slot number is not expressible for 盟约 (only for
 * 特质). Of two slots editing the same 盟约 the first in data order wins, and the panel says so.
 * @param {Array<[string, ReturnType<typeof normalizeSlotCfg>]>} entries
 * @param {{ bonds?: object }|null} base
 */
export function patchedBonds(entries, base) {
  const out = {};
  for (const [, cfg] of entries) {
    if (!cfg || !isObj(cfg.bondBb)) continue;
    for (const [bondId, patch] of Object.entries(cfg.bondBb)) {
      const src = base?.[bondId];
      if (!src || out[bondId]) continue;
      const bb = Object.freeze({ ...(src.bb || {}), ...patch });
      const buffs = Array.isArray(src.buffs) && src.buffs.length
        ? Object.freeze([Object.freeze({ ...src.buffs[0], bb }), ...src.buffs.slice(1)])
        : src.buffs;
      out[bondId] = Object.freeze({ ...src, bb, buffs });
    }
  }
  return out;
}

/**
 * A data object with the slot kit's number edits merged in: what a sim's content modules read through
 * `support.gameData()`, and what the prep side reads for 特质 (`GameData.garrison`). The SAME object when nothing needs
 * patching, so the callers can swap it in unconditionally and compare by pointer.
 * @param {Array<[string, ReturnType<typeof normalizeSlotCfg>]>} entries
 * @param {any} base the data the sim / prep side is currently using
 */
export function patchGameData(entries, base) {
  if (!base || typeof base !== 'object') return base;
  const garrisons = syntheticGarrisons(entries, base.garrisons);
  const bonds = patchedBonds(entries, base.bonds);
  const anyG = Object.keys(garrisons).length > 0;
  const anyB = Object.keys(bonds).length > 0;
  if (!anyG && !anyB) return base;
  return {
    ...base,
    garrisons: anyG ? { ...base.garrisons, ...garrisons } : base.garrisons,
    bonds: anyB ? { ...base.bonds, ...bonds } : base.bonds,
  };
}

/** Whether a set of configs carries any number edit at all (lets a caller skip the whole data-patch path). */
export function hasNumberEdits(entries) {
  for (const [, cfg] of entries) {
    if (!cfg) continue;
    if (isObj(cfg.bondBb) && Object.keys(cfg.bondBb).length) return true;
    for (const g of cfg.garrisons) if (g.bb) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------------------------------------------------
// 更多自选位 (the mod's own slots)
//
// The game ships exactly four slots (two tier-5, two tier-6). A mod-owned slot is the same shape at ANY tier: a pair of
// `isDiy` chess records plus a `diy.slots` entry, so every rule that already walks `diy.slots` picks it up unchanged.
//
// The operator FORMS only exist at two statuses (`2/1/4/0` normal and `2/60/7/1` elite — data/backups.json), so the slot
// copies the game's own tier-5 slot's status whatever its tier: the tier drives the price, the 调度中心 gate and the pool
// copies, never the body. The pool of operators is the same 88 (the author's decision — no new operator data).

/** The chess id of mod slot `k` in its normal (`_a`) / elite (`_b`) form. */
export const extraSlotId = (k, golden = false) => `mod_diy_${k}_${golden ? 'b' : 'a'}`;
/** The tier range a mod slot may take (the shop's own 1..6). */
export const EXTRA_TIERS = Object.freeze([1, 2, 3, 4, 5, 6]);
export const MAX_EXTRA_SLOTS = 12;

/** The status the game's own tier-5 slot uses, per form — the only two `backups.units` forms that exist. */
const SLOT_STATUS = Object.freeze({
  normal: Object.freeze({ phase: 2, level: 1, skillLevel: 4, equipLevel: 0 }),
  elite: Object.freeze({ phase: 2, level: 60, skillLevel: 7, equipLevel: 1 }),
});

/** The price of a chess of `tier` (config economy.chessPrice[tier].normal), else the game's own default of 3. */
function priceOf(tier, economy) {
  const row = economy && typeof economy === 'object' ? economy.chessPrice?.[String(tier)] : null;
  const p = row && Number.isFinite(row.normal) ? row.normal : row && Number.isFinite(row.golden) ? row.golden : null;
  return Number.isFinite(p) ? p : 3;
}

/**
 * The chess record of a mod-owned 自选 slot: the game's own slot shape (`chess_char_5_diy1_a`) at `tier`.
 * @param {number} k the slot's number (1-based)
 * @param {number} tier 1..6
 * @param {boolean} golden the `_b` elite form
 * @param {any} economy data/config.json's `economy`
 */
export function extraSlotRecord(k, tier, golden, economy) {
  const id = extraSlotId(k, golden);
  return Object.freeze({
    chessId: id,
    baseId: extraSlotId(k, false),
    goldenId: extraSlotId(k, true),
    isGolden: !!golden,
    tier,
    identifier: 400 + k * 4 + (golden ? 1 : 0),
    isHidden: false,
    isDiy: true,
    visible: false,
    chessType: 'DIY',
    backup: { charId: null, tmplId: null, skillIndex: 0, uniEquipId: null, potRank: 0 },
    shopSortId: 300 + k,
    charId: null,
    name: '甄选干员',
    appellation: null,
    rarity: null,
    profession: null,
    subProfessionId: null,
    subProfessionName: null,
    position: null,
    nationId: null,
    bonds: Object.freeze([]),
    garrisonIds: Object.freeze([]),
    price: priceOf(tier, economy),
    sellPrice: 1,
    upgradeNum: golden ? 0 : 3,
    upgradeChessId: golden ? null : extraSlotId(k, true),
    status: golden ? SLOT_STATUS.elite : SLOT_STATUS.normal,
    stats: null,
    immunities: null,
    rangeId: null,
    rangeGrid: null,
    dmgType: null,
    attackKind: null,
    projectile: null,
    canHitFly: false,
    targetPriority: null,
    trait: null,
    skill: null,
    talents: Object.freeze([]),
    tokens: Object.freeze([]),
    module: null,
    assets: null,
    diyRequirement: 'TIER_6',
  });
}

/** Whether `id` is one of the mod's own slot ids (either form). */
export const isExtraSlotId = (id) => /^mod_diy_\d+_[ab]$/.test(String(id ?? ''));

/** The number of a mod slot id, or null. */
export const extraSlotIndexOf = (id) => {
  const m = /^mod_diy_(\d+)_[ab]$/.exec(String(id ?? ''));
  return m ? Number(m[1]) : null;
};

/**
 * What the mod's own slots add to a data source, or null when there are none: `{ chess, slots }` — the `isDiy` records
 * and the `diy.slots` entries, to be merged into `chess` and `backups.diy` on BOTH processes (the prep side reads them
 * through `ps.gd`, the browser through its own data store — see the overlay's `patchDataStore`).
 * @param {Array<{ k: number, tier: number }>} extras
 * @param {any} economy data/config.json's `economy`
 */
export function extraDiyData(extras, economy = null) {
  const chess = {};
  const slots = {};
  for (const e of Array.isArray(extras) ? extras : []) {
    const k = Math.trunc(Number(e?.k));
    const tier = Math.trunc(Number(e?.tier));
    if (!Number.isInteger(k) || k < 1 || k > MAX_EXTRA_SLOTS) continue;
    if (!EXTRA_TIERS.includes(tier)) continue;
    chess[extraSlotId(k, false)] = extraSlotRecord(k, tier, false, economy);
    chess[extraSlotId(k, true)] = extraSlotRecord(k, tier, true, economy);
    slots[extraSlotId(k, false)] = Object.freeze({ tier, goldenId: extraSlotId(k, true), shopLevel: tier, requirement: 'TIER_6' });
  }
  return Object.keys(chess).length ? { chess, slots } : null;
}

/**
 * `backups.diy` with the mod's slots merged in. `prototypes` / `locked` are copied from the game's own tier-5 lists for
 * every extra tier, because a pick is only legal when the operator is in `diy.ownedPool` or in `diy.prototypes[tier]`
 * (shared/diy.js checkDiyPick) — without them a mod slot could only ever hold an owned 6★, never a 原型干员.
 * @param {any} diy data/backups.json's `diy`
 * @param {Array<{ k: number, tier: number }>} extras
 */
export function extraDiyTable(diy, extras) {
  const data = extraDiyData(extras, null);
  if (!data || !diy || typeof diy !== 'object') return diy;
  const tiers = [...new Set(extras.map((e) => Math.trunc(Number(e?.tier))))].filter((t) => EXTRA_TIERS.includes(t));
  const prototypes = { ...(diy.prototypes || {}) };
  const locked = { ...(diy.locked || {}) };
  const fromProto = prototypes[5] || prototypes['5'] || [];
  const fromLocked = locked[5] || locked['5'] || {};
  for (const t of tiers) {
    if (!prototypes[t]) prototypes[t] = fromProto;
    if (!locked[t]) locked[t] = fromLocked;
  }
  return { ...diy, slots: { ...(diy.slots || {}), ...data.slots }, prototypes, locked };
}

// ---------------------------------------------------------------------------------------------------------------------
// 内容安装的那条缝 (the content-install seam)
//
// Both halves of the mod need to run something immediately around a Battle's content install: the battle-side extra
// strategies install their band buffs right after it, and the 自选位 numbers have to be swapped into `support.gameData()`
// for exactly as long as it runs (the bond / 特质 / band installers read their `bb` then and re-apply it from their
// closures afterwards).
//
// Up to 0.2.6 that was one method call — `this._safe(() => installContent(this, …), 'installContent')` — so wrapping
// `Battle.prototype._safe` wrapped the install, which is what the mod did. **0.3.0 calls `installContent(this, …)`
// straight from the constructor and the label is gone**, so the wrapper went quiet: extras stopped being installed and
// the numbers stopped being swapped, both without an error anywhere.
//
// The bracket is rebuilt out of the two property accesses that now sit on either side of the call (server/sim/Battle.js
// constructor):
//
//     this.contentMode = opts.content ?? 'full';            ← assigned immediately before the install
//     try { installContent(this, { mode: this.contentMode, … }); } …
//     if (this.contentFault) { … }                          ← the first read after it returns
//
// Neither is created as an own property on a healthy battle — `contentFault` only ever appears when a DSL kit throws
// (content/index.js) — so prototype accessors catch both moments for every construction, in-page and server-side alike.
// Nothing else in the game assigns `contentMode`, so the accessor fires exactly once per battle.

/** The hook lists of one already-patched Battle class, keyed by its prototype. */
const contentSeams = new WeakMap();

/**
 * Register hooks around every content install of `Battle`. Idempotent per class: the accessors go in once, later calls
 * only append hooks. `beforeInstall` runs in registration order just before the install, `afterInstall` just after it
 * returns — the order matters, so register the hooks that must run innermost first.
 *
 * @param {Function} Battle  the game's Battle class (`server/sim/Battle.js` / `/sim/Battle.js`)
 * @param {{ beforeInstall?: (battle: object) => void, afterInstall?: (battle: object) => void }} hooks
 * @returns {boolean} whether the class carries the seam (false = nothing to hang the hooks on)
 */
export function patchContentSeam(Battle, { beforeInstall = null, afterInstall = null } = {}) {
  const proto = Battle?.prototype;
  if (!proto) return false;

  let seam = contentSeams.get(proto);
  if (!seam) {
    seam = { before: [], after: [], armed: new WeakSet(), done: new WeakSet() };
    const run = (list, battle) => { for (const fn of list) { try { fn(battle); } catch { /* the install must go on */ } } };
    // the install has returned: run the after-hooks once per battle
    const finish = (battle) => {
      if (!seam.armed.has(battle) || seam.done.has(battle)) return;
      seam.done.add(battle);
      run(seam.after, battle);
    };
    try {
      Object.defineProperty(proto, 'contentMode', {
        configurable: true,
        get() { return this.__modContentMode; },
        set(v) {
          this.__modContentMode = v; // the install reads it back immediately, before any other assignment
          if (seam.armed.has(this)) return;
          seam.armed.add(this);
          run(seam.before, this);
        },
      });
      Object.defineProperty(proto, 'contentFault', {
        configurable: true,
        get() { finish(this); return this.__modContentFault; },
        set(v) { this.__modContentFault = v; finish(this); },
      });
    } catch {
      return false; // a future version already defines one of them: leave the class alone rather than half-patch it
    }
    contentSeams.set(proto, seam);
  }
  if (typeof beforeInstall === 'function') seam.before.push(beforeInstall);
  if (typeof afterInstall === 'function') seam.after.push(afterInstall);
  return true;
}
