// server-patch.mjs — the whole gameplay half of Stronghold-Luck.
//
// Nothing here writes to the game folder: the game's own modules are imported from their real paths (so they are the
// very same module instances the server uses) and things are replaced on the live objects:
//
//   1. shared/protocol.js  C2S[...]                     the mod's intents (see the list at the top of installServerPatch);
//                                                       the table is a plain, unfrozen object and both server/net.js
//                                                       and the browser validate live
//   2. Match.prototype.handle                           routes those intents before the game's own dispatch (which reads
//                                                       a GAME_TYPES Set snapshotted at module load)
//   3. PlayerState.prototype.privateView               adds `shop.modPickable` (what may go in a shop slot right now,
//                                                       plus `pool`: every card this match's protocol deals, at any
//                                                       level — the auto-reverse target list) plus
//                                                       `shop.modPickable.quota` (this round's pick budget),
//                                                       `modSpeed` (the match's current battle speed) and `modAuto`
//                                                       (the last 自动倒转 batch and its tally)
//   4. Match.prototype.start                           applies the remembered battle speed to every new match
//
// and adds two methods:
//   PlayerState.prototype.modPickSlot(slot, id)   fills an unsold shop slot with the chess/item you asked for
//   PlayerState.prototype.modBuyDirect(id)        buys a chess/item straight into your hand, no shop slot, no roll
//
// plus the 自动倒转 loop (g.modAuto, see "the auto reverse" below): buy a cheap operator → cash in the coins it
// drops → sell it back, on repeat, until the seat readies or the money runs out.
//
// It also RECORDS the match (the "third round" feature, see the recorder section): every seat's actions (human AND
// bot), each round's enemy plan, the human's full private view, and the combat/settle outcome, one JSON line per
// event, to <mod>/logs/session-*.jsonl. `--no-log` (launcher) turns it off. That log is the raw material for later
// work on the game AI.
//
// Fail-soft: installServerPatch() reports what it could not find and returns a status; the caller still starts the
// game (unmodded) rather than dying.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { baseChessId, createUnitPatcher, normalizeUnitCfg, UNIT_SCOPES, unitCovers } from '../public/unit-rules.js';
import { autoCardAllowedNow, autoClassOf } from '../public/auto-rules.js';
import {
  applySlotOverride, createSlotPatcher, EXTRA_TIERS, extraDiyData, extraDiyTable, extraSlotId, hasNumberEdits,
  isExtraSlotId, MAX_EXTRA_SLOTS, normalizeSlotCfg, patchGameData, slotBaseId,
} from '../public/slot-rules.js';

export const PICK_TYPE = 'g.modPick';
export const BUY_TYPE = 'g.modBuy';
export const CONFIG_TYPE = 'g.modConfig';
export const SPEED_TYPE = 'g.modSpeed';
export const AUTO_TYPE = 'g.modAuto';
/** the sandbox (see "the sandbox" below): extra strategies, the deploy unlock, and its deploy-cap knob */
export const BANDS_TYPE = 'g.modBands';
export const PLACE_TYPE = 'g.modPlace';
/** the sandbox's per-operator overrides (see "the unit rules" below): 携带技能 / 技力 / 属性 */
export const UNIT_TYPE = 'g.modUnit';
/** the shop bond filter (see "the shop bond filter" below): roll only the operators whose bonds are all chosen */
export const SHOPFILTER_TYPE = 'g.modShopFilter';
/** the 自选位 kit (see "the 自选位 rules" below): per-slot 盟约 / 特质 overrides for the player's 自选编队 pieces */
export const DIY_TYPE = 'g.modDiy';
/**
 * The master switches (see "the master switches" below). One key per GROUP of gameplay-changing features; turning one
 * off must leave the match exactly as it would be with that feature never installed, INCLUDING its live state, so the
 * handler rolls back what is already in effect rather than only refusing new messages.
 *
 * 倍速 (g.modSpeed) and 自动倒转 (g.modAuto) are deliberately NOT in this table: neither changes the simulation (speed
 * is presentation — see the speed section — and the auto loop only spends the seat's own funds on its own purchases),
 * so they stay available however the gameplay switches are set.
 */
export const ENABLE_TYPE = 'g.modEnable';
export const FEATURE_KEYS = Object.freeze([
  'shop',          // 自选商店 + 直购 + 每回合额度 (g.modPick / g.modBuy / g.modConfig)
  'sandboxBands',  // 沙盒：策略叠加 (g.modBands)
  'sandboxPlace',  // 沙盒：地块解锁 + 布阵上限 (g.modPlace)
  'sandboxUnit',   // 沙盒：单位（技能 / 技力 / 属性）(g.modUnit)
  'diy',           // 自选位：盟约 / 特质 / 数值 (g.modDiy.slots)
  'diyExtra',      // 自造位子 (g.modDiy.extra)
  'shopFilter',    // 阵营锁 (g.modShopFilter)
]);
/** Every group ON. A fresh process behaves exactly as it did before the switches existed. */
export const featureDefaults = () => Object.fromEntries(FEATURE_KEYS.map((k) => [k, true]));
/** per-round budget spent: an action is refused with this code once the round's picks+buys are used up */
export const MOD_LIMIT = 'MOD_LIMIT';

const MOD_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_PICK_LIMIT = 3;
const MAX_PICK_LIMIT = 99;
/** battle speed bounds (game seconds per real second). 2 is the game's own forced baseline. */
export const MIN_SPEED = 1;
export const MAX_SPEED = 16;
/** The game's own baseline battle speed (server/match/fields.js GAME_SPEED) — every real-time pacing number in the game
 *  is quoted at it, which is why the presentation steps below are divided by `speed / GAME_SPEED`. */
const GAME_SPEED = 2;
/** Floor for a shortened presentation step: below this the client may not have painted the new phase yet. */
const MIN_STEP_MS = 120;

/** PlayerState verbs that represent a seat's action, wrapped for the recorder (top level only — internal calls like
 *  acquireChess/_mergeChess are NOT wrapped, so nothing is double counted). */
const PS_ACTIONS = ['buy', 'refresh', 'freeze', 'levelUp', 'sell', 'move', 'equip', 'useArt', 'destroy', 'pickReward', 'setReady', 'modPickSlot', 'modBuyDirect'];
/** Match-level actions that take the acting PlayerState first. */
const MATCH_ACTIONS = ['pickBand', 'pickCard', 'setAutoplay'];

/** Result shapes of Match.handle (server/match/Match.js: `OK` / `fail`). */
const OK = Object.freeze({ ok: true });
const fail = (error, detail) => (detail ? { error, detail } : { error });

const isPickSlot = (v) => Number.isInteger(v) && v >= 0 && v <= 15;
const isPickId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isPickLimit = (v) => Number.isInteger(v) && v >= 0 && v <= MAX_PICK_LIMIT;
const isSpeed = (v) => Number.isInteger(v) && v >= MIN_SPEED && v <= MAX_SPEED;
const isBool = (v) => typeof v === 'boolean';
/** The master-switch payload `{ [featureKey]: boolean }`. Unknown keys are dropped by the handler, never refused:
 *  the panel and the server are deployed together, but a stale tab must not be able to wedge the switch. */
const isFeatures = (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every(isBool);
/** cycles per call: the panel re-sends while the toggle is on, so this is a batch size, not a run length */
export const MIN_CYCLES = 1;
export const MAX_CYCLES = 2000;
const isCycles = (v) => Number.isInteger(v) && v >= MIN_CYCLES && v <= MAX_CYCLES;
/** How the auto buy/sell gets its target in: 'shop' = the game's own shop (default), 'direct' = the mod's 直购. */
const isAutoMode = (v) => v === 'shop' || v === 'direct';
/** the 自动买卖 targets: the ticked catalogue ids, in the panel's order. Capped — the catalogue is 13 long, and a
 *  caller sending more than that is not describing this feature. The CLASS of each id is looked up server-side. */
const MAX_AUTO_TARGETS = 32;
const isAutoTargets = (v) => Array.isArray(v) && v.length > 0 && v.length <= MAX_AUTO_TARGETS && v.every(isPickId);

/** the sandbox: extra strategies per seat (the primary one is still the game's own draft pick), deploy unlock + cap */
/** an id list (strategy ids / bond ids). NO length cap (author, 2026-10-10: the stacking limit was the mod's own
 *  8, the engine has none — handleBands bounds the set by the match's own allowed strategies anyway). */
const isIdList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.length > 0 && x.length <= 64);
const isDeployCap = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 99);
/** the shop bond filter payload: the 阵营锁 switch plus the bond ids it keeps. */
const isShopFilter = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && typeof v.on === 'boolean' && isIdList(v.bonds);
const isPlainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/**
 * The 自选位 payload: `{ slots: { [slotBaseId]: { bonds?, addBonds?, garrisons? } | null } }`. A garrison entry is an id
 * or `{ id, bb? }`; `{}` clears every slot. Structural only — normalizeSlotCfg is the real gate (it checks the ids
 * against the match's own bond / garrison tables and clamps the numbers).
 */
const isDiySlotCfg = (s) => s === null || (isPlainObj(s)
  && (s.bonds == null || isIdList(s.bonds))
  && (s.addBonds == null || isIdList(s.addBonds))
  && (s.garrisons == null || (Array.isArray(s.garrisons) && s.garrisons.length <= 16
    && s.garrisons.every((g) => typeof g === 'string' || (isPlainObj(g) && typeof g.id === 'string')))));
const isDiySlots = (v) => isPlainObj(v) && Object.keys(v).length <= 64 && Object.values(v).every(isDiySlotCfg);
/** One mod-owned slot: `{ k, tier, pick }` (the pick is the same wire shape the game's own 自选编队 uses). */
const isDiyPickWire = (p) => p === null || (isPlainObj(p) && typeof p.charId === 'string' && p.charId.length > 0 && p.charId.length <= 64
  && (p.skillIndex == null || (Number.isInteger(p.skillIndex) && p.skillIndex >= 0 && p.skillIndex <= 9))
  && (p.uniEquipId == null || (typeof p.uniEquipId === 'string' && p.uniEquipId.length <= 64)));
const isDiyExtras = (v) => v == null || (Array.isArray(v) && v.length <= MAX_EXTRA_SLOTS && v.every((e) => isPlainObj(e)
  && Number.isInteger(e.k) && e.k >= 1 && e.k <= MAX_EXTRA_SLOTS && EXTRA_TIERS.includes(e.tier) && isDiyPickWire(e.pick)));
const isDiyCfg = (v) => v === null || (isPlainObj(v)
  && (v.slots == null || isDiySlots(v.slots)) && (v.extra == null || isDiyExtras(v.extra)));
/** The 携带技能 overrides: `{ [slotBaseId]: 0..9 }`. */
const isDiySkills = (v) => v == null || (isPlainObj(v) && Object.keys(v).length <= 64
  && Object.values(v).every((n) => Number.isInteger(n) && n >= 0 && n <= 9));
/** The 模组 overrides: `{ [slotBaseId]: uniEquipId | null }` (null = 不带模组). */
const isDiyMods = (v) => v == null || (isPlainObj(v) && Object.keys(v).length <= 64
  && Object.values(v).every((x) => x === null || isPickId(x)));

/**
 * The unit-rules payload: the whole config rides in one field (`{ cfg }`), structurally checked here and clamped by
 * normalizeUnitCfg. `null` = back to vanilla. Kept loose on purpose — the clamp is the real gate.
 */
const isUnitCfg = (v) => v === null || (typeof v === 'object' && !Array.isArray(v)
  && typeof v.on === 'boolean'
  && (v.pin === undefined || typeof v.pin === 'boolean')
  && UNIT_SCOPES.includes(v.scope)
  && (v.id == null || (typeof v.id === 'string' && v.id.length <= 64))
  && (v.skill == null || (Number.isInteger(v.skill) && v.skill >= 0 && v.skill <= 9))
  && (v.spCost == null || (typeof v.spCost === 'number' && Number.isFinite(v.spCost)))
  && (v.initSp == null || (typeof v.initSp === 'number' && Number.isFinite(v.initSp)))
  && (v.mult == null || (typeof v.mult === 'number' && Number.isFinite(v.mult)))
  && (v.stats == null || (typeof v.stats === 'object' && !Array.isArray(v.stats))));
/**
 * Strategies whose 每回合给钱 buff **assigns** `ev.income` instead of adding to it (老鲤 利滚利: the round it pays, the
 * income IS its number). Every other strategy's income hook adds. Since the assignments discard whatever ran before
 * them, these have to run FIRST when they are an extra strategy, or the additive ones on top of them would be wiped.
 * (When one of these is the primary pick the game already runs it first, so nothing special is needed.)
 */
const INCOME_ASSIGN_BANDS = new Set(['band_lmlee']);

/**
 * 鸭爵 / 神秘顾客. Its换敌 effect is not a `band:` handler but a GLOBAL one (`registry.global('bands_ducklord', …)`,
 * sim/content/bands/meta.js:471-514), and its "do I hold it" gate reads `ctx.bandId()` / `ctx.teammates()` — both live
 * reads of each seat's `ps.bandId` (effectsMeta.js:480 / :694). `ps.modBands` is invisible to it, so as an EXTRA
 * strategy the whole handler is skipped. This pair lets the wrapped dispatch run it for such a seat (see duckAsExtra).
 */
const DUCK_BAND = 'band_ducklord';
const DUCK_GLOBAL = 'global:bands_ducklord';

/**
 * Install the pick-your-own shop into a running game process.
 * @param {string} gameRoot absolute path of the Stronghold-Protocol checkout
 * @param {{ info: Function, warn: Function, error: Function }} log
 * @param {{ pickLimit?: number, record?: boolean, logDir?: string, combatSpeed?: number }} [opts]
 *        pickLimit — actions allowed per round (直购 + 自选 共用), 0 = 不限, default 3
 *        record    — write the match log, default off
 *        logDir    — where those JSONL files go; default <mod>/logs
 *        combatSpeed — battle speed every match starts at (game seconds per real second); 2 = the game's own
 * @returns {Promise<{ ok: boolean, missing: string[], logFile: string|null }>}
 */
export async function installServerPatch(gameRoot, log = console, opts = {}) {
  const imp = (rel) => import(pathToFileURL(path.join(gameRoot, rel)).href);
  const missing = [];

  const [protocol, constants, matchMod, psMod, metaMod, boardMod, battleMod, bandsMod, simdataMod, skillsMod, diyMod, diyDataMod, bondsMetaMod, gamedataMod, supportMod] = await Promise.all([
    imp('shared/protocol.js'),
    imp('shared/constants.js'),
    imp('server/match/Match.js'),
    imp('server/match/PlayerState.js'),
    imp('server/match/effectsMeta.js'),
    imp('server/match/board.js'),
    imp('server/sim/Battle.js'),
    imp('server/sim/content/bands.js'),
    imp('server/sim/simdata.js'),
    imp('server/sim/skills.js'),
    imp('server/match/player/diy.js'),
    imp('shared/diy.js'),
    imp('server/match/bondsMeta.js'),
    imp('server/match/gamedata.js'),
    imp('server/sim/content/support/index.js'),
  ]);
  const { DataSource } = simdataMod;
  const { SkillRuntime } = skillsMod;

  const { C2S } = protocol;
  const { ERR, PHASE } = constants;
  const { Match } = matchMod;
  const { DELAYS } = matchMod;
  const { PlayerState } = psMod;
  const { EffectDispatcher } = metaMod;
  const { Battle } = battleMod;
  const board = boardMod;
  const bands = bandsMod;

  // the shared state: the per-round budget, the battle speed, and the recorder sink
  const state = {
    pickLimit: isPickLimit(opts.pickLimit) ? opts.pickLimit : DEFAULT_PICK_LIMIT,
    // the battle speed the mod keeps for the process: applied to the current match and to every later one
    speed: isSpeed(opts.combatSpeed) ? opts.combatSpeed : 2,
    record: !!opts.record,
    logDir: opts.logDir || path.join(MOD_ROOT, 'logs'),
    logFile: null,
    // the last 自动倒转 request, echoed to the panel:
    // { on, cardId, cycles, equipCoins, idCard, done, gold, layers, stop }
    auto: null,
    // the sandbox: the deploy unlock (process-wide, see "the sandbox" below) and the deploy cap it sets (null = leave
    // the game's own 8 alone). The extra strategies are per seat (`ps.modBands`).
    sandbox: { place: false, cap: null },
    // the unit rules (see "the unit rules" below): the config the panel last sent, plus the seat that sent it (the
    // 换技能 half is that seat's alone — the stats / 技力 half is process-wide when the scope is 全场).
    unit: null,
    // the master switches (g.modEnable): every gameplay-changing group starts ON, so a session that never touches them
    // behaves exactly as before they existed. Living on `state` (process-wide) is the point: a switch flipped in one
    // match stays flipped for the next one, and there is nothing per-match to lose.
    enable: featureDefaults(),
  };
  if (state.record) {
    try {
      state.logFile = openLog(state.logDir);
    } catch (e) {
      log.warn(`打不开日志目录，本局不记录：${e?.message || e}`);
      state.record = false;
    }
  }

  // ---- 1. the intents --------------------------------------------------------------------------------
  if (!C2S || typeof C2S !== 'object') return { ok: false, missing: ['shared/protocol.js C2S'], logFile: null };
  if (!Object.hasOwn(C2S, PICK_TYPE)) {
    C2S[PICK_TYPE] = { slot: isPickSlot, id: isPickId };
    log.info(`registered intent ${PICK_TYPE}`);
  }
  if (!Object.hasOwn(C2S, BUY_TYPE)) {
    C2S[BUY_TYPE] = { id: isPickId };
    log.info(`registered intent ${BUY_TYPE}`);
  }
  if (!Object.hasOwn(C2S, CONFIG_TYPE)) {
    C2S[CONFIG_TYPE] = { pickLimit: isPickLimit };
    log.info(`registered intent ${CONFIG_TYPE}`);
  }
  if (!Object.hasOwn(C2S, SPEED_TYPE)) {
    C2S[SPEED_TYPE] = { n: isSpeed };
    log.info(`registered intent ${SPEED_TYPE}`);
  }
  if (!Object.hasOwn(C2S, AUTO_TYPE)) {
    C2S[AUTO_TYPE] = { on: isBool, cardIds: isAutoTargets, cycles: isCycles, equipCoins: isBool, idCard: isBool, refresh: isBool, mode: isAutoMode };
    log.info(`registered intent ${AUTO_TYPE}`);
  }
  if (!Object.hasOwn(C2S, BANDS_TYPE)) {
    C2S[BANDS_TYPE] = { ids: isIdList };
    log.info(`registered intent ${BANDS_TYPE}`);
  }
  if (!Object.hasOwn(C2S, PLACE_TYPE)) {
    C2S[PLACE_TYPE] = { on: isBool, cap: isDeployCap };
    log.info(`registered intent ${PLACE_TYPE}`);
  }
  if (!Object.hasOwn(C2S, UNIT_TYPE)) {
    C2S[UNIT_TYPE] = { cfg: isUnitCfg };
    log.info(`registered intent ${UNIT_TYPE}`);
  }
  if (!Object.hasOwn(C2S, SHOPFILTER_TYPE)) {
    C2S[SHOPFILTER_TYPE] = { on: isBool, bonds: isIdList };
    log.info(`registered intent ${SHOPFILTER_TYPE}`);
  }
  if (!Object.hasOwn(C2S, DIY_TYPE)) {
    C2S[DIY_TYPE] = { slots: isDiySlots, extra: isDiyExtras, skills: isDiySkills, mods: isDiyMods };
    log.info(`registered intent ${DIY_TYPE}`);
  }
  if (!Object.hasOwn(C2S, ENABLE_TYPE)) {
    C2S[ENABLE_TYPE] = { features: isFeatures };
    log.info(`registered intent ${ENABLE_TYPE}`);
  }

  // ---- 2. the router (+ the raw-intent log) ----------------------------------------------------------
  if (typeof Match?.prototype?.handle !== 'function') {
    missing.push('Match.prototype.handle');
  } else {
    const origHandle = Match.prototype.handle;
    Match.prototype.handle = function handle(playerId, msg) {
      let res;
      if (msg && msg.t === PICK_TYPE) res = handlePick(this, playerId, msg, state, ERR);
      else if (msg && msg.t === BUY_TYPE) res = handleBuy(this, playerId, msg, state, ERR);
      else if (msg && msg.t === CONFIG_TYPE) res = handleConfig(this, playerId, msg, state, ERR);
      else if (msg && msg.t === SPEED_TYPE) res = handleSpeed(this, playerId, msg, state, ERR);
      else if (msg && msg.t === AUTO_TYPE) res = handleAuto(this, playerId, msg, state, ERR, log);
      else if (msg && msg.t === BANDS_TYPE) res = handleBands(this, playerId, msg, state, ERR);
      else if (msg && msg.t === PLACE_TYPE) res = handlePlace(this, playerId, msg, state, ERR);
      else if (msg && msg.t === UNIT_TYPE) res = handleUnit(this, playerId, msg, state, ERR);
      else if (msg && msg.t === SHOPFILTER_TYPE) res = handleShopFilter(this, playerId, msg, state, ERR);
      else if (msg && msg.t === DIY_TYPE) res = handleModDiy(this, playerId, msg, state, ERR);
      else if (msg && msg.t === ENABLE_TYPE) res = handleEnable(this, playerId, msg, state, ERR);
      else res = origHandle.call(this, playerId, msg);
      recordIntent(state, log, this, playerId, msg, res);
      return res;
    };
    log.info('hooked Match.prototype.handle');
  }

  // ---- 3. the slot swap, the direct buy, and the pickable/quota view ---------------------------------
  if (typeof PlayerState?.prototype?.privateView !== 'function') {
    missing.push('PlayerState.prototype.privateView');
  } else if (typeof PlayerState.prototype.modPickSlot !== 'function') {
    PlayerState.prototype.modPickSlot = function modPickSlot(slotIdx, id) {
      return pickSlot(this, slotIdx, id, { ERR, PHASE });
    };
    PlayerState.prototype.modBuyDirect = function modBuyDirect(id) {
      return directBuy(this, id, { ERR });
    };
    const origPrivateView = PlayerState.prototype.privateView;
    PlayerState.prototype.privateView = function privateView() {
      const view = origPrivateView.call(this);
      try {
        if (view && view.shop) {
          view.shop.modPickable = { ...pickable(this), quota: quotaView(this, state) };
          // the 阵营锁: this seat's own setting, the bonds it may name, and how many operators pass it right now
          view.shop.modShopFilter = shopFilterView(this);
        }
        // the battle speed the match is running at — the panel marks the button from this (never its own memory)
        if (view) view.modSpeed = speedView(this, state);
        // and how fast the fixed presentation steps are running (see installPresentationScale)
        if (view) view.modPace = paceView(this, state);
        // the last 自动倒转 result — the panel marks its button and shows the tally from this too
        if (view) view.modAuto = state.auto;
        // the sandbox: this seat's extra strategies and the process-wide deploy unlock
        if (view) view.modSandbox = sandboxView(this, state);
        // the unit rules: the config the server holds (the panel compares its own against this before pushing)
        if (view) view.modUnits = state.unit;
        // the 自选位 kit: the per-slot overrides the server holds (process-wide — the def patcher cannot see a seat)
        if (view) view.modDiy = { slots: diyCfgView(), extra: diyExtrasView(), skills: { ...diySkills }, mods: { ...diyMods } };
        // the master switches: the panel renders FROM this, not from its own memory, so a second tab (or a reload)
        // shows the switches the server is actually honouring
        if (view) view.modEnable = { ...state.enable };
      } catch (e) {
        log.warn('modPickable failed', e?.message || e);
      }
      return view;
    };
    log.info('hooked PlayerState (privateView + modPickSlot + modBuyDirect)');
  }

  // ---- 4. the battle speed sticks to the match --------------------------------------------------------
  if (typeof Match?.prototype?.start !== 'function') {
    missing.push('Match.prototype.start');
  } else {
    const origStart = Match.prototype.start;
    Match.prototype.start = function start(...args) {
      // the lobby builds a fresh Match per game; the speed the player chose survives across those
      if (state.speed && state.speed !== this.gameSpeed) {
        try { applyGameSpeed(this, state.speed); } catch (e) { log.warn('apply speed failed', e?.message || e); }
      }
      state.auto = null; // a new game starts with the auto reverse off, whatever the last one left behind
      return origStart.apply(this, args);
    };
    log.info('hooked Match.prototype.start');
  }

  // ---- 4b. the fixed presentation steps follow the battle speed ---------------------------------------
  missing.push(...installPresentationScale({ Match, DELAYS, state, log }));

  // ---- 5. the sandbox --------------------------------------------------------------------------------
  const sandboxMissing = installSandbox({ Match, PlayerState, EffectDispatcher, board, Battle, bands, state, log });
  missing.push(...sandboxMissing);

  // ---- 5a. the shop bond filter (阵营锁) --------------------------------------------------------------
  missing.push(...installShopFilter({ PlayerState, log }));


  // ---- 5b. the unit rules (技能 / 技力 / 属性) ---------------------------------------------------------
  missing.push(...installUnitRules({ PlayerState, DataSource, SkillRuntime, state, log }));

  // ---- 5c. the 自选位 kit (盟约 / 特质 / 数值) ---------------------------------------------------------
  missing.push(...installSlotRules({ PlayerState, Battle, GameData: gamedataMod.GameData, DataSource, support: supportMod, diyMod, diyDataMod, bondsMetaMod, log }));

  // ---- 6. the recorder -------------------------------------------------------------------------------
  if (state.record) {
    const recMissing = installRecorder({ Match, PlayerState, state, log });
    if (recMissing.length) log.warn(`录制锚点没找到（这几类事件不会出现）：${recMissing.join(', ')}`);
    else log.info('recorder installed');
  }

  if (missing.length) log.warn(`anchors not found (the mod is partially inert): ${missing.join(', ')}`);
  return { ok: missing.length === 0, missing, logFile: state.logFile };
}

// -----------------------------------------------------------------------------------------------------
// the per-round budget
// -----------------------------------------------------------------------------------------------------

/**
 * This seat's budget for the current round. The counter lives outside `ps.round` because startRound replaces that
 * whole object; a round change is detected lazily by comparing `m.round`.
 */
function quota(ps) {
  const r = ps?.m?.round ?? 0;
  if (!ps.__modQuota || ps.__modQuota.round !== r) ps.__modQuota = { round: r, used: 0 };
  return ps.__modQuota;
}

/** 0 = unlimited. */
const overQuota = (ps, state) => state.pickLimit > 0 && quota(ps).used >= state.pickLimit;

/** What the panel reads: how many of this round's actions are spent, and the cap (0 = 不限). */
function quotaView(ps, state) {
  return { used: quota(ps).used, limit: state.pickLimit };
}

/** What the panel reads: the speed the match is actually running at (2 = the game's own baseline). */
function speedView(ps, state) {
  const n = Number(ps?.m?.gameSpeed);
  return Number.isFinite(n) && n > 0 ? n : state.speed;
}

/**
 * What the panel reads: how fast the fixed presentation steps (see installPresentationScale) are running. 1 = the game's
 * own pacing; below 1 the 结算 / 回合开始 / 战斗结束 waits have been shortened to match the battle speed.
 */
function paceView(ps, state) {
  const n = speedView(ps, state);
  let solo = false;
  try { solo = !!ps?.m?.soloUntimed; } catch { solo = false; }
  return { delayScale: solo && n > GAME_SPEED ? GAME_SPEED / n : 1, solo };
}

// -----------------------------------------------------------------------------------------------------
// the intent owners
// -----------------------------------------------------------------------------------------------------

/** Mirrors Match.handle's guard (bots/left can't act, spectators only watch, no acting after the match ended). */
function seatFor(match, playerId) {
  const ps = match.players?.get(playerId) || match.spectators?.get(playerId);
  if (!ps || ps.isBot || ps.left) return { error: fail('NOT_IN_ROOM') };
  if (ps.spectator) return { error: fail('SPECTATOR') };
  if (match.disposed || match.ended) return { error: fail('WRONG_PHASE') };
  return { ps };
}

/**
 * Shared body of the two mod actions: gate, run, flush, then bill the round's budget only on success.
 *
 * `bills(ps)` says whether THIS action costs a pick. 装备 does not (author, 2026-10-10): the budget is there to pace
 * how fast you can stuff 干员 into your board, and an item is bought and equipped on the spot. So placing or buying an
 * item is free AND still possible after the round's budget is spent — neither the gate nor the counter touches it.
 */
function runModAction(match, playerId, state, ERR, name, body, bills = null) {
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  const ps = seat.ps;
  let charged = true;
  try { charged = bills ? !!bills(ps) : true; } catch { charged = true; }
  if (charged && overQuota(ps, state)) {
    return fail(MOD_LIMIT, `本回合自选次数已用完（${state.pickLimit}）`);
  }
  let res;
  try {
    res = body(ps);
  } catch (e) {
    match.reportError?.(name, e);
    res = fail('INTERNAL');
  }
  // bill BEFORE the flush: the pushed private view carries the quota, so counting after it would show the panel the
  // value from one action ago (and nothing else flushes until the next one).
  if (charged && !(res && res.error)) quota(ps).used++;
  try {
    match.flush();
  } catch (e) {
    match.reportError?.('flush', e);
  }
  return res && res.error ? res : OK;
}

/** Whether `id` names an operator rather than a piece of equipment (the same test directBuy uses). */
const isChessId = (ps, id) => !!ps?.gd?.chess?.(id);

function handlePick(match, playerId, msg, state, ERR) {
  if (!state.enable.shop) return fail(ERR.BAD_TARGET, '自选商店已关闭（总开关）');
  return runModAction(match, playerId, state, ERR, 'modPick', (ps) => ps.modPickSlot(msg.slot, msg.id), (ps) => isChessId(ps, msg.id));
}

function handleBuy(match, playerId, msg, state, ERR) {
  if (!state.enable.shop) return fail(ERR.BAD_TARGET, '自选商店已关闭（总开关）');
  return runModAction(match, playerId, state, ERR, 'modBuy', (ps) => ps.modBuyDirect(msg.id), (ps) => isChessId(ps, msg.id));
}

/** g.modConfig { pickLimit } — the panel sets the per-round budget (0 = 不限). Not billed to the budget itself. */
function handleConfig(match, playerId, msg, state, ERR) {
  if (!state.enable.shop) return fail(ERR.BAD_TARGET, '自选商店已关闭（总开关）');
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isPickLimit(msg.pickLimit)) return fail(ERR.BAD_TARGET, '次数上限不合法');
  state.pickLimit = msg.pickLimit;
  try {
    seat.ps.dirty?.();
    match.flush();
  } catch (e) {
    match.reportError?.('flush', e);
  }
  return OK;
}

/**
 * g.modSpeed { n } — the battle speed: game seconds per real second. 2 is the game's own forced baseline, so this
 * only moves the knob the engine already has (`Match.gameSpeed`, from `opts.combatSpeed`): every client battle's
 * `b.start.speed`, the server-run fields' tick rate, and every deadline/release behind them. It never touches the
 * simulation, so a battle plays out tick for tick the same at any speed. Not billed to the round's budget.
 */
function handleSpeed(match, playerId, msg, state, ERR) {
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isSpeed(msg.n)) return fail(ERR.BAD_TARGET, `倍速要取 ${MIN_SPEED}–${MAX_SPEED} 的整数`);
  state.speed = msg.n;
  try {
    applyGameSpeed(match, msg.n);
  } catch (e) {
    match.reportError?.('modSpeed', e);
    return fail('INTERNAL');
  }
  try {
    seat.ps.dirty?.(); // ship the new modSpeed in the next private view (and retrigger the panel)
    match.flush();
  } catch (e) {
    match.reportError?.('flush', e);
  }
  return OK;
}

// -----------------------------------------------------------------------------------------------------
// the auto buy/sell (自动买卖, g.modAuto): buy a target operator → cash in what it drops → sell it back, on repeat
//
// The player drives this from the panel: while the toggle is on it keeps sending the same `g.modAuto` batch, so
// every call runs a bounded number of cycles and the loop stops by itself when the seat readies, the shop closes
// or the money runs out. Nothing here is billed to the round's pick budget — that budget is for hand-made picks.
//
// It only ever touches what it bought this cycle (the piece, and the coins THAT piece just dropped): coins and
// operators double as a piggy bank, so the loop must not sell or spend anything it did not itself bring in.
//
// SEVERAL TARGETS SHARE ONE LOOP (author, 2026-10-11). `cardIds` is the panel's ticked set, not one card: each cycle
// buys whichever ticked card is on the table. The cards are not interchangeable — their payouts differ in WHEN they
// land, and that is what the class in auto-rules.js encodes (`autoCardAllowedNow`):
//
//   'now'      pays this prep (盟约之币 / 免费刷新 / 白嫖干员 / 1 金价) — always buyable.
//   'deferred' pays NEXT prep (能天使 & 新约能天使 on 获得, 泥岩 & 格雷伊 on 售出: SERVER_ONCE_GOLD). Only worth taking
//              while the loop is PAYING for its rolls, where next prep's gold offsets today's spend; while the rolls
//              are free it is dead weight, so it is skipped. What counts as free is `isRefreshFree` — 奇迹 at or past
//              its 100-layer milestone, plus any free-refresh credit already in hand.
//   'item'     drops an item the loop cannot cash (不融冰 / 定制品 / …) — never in the loop normally, so the panel
//              leaves it unticked; if the player ticks it anyway, the loop buys it like any other target.
//
// Two gates ride on top of the classes, both only in the PAID regime:
//
//   * `economy` — 收费时既然决定自动倒转了，那肯定是只抓经济牌 (author). 焰尾 lands an operator rather than gold, so it
//     is out; the four 下期 cards are in, since the gold they hand over next prep offsets today's rolls.
//   * a FREE round trip — 远见's permanent −1 turns a two-gold operator into one gold, and 售出 gives one back, so
//     buying and selling that card nets nothing: 「就变得可抓可卖了」, the same deal 至简 already gets from its own
//     购买价格为 1. `roundTripNet(ps, id) >= 0` is that test, and it lets a card the class list would have turned away
//     (焰尾 included) back into the loop.
//
// TWO WAYS TO GET A TARGET IN, and the difference is the whole point of `mode`:
//
//   'shop'   (default) — the game's own shop. `buy` / `refresh` / `sell` / `equip` are plain PlayerState verbs, the
//                        ones the player's own buttons call: no mod feature is involved, so this works in a match with
//                        every master switch off. With `refresh` on it rolls for the targets, which is what makes it a
//                        loop rather than a one-shot: 奇迹 at enough layers makes the roll free (bond_refresh_shop_next_free)
//                        and 远见 at layer2 makes every operator cost 1 less (permanently), so the two together are a
//                        self-funding engine. While the rolls are FREE `misses` bounds the hunting (a card the shop is
//                        not offering has to stop the run instead of spinning forever); while they are PAID the seat's
//                        own funds are the bound, and the loop just keeps rolling — 作者 2026-10-11: 「你如果没碰到
//                        经济牌的话，那就接着刷」.
//   'direct' — the mod's 直购 (straight into the hand, no slot, no roll). That is a GAMEPLAY change and belongs to the
//              自选商店 group: it is refused when that group's master switch is off. Kept because it still works in a
//              match whose shop cannot produce a target at all (a banned card, a level the shop will not reach).
// -----------------------------------------------------------------------------------------------------

/** consume-on-equip items that pay gold the moment they are equipped (盟约之币, 骑士储蓄罐) — the loop cashes these in. */
const COIN_IDS = new Set(['chess_item_1_03_e_a', 'chess_item_1_03_e_b', 'chess_item_3_12_e_a', 'chess_item_3_12_e_b']);
/** 随身身份牌 — equip-and-destroy, +3 layers to the carrier's bond (golden +6): gold into layers. */
const ID_CARD_ID = 'chess_item_1_04_e_a';
/** keep this much back before spending on an identity card, so the loop itself never starves. */
const ID_CARD_RESERVE = 3;
/** the bond the identity cards are aimed at; a carrier of this bond is preferred, any other operator is the fallback. */
const ID_CARD_PREFER_BOND = 'visiShip';
/** Consecutive shop rolls without the target before a batch gives up (see "the auto buy/sell"). A constant, not a knob:
 *  it only has to be large enough that a rare-but-present card is found, and small enough that a card the shop cannot
 *  offer stops the run rather than spinning. */
const AUTO_MAX_MISSES = 40;

/** Every uid this seat owns right now: chess on board/hand/temp, plus items lying in the hand/temp. */
function ownedUids(ps) {
  const s = new Set();
  for (const p of ps.allChess()) s.add(p.uid);
  for (const arr of [ps.hand, ps.temp]) for (const p of arr) if (p && p.kind === 'item') s.add(p.uid);
  return s;
}

/** Σ layers over the ACTIVE bonds — what the loop reports as "层数涨了多少". */
function activeLayers(ps) {
  try { return ps.activatedLayers(); } catch { return 0; }
}

/** 奇迹 — the bond whose layer count decides which of the two rolling regimes the loop is in. */
const FREE_REFRESH_BOND = 'miraShip';
/** 奇迹到家这一层，作者就按「刷新免费」那一套倒（100 是奇迹自己的层数里程碑）。 */
const FREE_REFRESH_LAYERS = 100;

/**
 * Is the loop rolling for free right now? Two regimes, and the author named the switch between them (2026-10-11):
 *
 *   * **奇迹满一百** — 按免费刷那一套走；
 *   * **奇迹不满一百** — 按收费刷那一套走。
 *
 * Plus one certain case on top: a free-refresh credit already in hand (`ps.shop.freeRefreshes > 0`, what 普罗旺斯 /
 * 德克萨斯 / 奇迹's own grant hand out) makes THIS roll free no matter what, so it belongs on the free side too.
 *
 * The layer number is `ps.layers[奇迹]` — the same field the engine's own `layersIn` reads, and the number the bond
 * strip shows. (`gd.refreshPrice === 0` is the degenerate third case: a shop whose rolls never cost anything.)
 */
function isRefreshFree(ps) {
  if ((Number(ps?.shop?.freeRefreshes) || 0) > 0) return true;
  const layers = Number(ps?.layers?.[FREE_REFRESH_BOND]);
  if (Number.isFinite(layers) && layers >= FREE_REFRESH_LAYERS) return true;
  return Number(ps?.gd?.refreshPrice) === 0;
}

/**
 * What one buy→sell round trip nets for `id` RIGHT NOW. `>= 0` means the loop can run that card through itself for
 * free, which makes it a target for the PAID regime the same way 至简 is (作者 2026-10-11: 远见 −1 之后原价两块变一块,
 * 卖掉还一块, 「变得可抓可卖了」).
 *
 * The buy side goes through the same price chain a real purchase does — `priceOf` on a slot shaped exactly like the
 * one `directBuy` mints and the one the roll builds — so every on-price discount (远见's permanent −1, 至简's own
 * 购买价格为 1) lands in it. The sell side is `gd.sellPrice`, what `sell()` pays before its onSold dispatch.
 */
function roundTripNet(ps, id) {
  const price = Number(ps.priceOf({ kind: 'chess', id, basePrice: ps.gd.chessPrice(id), frozen: false, sold: false }));
  if (!Number.isFinite(price)) return -1;
  const gain = Number(ps.gd.sellPrice(id));
  return (Number.isFinite(gain) ? Math.max(0, Math.trunc(gain)) : 1) - price;
}

/** The operator the last directBuy actually put in hand: an owned copy of `cardId` whose uid is new. */
function boughtPiece(ps, before, cardId) {
  for (const p of ps.allChess()) if (!before.has(p.uid) && p.id === cardId) return p;
  return null;
}

/** Items that appeared in the hand/temp since `before` — what a 获得时 trait just dropped. */
function freshItems(ps, before) {
  const out = [];
  for (const arr of [ps.hand, ps.temp]) for (const p of arr) if (p && p.kind === 'item' && !before.has(p.uid)) out.push(p);
  return out;
}

/** Where an identity card should go: an operator of the preferred bond, else anything on the board/hand. */
function idCardCarrier(ps) {
  const chess = ps.allChess();
  const bondsOf = (p) => (ps.gd.chess(p.id) || {}).bonds || [];
  return chess.find((p) => bondsOf(p).includes(ID_CARD_PREFER_BOND)) || chess[0] || null;
}

/** The unsold shop slot holding `id`, or -1. The shop is the seat's own roll already on the table. */
function findShopSlot(ps, id) {
  const slots = ps.shop?.slots || [];
  for (let i = 0; i < slots.length; i++) if (slots[i] && !slots[i].sold && slots[i].id === id) return i;
  return -1;
}

/** One batch of the loop. Returns what happened so the panel (and the log) can show it. */
function autoLoop(ps, cfg, { ERR, allowDirect = true }) {
  const gold0 = ps.funds;
  const layers0 = activeLayers(ps);
  const wanted = cfg.cardIds.filter((id) => ps.gd.chess(id));
  const shopMode = cfg.mode !== 'direct';
  const bought = {};
  let done = 0;
  let refreshes = 0;
  let misses = 0;
  let free = isRefreshFree(ps); // which rolling regime this batch is in (echoed so the panel can say so)
  let stop = 'cycles';
  if (wanted.length === 0) return { done, refreshes, gold: 0, layers: 0, stop: 'bad-card', free };
  if (!shopMode && !allowDirect) return { done, refreshes, gold: 0, layers: 0, stop: 'direct-off', free };
  while (done < cfg.cycles) {
    const gate = ps._gate();
    if (gate) { stop = gate.error === ERR.WRONG_PHASE && ps.ready ? 'ready' : (gate.detail || gate.error); break; }
    // what this cycle may buy: the ticked ids, minus the ones the class rules gate out (deferred while rolls are free)
    // and the ones whose purchase would merge into an operator the seat already owns (that would eat the piece instead
    // of returning it). Re-tested every cycle — a roll can flip `isRefreshFree` and an identity card can change `funds`.
    free = isRefreshFree(ps);
    // 收费刷再多一条出路：这一进一出不亏的牌，等于至简，抓了不花钱（远见减价之后两张价的牌都到这一步）
    const allowed = wanted.filter((id) => autoCardAllowedNow(id, free) || (!free && roundTripNet(ps, id) >= 0));
    const pool = allowed.filter((id) => !ps.completesChessMerge(id));
    if (pool.length === 0) { stop = allowed.length ? 'would-merge' : (free ? 'all-deferred' : 'no-economy'); break; }
    let slotIdx = -1;
    let cardId = null;
    if (shopMode) {
      for (const id of pool) { const i = findShopSlot(ps, id); if (i >= 0) { slotIdx = i; cardId = id; break; } }
      if (slotIdx < 0) {
        // not on the table: roll for one, the way the player's own 刷新 button would. The game decides the price (free
        // while a 奇迹 credit is in hand), so nothing here needs to know how the roll is paid for.
        if (!cfg.refresh) { stop = 'no-target'; break; }
        const r = ps.refresh();
        refreshes++;
        if (r && r.error) { stop = r.detail || r.error; break; }
        // 免费刷时一滚不花钱，找不到目标就会一直转，所以这里得收；收费刷时每一滚都记在账上，作者（2026-10-11）说
        // 「没碰到经济牌就接着刷」，钱花光 `refresh()` 自己会拒，所以不另设上限。
        if (free && ++misses >= cfg.maxMisses) { stop = 'no-target'; break; }
        continue; // a roll is not one of the `cycles`; `misses` (免费刷) or the funds (收费刷) is what bounds this
      }
    } else {
      // 直购: no slot to look at, so take the first ticked card the seat can afford
      cardId = pool.find((id) => ps.funds >= ps.gd.chessPrice(id)) || null;
      if (!cardId) { stop = 'no-funds'; break; }
    }
    const price = slotIdx >= 0 ? ps.priceOf(ps.shop.slots[slotIdx]) : ps.gd.chessPrice(cardId);
    if (ps.funds < price) { stop = 'no-funds'; break; }

    const before = ownedUids(ps);
    const err = slotIdx >= 0 ? (() => { const r = ps.buy(slotIdx); return r && r.error ? r : null; })() : directBuy(ps, cardId, { ERR });
    if (err) { stop = err.detail || err.error; break; }
    const piece = boughtPiece(ps, before, cardId);
    if (!piece) { stop = 'no-piece'; break; }
    misses = 0;
    bought[cardId] = (bought[cardId] || 0) + 1;
    if (cfg.equipCoins) for (const it of freshItems(ps, before)) if (COIN_IDS.has(it.id)) ps.equip(it.uid, piece.uid);
    const sold = ps.sell(piece.uid);
    if (sold && sold.error) { stop = sold.detail || sold.error; break; }
    done++;
    if (cfg.idCard) spendOnIdCard(ps, ERR);
  }
  return { done, refreshes, gold: ps.funds - gold0, layers: activeLayers(ps) - layers0, stop, bought, free };
}

/** Buy one 随身身份牌 and put it on the operator whose bond we are stacking (no-op when there is no room/money). */
function spendOnIdCard(ps, ERR) {
  if (ps.funds < ID_CARD_RESERVE) return;
  const carrier = idCardCarrier(ps);
  if (!carrier) return;
  const before = ownedUids(ps);
  if (directBuy(ps, ID_CARD_ID, { ERR })) return;
  const card = freshItems(ps, before).find((it) => it.id === ID_CARD_ID);
  if (card) ps.equip(card.uid, carrier.uid);
}

/**
 * g.modAuto { on, cardIds, cycles, equipCoins, idCard, refresh, mode } — one batch of the auto buy/sell. `cardIds` is
 * the panel's ticked set (see the section header for what the classes do). `on: false` is the stop signal (the panel
 * sends it when the toggle goes off); it just records the request and does nothing else. The result of every batch is
 * echoed back through `privateView.modAuto` and, as one summary line, into the log.
 * Not billed to the round's budget (the panel re-sends this many times a second).
 */
function handleAuto(match, playerId, msg, state, ERR, log) {
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isBool(msg.on) || !isAutoTargets(msg.cardIds) || !isCycles(msg.cycles) || !isBool(msg.equipCoins) || !isBool(msg.idCard)
    || !isBool(msg.refresh) || !isAutoMode(msg.mode)) {
    return fail(ERR.BAD_TARGET, '自动买卖参数不合法');
  }
  const ps = seat.ps;
  // Keep only what the catalogue knows AND this match's data has: the class lookup is the server's own, so a stale or
  // hand-rolled panel cannot smuggle in a card by claiming a class. Duplicates collapse, order is the panel's.
  const cardIds = [...new Set(msg.cardIds)].filter((id) => autoClassOf(id) && ps.gd.chess(id));
  if (msg.on && cardIds.length === 0) return fail(ERR.BAD_TARGET, '没有可用的倒转目标');
  const call = {
    on: msg.on, cardIds, cycles: msg.cycles, equipCoins: msg.equipCoins, idCard: msg.idCard,
    refresh: msg.refresh, mode: msg.mode, maxMisses: AUTO_MAX_MISSES,
  };
  let done = 0;
  let gold = 0;
  let layers = 0;
  let refreshes = 0;
  let bought = {};
  let free = false;
  let stop = 'off';
  let on = false;
  if (call.on) {
    const saved = state.record;
    state.record = false; // one summary line, not one per buy/sell/equip
    try {
      const r = autoLoop(ps, call, { ERR, allowDirect: state.enable.shop });
      ({ done, gold, layers, refreshes, stop, bought, free } = r);
    } catch (e) {
      state.record = saved;
      match.reportError?.('modAuto', e);
      return fail('INTERNAL');
    }
    state.record = saved;
    // 'cycles' just means the batch ran out: the panel should send another. Anything else is a real stop, and
    // flipping `on` off is how the panel finds out (it is driving, so it cannot see the server's own verdict).
    on = stop === 'cycles';
  }
  state.auto = { ...call, on, done, gold, layers, refreshes, stop, bought, free };
  if (call.on) emitEvent(state, log, autoEvent(ps, state.auto));
  try {
    ps.dirty?.(); // ship the fresh modAuto in the next private view (and retrigger the panel)
    match.flush();
  } catch (e) {
    match.reportError?.('flush', e);
  }
  return OK;
}

/**
 * Point the match at `n` game seconds per real second, mid-battle included.
 *
 * Everything the game paces off `match.gameSpeed` follows by itself: the server-run fields (`FieldRunner` /
 * `HeadlessPacer` read it every pump), the fields launched from now on (`b.start.speed`), and every deadline
 * armed from here on. Two things need a nudge:
 *
 *   * a field already running — its origin `startAt` is rescaled so its game clock stays where it is
 *     (`_fieldElapsed` is `((clockNow − startAt) / 1000) × gameSpeed`, so rescaling at the moment of the change
 *     leaves the elapsed game time untouched and everything derived from it — boss pool math, timelines,
 *     releases — continuous instead of jumping);
 *   * a client field's result deadline, which was armed at the old speed: at a lower speed it would fire first
 *     and the server would take a battle over that the player is still watching.
 */
function applyGameSpeed(match, n) {
  const old = Number(match.gameSpeed);
  if (!isSpeed(n) || n === old) return;
  const now = typeof match._clockNow === 'function' ? match._clockNow() : match.sched.now();
  const live = [];
  for (const f of Array.isArray(match.fields) ? match.fields : []) {
    if (!f || f.done || !Number.isFinite(f.startAt)) continue;
    let gt = 0;
    try { gt = match._fieldElapsed(f); } catch { gt = 0; }
    live.push({ f, gt });
  }
  match.gameSpeed = n;
  for (const { f, gt } of live) f.startAt = now - (gt / n) * 1000;
  for (const { f } of live) {
    if (f.mode === 'client' && f.kind !== 'boss' && f.kind !== 'hidden') {
      if (match.paused) {
        if (f.deadlineTimer) { match.cancel(f.deadlineTimer); f.deadlineTimer = null; }
        f.rearmDeadline = true; // _resume re-arms it (matching Match.setPause's own bookkeeping)
      } else {
        try { match._armDeadline(f); } catch (e) { match.reportError?.('armDeadline', e); }
      }
    } else if (f.mode === 'server' && f.result != null) {
      // a finished server-run field waiting out its release: move the release to the new clock too
      try { match._armRelease(f); } catch (e) { match.reportError?.('armRelease', e); }
    }
  }
}

/**
 * The three fixed presentation steps between phases follow the battle speed too.
 *
 * The game parks you in plain real-time waits: 1.5 s after a battle (DELAYS.COMBAT_END, combat.js), 3 s of 结算
 * (DELAYS.SETTLE, settle.js), 2 s of 回合开始 (DELAYS.ROUND_START, phases.js), plus the 3 s BATTLE_CHECK step, which
 * shares the 3000 value. They read `Match.timerScale`, never `gameSpeed`, so at 8× they stay the same 6.5 real seconds
 * per round — that is the "顿一下" between the battle ending and the next prep (nothing is being loaded; it is the
 * game's own pacing).
 *
 * So `scaled` is wrapped and exactly those values are divided by `speed / GAME_SPEED`. Only ever shortened: at the
 * game's own 2× baseline (and at 1×, which is slower than the game ever runs) nothing changes. Only those values:
 * every other user of `scaled` is waited on for CORRECTNESS, not for pacing — BOSS_RESULT_GRACE_MS is the window a
 * client gets to report the boss result before the server synthesizes one, and shrinking that could throw away a real
 * result.
 *
 * Solo / lone-human matches only. There (`soloUntimed`) no step is timed at all — nothing a human has to read or click
 * runs on a clock — so shortening these cannot cost anybody a decision. A co-op room keeps the game's own pacing.
 */
function installPresentationScale({ Match, DELAYS, state, log }) {
  if (typeof Match?.prototype?.scaled !== 'function') return ['Match.prototype.scaled'];
  if (!DELAYS || typeof DELAYS !== 'object') return ['Match DELAYS'];
  const steps = new Set([DELAYS.COMBAT_END, DELAYS.SETTLE, DELAYS.ROUND_START].map((v) => Math.round(v)));
  const origScaled = Match.prototype.scaled;
  Match.prototype.scaled = function scaled(ms) {
    const base = origScaled.call(this, ms);
    const n = Number(state.speed);
    if (!(n > GAME_SPEED) || !steps.has(Math.round(ms))) return base;
    let solo = false;
    try { solo = !!this.soloUntimed; } catch { solo = false; }
    if (!solo) return base;
    return Math.max(MIN_STEP_MS, Math.round((base * GAME_SPEED) / n));
  };
  log.info(`hooked Match.prototype.scaled (过场等待跟倍速：${[...steps].join(' / ')} ms，仅单人局)`);
  return [];
}

// -----------------------------------------------------------------------------------------------------
// the sandbox: extra 策略 (strategies) on top of the drafted one, and the deploy unlock
//
//   * 策略. The game fixes a seat's strategy once, in the draft (`Match.pickBand` → `_applyBand`), and every effect
//     dispatch reads that single `ps.bandId` (effectsMeta.js:218). Extra ids ride on `ps.modBands`; the dispatcher is
//     wrapped so each of them gets its own `band:<id>` handler called, with its OWN source (the source is only read for
//     toast / offer titles, but a shared one would name the wrong strategy). The starting LP is one number per
//     strategy, so a stack takes the MAX of the picks (`_applyBand` is the only place that sets it).
//
//   * 地块. Legality is one chain: the stage's tile legend (`height` × `buildable`) → buildDeployMap → canPlace →
//     PlayerState._legal, which is also what the single "put it back" pass (_evictIllegal) consults. So the unlock is
//     a MAP change, not a rule change: every tile whose legend says it cannot be built on is added, high ground as
//     ranged-only (the one rule worth keeping), and tiles a device took away (阻隔工事, an inactive platform) stay as
//     the game left them. `height` is never touched — the renderer reads it. The browser reads its own copy of
//     stages.json, so overlay.js widens its side the same way. Turning it off re-runs `recompute()`, which pulls back
//     whatever now stands somewhere illegal.
// -----------------------------------------------------------------------------------------------------

/** Wrap the dispatcher, `_applyBand`, the deploy map / class and the battle pass. Returns what it could not find. */
function installSandbox({ Match, PlayerState, EffectDispatcher, board, Battle, bands, state, log }) {
  const missing = [];

  // -- extra strategies: every dispatch also runs each extra strategy's own band handler --
  if (typeof EffectDispatcher?.prototype?.dispatch !== 'function') {
    missing.push('EffectDispatcher.prototype.dispatch');
  } else {
    const origDispatch = EffectDispatcher.prototype.dispatch;
    EffectDispatcher.prototype.dispatch = function dispatch(ps, hook, ev = {}, opts = {}) {
      const extra = ps && Array.isArray(ps.modBands) ? ps.modBands : null;
      // the income assigners run first: they overwrite `ev.income` outright, so anything added before them is lost
      if (extra?.length && hook === 'onIncome') {
        for (const id of extra) if (id !== ps.bandId && INCOME_ASSIGN_BANDS.has(id)) callBand(this, ps, id, hook, ev);
      }
      const res = origDispatch.call(this, ps, hook, ev, opts);
      if (extra?.length) {
        for (const id of extra) {
          if (id === ps.bandId) continue;
          if (hook === 'onIncome' && INCOME_ASSIGN_BANDS.has(id)) continue; // already ran, before the primary
          callBand(this, ps, id, hook, ev);
        }
      }
      // 鸭爵 as an extra: its effect is a GLOBAL handler, not a `band:` one, so the loop above never reaches it
      if (ps && hook === 'onBattleStart') duckAsExtra(this, ps, ev);
      return res;
    };
    log.info('hooked EffectDispatcher.dispatch (sandbox strategies)');
  }

  // -- starting LP: one number per strategy, so a stack keeps the biggest --
  if (typeof Match?.prototype?._applyBand !== 'function') {
    missing.push('Match.prototype._applyBand');
  } else {
    const origApply = Match.prototype._applyBand;
    Match.prototype._applyBand = function _applyBand(ps, bandId, opts) {
      const res = origApply.call(this, ps, bandId, opts);
      try { applyMaxLp(this, ps); } catch (e) { log.warn('sandbox LP failed', e?.message || e); }
      return res;
    };
    log.info('hooked Match.prototype._applyBand (sandbox LP)');
  }

  // -- the deploy unlock: widen the map the game hands out --
  if (typeof Match?.prototype?.deployMapFor !== 'function' || !board) {
    missing.push('Match.prototype.deployMapFor');
  } else {
    const origMap = Match.prototype.deployMapFor;
    Match.prototype.deployMapFor = function deployMapFor(ps, field) {
      const map = origMap.call(this, ps, field);
      try {
        if (state.sandbox.place) widenDeployMap(this.stage, field ?? this.deployFieldOf(ps), map, board);
      } catch (e) {
        log.warn('deploy unlock failed', e?.message || e);
      }
      return map;
    };
    log.info('hooked Match.prototype.deployMapFor (deploy unlock)');
  }

  // -- the deploy unlock also lifts the placement CLASS, not just the tiles --
  // A melee chess may stand on a 高台 when its trait reads 「可以放置于远程位」 (shared/highGround.js: 歌蕾蒂娅/崖心/见行者).
  // The class is the game's own knob for that: `placeClass` → positionClass 'all' passes canPlace on every deployable
  // tile, 高台 included. Lifting it here (instead of faking a trait, which the detail card shows) gives every piece the
  // same shoes, and it matches what overlay.js does to its own copy of the stage.
  if (typeof PlayerState?.prototype?._placementOf !== 'function') {
    missing.push('PlayerState.prototype._placementOf');
  } else {
    const origPlacementOf = PlayerState.prototype._placementOf;
    PlayerState.prototype._placementOf = function _placementOf(piece) {
      const pos = origPlacementOf.call(this, piece);
      return state.sandbox.place && pos !== 'all' ? 'all' : pos;
    };
    log.info('hooked PlayerState._placementOf (melee on 高台)');
  }

  // -- the deploy cap: a floor on top of the game's own number (the getter is inherited from PlayerBasics) --
  let capGetter = null;
  for (let o = PlayerState?.prototype; o && !capGetter; o = Object.getPrototypeOf(o)) {
    const d = Object.getOwnPropertyDescriptor(o, 'deployCap');
    if (d && typeof d.get === 'function') capGetter = d.get;
  }
  if (!capGetter) {
    missing.push('PlayerState deployCap getter');
  } else {
    Object.defineProperty(PlayerState.prototype, 'deployCap', {
      configurable: true,
      enumerable: false,
      get() {
        const n = capGetter.call(this);
        const cap = state.sandbox.cap;
        return cap == null || !Number.isFinite(n) ? n : Math.max(n, cap);
      },
    });
    log.info('hooked PlayerState deployCap');
  }

  // -- 坎诺特's 利滚利 (leftover funds survive the prep) is a MATCH rule, not an effect, and reads the single `bandId` --
  if (typeof PlayerState?.prototype?.endPrep !== 'function') {
    missing.push('PlayerState.prototype.endPrep');
  } else {
    const origEndPrep = PlayerState.prototype.endPrep;
    PlayerState.prototype.endPrep = function endPrep(...args) {
      const keeps = keepsLeftoverFunds(this);
      const before = this.funds;
      const res = origEndPrep.apply(this, args);
      if (keeps && this.funds === 0 && before > 0) {
        this.funds = before; // the prep end wiped them: an extra 坎诺特 keeps them
        this.dirty?.();
      }
      return res;
    };
    log.info('hooked PlayerState.endPrep (sandbox 利滚利)');
  }

  // -- the extras ride along on the battle spec, so the browser's own copy of the sim installs them too --
  if (typeof PlayerState?.prototype?.battleInput !== 'function') {
    missing.push('PlayerState.prototype.battleInput');
  } else {
    const origBattleInput = PlayerState.prototype.battleInput;
    PlayerState.prototype.battleInput = function battleInput(...args) {
      const input = origBattleInput.apply(this, args);
      try {
        if (input && Array.isArray(this.modBands) && this.modBands.length) input.modBands = [...this.modBands];
      } catch { /* ignore */ }
      return input;
    };
    log.info('hooked PlayerState.battleInput (extras in the battle spec)');
  }

  // -- the BATTLE side of the extra strategies --
  // `bands/battle.js install()` walks `battle.players` and installs the IN_BATTLE buffs of each player's single
  // `bandId`; the strategies whose whole effect is combat (歌利亚, 阿米娅, 卡莱莎, Touch …) live nowhere else. The extras
  // ride on the battle spec (`battleInput` → the player entry), so patching the one seam every Battle construction goes
  // through covers both processes. `install()` itself is not re-enterable per band, so the extras go in one at a time
  // with the other players masked out: only the extra's own buffs land, and nobody's are installed twice.
  if (typeof Battle?.prototype?._safe !== 'function' || typeof bands?.install !== 'function') {
    missing.push('Battle.prototype._safe');
  } else {
    const origSafe = Battle.prototype._safe;
    Battle.prototype._safe = function _safe(fn, label, owner) {
      const res = origSafe.call(this, fn, label, owner);
      if (label === 'installContent') {
        try { installExtraBands(this, bands); } catch (e) { log.warn('battle-side extra strategies failed', e?.message || e); }
      }
      return res;
    };
    log.info('hooked Battle.prototype._safe (battle-side extra strategies)');
  }

  return missing;
}

/**
 * Install the battle part of a seat's extra strategies into a whole Battle. `bands.install` reads each player's single
 * `bandId`, so each extra runs as a one-band pass: every other player is masked to null for the call and put back
 * afterwards, which keeps the primary strategies from being installed a second time. Returns how many were installed.
 */
function installExtraBands(battle, bands) {
  const players = Array.isArray(battle?.players) ? battle.players : null;
  if (!players?.length || typeof bands?.install !== 'function') return 0;
  const jobs = [];
  for (const p of players) {
    const ids = p?.input?.modBands;
    if (!Array.isArray(ids) || !ids.length) continue;
    const own = ids.filter((id) => id && id !== p.bandId);
    if (own.length) jobs.push([p, own]);
  }
  if (!jobs.length) return 0;
  const saved = players.map((p) => p.bandId);
  let n = 0;
  try {
    for (const [p, ids] of jobs) {
      for (const id of ids) {
        for (const q of players) q.bandId = null;
        p.bandId = id;
        bands.install(battle);
        n++;
      }
    }
  } finally {
    players.forEach((p, i) => { p.bandId = saved[i]; });
  }
  return n;
}

/**
 * Run one extra strategy's band handler for `hook`, with the source naming THAT strategy (offer/toast titles and the
 * layer `reason` read it). Strategies with no prep-side handler (the combat-only ones) simply have no handler here —
 * their half is installed into the Battle instead (see installExtraBands).
 */
function callBand(dispatcher, ps, id, hook, ev) {
  const key = `band:${id}`;
  const h = dispatcher.registry?.get?.(key);
  if (!h) return;
  const m = dispatcher.m;
  const band = m?.gd?.band ? m.gd.band(id) : null;
  dispatcher._call(ps, key, h, hook, { kind: 'band', key, bandId: id, band }, ev);
}

/**
 * Run the 鸭爵 global for a field that holds the duck only as an EXTRA strategy.
 *
 * The gate reads each seat's live `ps.bandId` (ctx.bandId / ctx.teammates), so the fix is to mask the bandId of every
 * seat whose `modBands` names the duck for the duration of the call, then put them back. The handler itself is fetched
 * from the registry by key, exactly like callBand. Two guards:
 *   * a PRIMARY duck — the game's own pass already ran the handler for every seat of the field (its `held` check is
 *     satisfied for all of them), so running it again here would swap the enemies twice;
 *   * the original dispatch already ran the global for THIS seat (returning early, since it saw no duck): this is the
 *     missing half, run once per seat, matching how the primary case edits each seat's own half of a shared field.
 * Only the server needs this: the spawn list is built server-side (combat.js:45-51, bossRounds.js:79-88) and sanitised
 * after dispatch returns, and both processes get that same list through the battle spec.
 */
function duckAsExtra(dispatcher, ps, ev) {
  const m = dispatcher.m;
  const players = typeof m?.alivePlayers === 'function' ? m.alivePlayers() : null;
  if (!players?.length) return;
  if (players.some((p) => p.bandId === DUCK_BAND)) return; // primary pass already covered the whole field
  const holders = players.filter((p) => Array.isArray(p.modBands) && p.modBands.includes(DUCK_BAND));
  if (!holders.length) return;
  const h = dispatcher.registry?.get?.(DUCK_GLOBAL);
  if (!h || typeof h.onBattleStart !== 'function') return;
  const saved = holders.map((p) => p.bandId);
  try {
    for (const p of holders) p.bandId = DUCK_BAND;
    dispatcher._call(ps, DUCK_GLOBAL, h, 'onBattleStart', { kind: 'global', key: DUCK_GLOBAL }, ev);
  } finally {
    holders.forEach((p, i) => { p.bandId = saved[i]; });
  }
}

/** Whether any of the seat's strategy picks is one whose leftover funds survive the prep (坎诺特 利滚利). */
function keepsLeftoverFunds(ps) {
  const kept = ps?.gd?.leftoverKeptBands;
  if (!Array.isArray(kept) || !kept.length) return false;
  const ids = [ps.bandId, ...(Array.isArray(ps.modBands) ? ps.modBands : [])];
  return ids.some((id) => id && kept.includes(id));
}

/** Deck the seat's LP to the biggest 初始目标生命值 among its strategy picks. */
function applyMaxLp(match, ps) {
  const ids = [ps?.bandId, ...(Array.isArray(ps?.modBands) ? ps.modBands : [])].filter(Boolean);
  if (ids.length < 2 || typeof match.gd?.startLp !== 'function') return;
  let best = 0;
  for (const id of ids) {
    const lp = Number(match.gd.startLp(id));
    if (Number.isFinite(lp) && lp > best) best = lp;
  }
  if (!(best > 0) || ps.lp === best) return;
  ps.lp = best;
  match.markPrivate?.(ps);
  match.markPublic?.();
}

/**
 * Add the tiles the stage's own legend refuses to `map`, so the unlock is exactly "every tile you could not build on
 * is now buildable": high ground joins as ranged-only, and anything a device took away (a crate, an inactive
 * platform) is left alone — the game's device pass already ran, and the deck stays a part of the board.
 */
function widenDeployMap(stage, field, map, board) {
  const rows = Array.isArray(stage?.rows) ? stage.rows : null;
  const legend = stage && typeof stage.tiles === 'object' && stage.tiles ? stage.tiles : null;
  if (!rows || !legend || typeof board?.fieldTile !== 'function') return;
  const F = board.FIELD;
  for (let r = F.r0; r <= F.r1; r++) {
    for (let c = F.c0; c <= F.c1; c++) {
      const k = board.tileKey(r, c);
      if (map.has(k)) continue;
      const [sr, sc] = board.fieldTile(field, r, c);
      const line = typeof rows[sr] === 'string' ? rows[sr] : null;
      const glyph = line ? line[sc] : null;
      const tile = glyph != null && Object.hasOwn(legend, glyph) ? legend[glyph] : null;
      // the legend says this one CAN be built on ⇒ the map lost it to a device, not to its terrain: leave it out
      if (tile && typeof tile.buildable === 'string' && tile.buildable !== 'NONE') continue;
      map.set(k, tile && tile.height === 'HIGH' ? 'ranged' : 'melee');
    }
  }
}

/** What the panel reads: this seat's extra strategies, the strategies the match allows, and the two deploy knobs. */
function sandboxView(ps, state) {
  const gd = ps?.m?.gd;
  let pool = [];
  try {
    if (typeof gd?.bandIds === 'function') pool = gd.bandIds().filter((id) => gd.bandAllowed(id));
  } catch { pool = []; }
  return {
    bands: Array.isArray(ps?.modBands) ? ps.modBands : [],
    pool,
    place: !!state.sandbox.place,
    cap: state.sandbox.cap,
  };
}

/** g.modBands { ids } — replace this seat's extra strategies. Not billed to the round's budget. */
function handleBands(match, playerId, msg, state, ERR) {
  if (!state.enable.sandboxBands) return fail(ERR.BAD_TARGET, '沙盒·策略叠加已关闭（总开关）');
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isIdList(msg.ids)) return fail(ERR.BAD_TARGET, '策略列表不合法');
  const ps = seat.ps;
  const gd = match.gd;
  const ids = [];
  for (const id of msg.ids) {
    if (!gd.bandAllowed(id)) return fail(ERR.BAD_TARGET, `本局没有这个策略（${id}）`);
    if (id === ps.bandId) continue; // the drafted one is already running
    if (ids.includes(id)) continue; // twice would double every counter and every grant
    ids.push(id);
  }
  ps.modBands = ids;
  applyMaxLp(match, ps);
  try { ps.dirty?.(); match.flush(); } catch (e) { match.reportError?.('modBands', e); }
  return OK;
}

/** g.modPlace { on, cap } — the deploy unlock and the deploy cap (cap null = the game's own number). */
function handlePlace(match, playerId, msg, state, ERR) {
  if (!state.enable.sandboxPlace) return fail(ERR.BAD_TARGET, '沙盒·地块解锁已关闭（总开关）');
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isBool(msg.on) || !isDeployCap(msg.cap)) return fail(ERR.BAD_TARGET, '地块解锁参数不合法');
  state.sandbox.place = msg.on;
  state.sandbox.cap = msg.cap;
  try {
    for (const ps of match.players?.values?.() || []) {
      ps.invalidateDeployMap?.();
      ps.recompute?.(); // turning it off pulls back whatever now stands somewhere illegal
    }
    match.flush();
  } catch (e) {
    match.reportError?.('modPlace', e);
  }
  return OK;
}

// -----------------------------------------------------------------------------------------------------
// the unit rules (技能 / 技力 / 属性)
//
// Three seams, because the game resolves an operator's body in three places:
//
//   1. DataSource.getChess(id, loadout) — the stats the def carries. The battle spec has none, so EACH side resolves them
//      from data/chess.json through this one method; a wrapper here reaches every consumer on this side
//      (battle/players.js `_makeAlly`, content/index.js `swapDef`). The panel wraps the browser's own copy the same way.
//   2. SkillRuntime.reset() — 技力. A kit's SkillSpec may name its own `spCost` / `initSp` and those WIN over the def's
//      (skills.js), so the def-level rewrite would be silently ignored for those operators; the runtime is the only place
//      that always decides.
//   3. PlayerState.battleInput() — 换技能. The chosen skill rides on the unit's `skillIndex`, which is what the sim
//      resolves the def with; that field is this seat's own, so the swap is exactly as wide as the seat (and it reaches
//      the browser, which simulates the player's field: the spec carries `skillIndex`).
//
// Scope 这一名 / 我的全部 are the PANEL's own field — the browser simulates it, so this side is told to sit out and only
// 全场 turns the def/runtime wrappers on here (they are process-wide: every seat's field, the AI teammates included).
// -----------------------------------------------------------------------------------------------------

/** The process-wide patcher behind the getChess wrapper. One config at a time (the panel is a single seat's). */
const unitPatcher = createUnitPatcher();

/** g.modUnit { cfg } — replace the unit-rules config. Not billed to the round's budget. */
function handleUnit(match, playerId, msg, state, ERR) {
  if (!state.enable.sandboxUnit) return fail(ERR.BAD_TARGET, '沙盒·单位已关闭（总开关）');
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  const cfg = normalizeUnitCfg(msg.cfg);
  if (msg.cfg !== null && !cfg) return fail(ERR.BAD_TARGET, '单位设置不合法');
  // 全场 is the only scope this side applies: the others are the browser's own field (see the header above)
  const appliedHere = !!(cfg && cfg.on && cfg.scope === 'all');
  state.unit = cfg ? { ...cfg, owner: playerId, appliedHere } : null;
  unitPatcher.set(appliedHere ? cfg : null);
  try {
    // the stats of a field already under way do not change (they were copied into every unit at install), but the panel
    // marks itself from this echo — so push it to every seat at once
    for (const ps of match.players?.values?.() || []) ps.dirty?.();
    match.flush();
  } catch (e) {
    match.reportError?.('modUnit', e);
  }
  return OK;
}

/**
 * Install the two server-side seams of the unit rules. `DataSource.getChess` is wrapped on the PROTOTYPE — every source
 * the process builds (Match's own `new DataSource(data)`, the default one, a per-battle loadout view's delegate) goes
 * through it, so there is nothing to re-install per match.
 */
function installUnitRules({ PlayerState, DataSource, SkillRuntime, state, log }) {
  const missing = [];

  if (typeof DataSource?.prototype?.getChess !== 'function') {
    missing.push('DataSource.prototype.getChess');
  } else {
    const origGetChess = DataSource.prototype.getChess;
    DataSource.prototype.getChess = function getChess(id, loadout = null) {
      // the 自选位 kit rides the same seam: unitPatcher owns the stats, diyPatcher the bonds / 特质 of a 自选 def
      return diyPatcher.def(unitPatcher.def(id, origGetChess.call(this, id, loadout)));
    };
    log.info('hooked DataSource.getChess (unit stats)');
  }

  // 技力: the runtime is where spCost / initSp are finally decided (a kit's SkillSpec beats the def).
  if (typeof SkillRuntime?.prototype?.reset !== 'function') {
    missing.push('SkillRuntime.prototype.reset');
  } else {
    const origReset = SkillRuntime.prototype.reset;
    SkillRuntime.prototype.reset = function reset(carry) {
      const cfg = unitPatcher.cfg;
      const u = this.unit;
      const id = u ? (u.defId ?? u.def?.id) : null;
      // operators only: a token's def id is a token id, and the panel never means those
      if (cfg && u && u.kind === 'op' && id != null && unitCovers(cfg, id)) {
        if (cfg.spCost != null) this.baseSpCost = cfg.spCost;
        if (cfg.initSp != null) this.initSp = cfg.initSp;
      }
      return origReset.call(this, carry);
    };
    log.info('hooked SkillRuntime.reset (unit 技力)');
  }

  // 换技能: the seat's own loadout result, rewritten on the way into the battle spec.
  if (typeof PlayerState?.prototype?.battleInput !== 'function') {
    missing.push('PlayerState.prototype.battleInput');
  } else {
    const origBattleInput = PlayerState.prototype.battleInput;
    PlayerState.prototype.battleInput = function battleInput(...args) {
      const input = origBattleInput.apply(this, args);
      try {
        const cfg = state.unit;
        if (cfg?.on && cfg.scope === 'one' && cfg.skill != null && cfg.owner === this.playerId && Array.isArray(input?.units)) {
          const want = baseChessId(cfg.id);
          for (const u of input.units) {
            // a 自选 slot and a 补位 stand-in carry their own skill (round.js says so) — leave those alone
            if (!u || u.kind !== 'chess' || u.diy || u.standIn) continue;
            if (baseChessId(u.chessId) !== want) continue;
            u.skillIndex = cfg.skill;
          }
        }
      } catch (e) {
        log.warn('unit skill swap failed', e?.message || e);
      }
      return input;
    };
    log.info('hooked PlayerState.battleInput (unit 换技能)');
  }

  return missing;
}

// -----------------------------------------------------------------------------------------------------
// the 自选位 rules (盟约 / 特质, and later their numbers)
//
// The author's ask (2026-10-10): a 自选编队 piece should stop being a bare 协防干员 body. He wants to decide, PER SLOT,
// which 盟约 it carries and which 特质 it bears, so whoever he slots there is a core member of his build. The kit stays
// with the SLOT, not the operator (「作用于那个位置」).
//
// Two seams, one per side of the game:
//
//   1. the PREP side — `ps.gd`. `PlayerDiy.setDiy` composes one record per slotted slot and installs
//      `ps.gd = diyGameData(m.gd, records)`; every prep rule reads a record through that view (bondsMeta.pieceBonds,
//      effectsMeta's 特质 ctx, initDiyStock's ban check). So the patch rebuilds the record map and re-installs the view.
//      `setDiy` runs from the PlayerState CONSTRUCTOR (PlayerState.js:183), BEFORE hand / board / layers exist, so that
//      rebuild must NOT compute bonds — the constructor's own `computeBonds` (line 242) picks the new `ps.gd` up by
//      itself. A mid-match change goes through `recompute()` instead.
//   2. the BATTLE side — `DataSource.prototype.getChess`, wrapped once in installUnitRules above (one wrapper, two
//      patchers). The composed 自选 record reaches the sim as the unit's `def` (`simdata.getDiy` → `normalizeChess`), and
//      `def.bonds` / `def.raw.garrisonIds` is what the battle content reads.
//
// The config is PROCESS-WIDE (one map keyed by slot base id), never per seat: the def patcher cannot see a player, and
// only a human seat fields 自选 pieces at all (bots field none, player/diy.js setDiy returns early for them). Every seat
// gets the same echo back through `view.modDiy`, so the panel can show what the server holds.
// -----------------------------------------------------------------------------------------------------

/** The process-wide 自选位 patcher; `diyPatcher.def` is what the getChess wrapper above calls. */
const diyPatcher = createSlotPatcher();
/** The game helpers the rebuild needs, captured once by installSlotRules (the rebuild runs from module-level handlers). */
const slotDeps = { diyGameData: null, diySlot: null, diyRecord: null, checkDiyPick: null, support: null };
/**
 * The kit's number edits as a data object (see slot-rules.patchGameData). Memoised per BASE object and invalidated by
 * `slotGen`, so a mid-match edit rebuilds it once instead of once per lookup (the prep side asks per piece, the battle
 * side per install).
 */
let slotGen = 0;
let slotMemo = { gen: -1, byBase: new WeakMap() };
function patchedDataOf(base) {
  if (!base || typeof base !== 'object') return base;
  if (!hasNumberEdits(diyPatcher.entries())) return base;
  if (slotMemo.gen !== slotGen) slotMemo = { gen: slotGen, byBase: new WeakMap() };
  const hit = slotMemo.byBase.get(base);
  if (hit) return hit;
  const out = patchGameData(diyPatcher.entries(), base);
  slotMemo.byBase.set(base, out);
  return out;
}

/**
 * The mod's own 自选位 (see slot-rules.js "更多自选位"): `[{ k, tier, pick }]`, process-wide like the kit — the game's
 * four slots are fixed in its data, these are the extra ones the panel defines at any tier 1..6.
 */
let diyExtras = [];
/**
 * The 携带技能 the panel set, `{ [slotBaseId]: 0..9 }`. A slot named here has its composed record rebuilt around that
 * skill (the game's own 自选编队 pick keeps whatever it chose, which the panel can thus override).
 */
let diySkills = Object.create(null);
/** The 模组 the panel set, `{ [slotBaseId]: uniEquipId | null }` (null = 不带模组; absent = keep the composed one). */
let diyMods = Object.create(null);
/** The chess records the extra slots add, per economy object (the price differs per tier); rebuilt when the slots change. */
let extraGen = -1;
let extraCache = new WeakMap();
let extraNoEco;
function extraChessTable(holder) {
  if (extraGen !== slotGen) { extraGen = slotGen; extraCache = new WeakMap(); extraNoEco = undefined; }
  if (!diyExtras.length) return null;
  const eco = holder && typeof holder.economy === 'object' ? holder.economy : null;
  if (!eco) {
    if (extraNoEco === undefined) extraNoEco = extraDiyData(diyExtras, null)?.chess ?? null;
    return extraNoEco;
  }
  let hit = extraCache.get(eco);
  if (hit === undefined) {
    hit = extraDiyData(diyExtras, eco)?.chess ?? null;
    extraCache.set(eco, hit);
  }
  return hit;
}

/** The config the panel reads back: slot base id → `{ bonds, addBonds, garrisons, bondBb, garrisonBb }` (ids only). */
function diyCfgView() {
  const out = {};
  for (const s of diyPatcher.slots) {
    const c = diyPatcher.cfgOf(s);
    if (!c) continue;
    const garrisonBb = {};
    for (const g of c.garrisons) if (g.bb) garrisonBb[g.id] = g.bb;
    out[s] = {
      bonds: c.bonds,
      addBonds: c.addBonds,
      garrisons: c.garrisons.map((g) => g.id),
      bondBb: c.bondBb || {},
      garrisonBb,
    };
  }
  return out;
}

/** The mod's own slots as the panel reads them back: `[{ k, tier, pick }]`. */
function diyExtrasView() {
  return diyExtras.map((e) => ({ k: e.k, tier: e.tier, pick: e.pick }));
}

/**
 * Rebuild this seat's composed 自选 records with the slot kit applied, and re-install the data view. True when anything
 * changed. `recompute` (mid-match only) re-derives the bonds afterwards; the constructor path must leave it off.
 */
function applyModDiy(ps, { recompute = false } = {}) {
  const gd = ps?.m?.gd;
  // ALWAYS from the game's own composed records (`__diyBase`, captured by the setDiy wrapper), never from a map this
  // function already patched — otherwise a second edit would layer on top of the first instead of replacing it.
  const src = ps?.__diyBase instanceof Map ? ps.__diyBase : ps?._diyRecords;
  if (!gd || !slotDeps.diyGameData || !(src instanceof Map)) return false;
  // ⭐ The mod's OWN slots are the PLAYER's, never the match's. `handleModDiy` rebuilds every seat in the room (the
  // kit is process-wide), and the game hands EVERY seat an empty `_diyRecords` Map at construction (PlayerState.js:178,
  // `new Map()` before the `isBot` guard on line 183), so without this line the loop below composes the author's
  // custom slots onto the bots as well: they land in `ps.diy`, `initDiyStock` then stocks them like any 自选 piece
  // (`refreshDiyStock` reads `ps.diy`), and `_rollChessSlot` feeds `diyRollEntries()` into the bot's own roll — so a
  // bot rolls, buys and fields them. Author's report 2026-10-11: "AI 也能买到我的自选干员".
  const extras = ps?.isBot ? [] : diyExtras;
  if (src.size === 0 && extras.length === 0) return ps._diyRecords === src ? false : restoreDiyBase(ps, gd, src, recompute);
  // 携带技能 / 模组: rebuild the slots the panel edited, from the game's own pick with those fields replaced
  const skilled = new Map();
  for (const baseId of new Set([...Object.keys(diySkills), ...Object.keys(diyMods)])) {
    const pick = ps.__diyPicks?.[baseId];
    if (!pick) continue;
    const idx = diySkills[baseId];
    const hasMod = Object.prototype.hasOwnProperty.call(diyMods, baseId);
    const made = composeOwnSlot(gd, baseId, {
      ...pick,
      skillIndex: Number.isInteger(idx) ? idx : pick.skillIndex,
      uniEquipId: hasMod ? diyMods[baseId] : pick.uniEquipId,
    });
    if (made) skilled.set(baseId, made);
  }
  const records = new Map();
  for (const [id, rec] of src) {
    const baseId = (rec && rec.diyFor) || id;
    const made = skilled.get(baseId);
    const from = made ? (id === made.goldenId || String(id).endsWith('_b') ? made.elite : made.normal) : rec;
    records.set(id, applySlotOverride(diyPatcher.cfgOf(baseId), from));
  }
  // the mod's own slots (slot-rules "更多自选位"): composed here, because the game's own setDiy never saw them
  const extraPicks = {};
  for (const e of extras) {
    const made = composeExtraSlot(gd, e);
    if (!made) continue;
    const cfg = diyPatcher.cfgOf(made.baseId);
    records.set(made.baseId, applySlotOverride(cfg, made.normal));
    records.set(made.goldenId, applySlotOverride(cfg, made.elite));
    extraPicks[made.baseId] = made.pick;
  }
  const picks = { ...(ps.__diyPicks || {}), ...extraPicks };
  for (const [baseId, made] of skilled) picks[baseId] = made.pick;
  // compared against what the seat HOLDS right now (not against `src`): a config cleared back to nothing must still
  // replace a previously patched map, or the old kit would stick.
  const prev = ps._diyRecords;
  let changed = !(prev instanceof Map) || prev.size !== records.size;
  if (!changed) for (const [id, rec] of records) if (prev.get(id) !== rec) { changed = true; break; }
  if (!changed && sameDiyPicks(ps.diy, picks)) return false;
  ps._diyRecords = records;
  ps.diy = Object.freeze(picks);
  ps.gd = slotDeps.diyGameData(gd, records);
  if (recompute && typeof ps.recompute === 'function' && ps.board && ps.hand) {
    try { ps.recompute(); } catch (e) { /* the view is still installed; the strip catches up on the next recompute */ }
  }
  return true;
}

/** Put the seat back on the game's own records (a cleared kit must undo a previous one). */
function restoreDiyBase(ps, gd, src, recompute) {
  ps._diyRecords = src;
  ps.diy = Object.freeze({ ...(ps.__diyPicks || {}) });
  ps.gd = slotDeps.diyGameData(gd, src);
  if (recompute && typeof ps.recompute === 'function' && ps.board && ps.hand) {
    try { ps.recompute(); } catch (e) { /* the strip catches up on the next recompute */ }
  }
  return true;
}

/**
 * Re-compose one of the GAME's own 自选 slots around an edited 携带技能: the same steps setDiy takes (checkDiyPick, then
 * diyRecord for both forms) with `pick.skillIndex` replaced. Null when the pick or the skill is illegal, in which case
 * that slot simply keeps the record the game composed.
 */
function composeOwnSlot(gd, slotId, pick) {
  const data = gd?.raw;
  if (!data || !slotDeps.diyRecord || !slotDeps.checkDiyPick || !slotDeps.diySlot) return null;
  let chk;
  try { chk = slotDeps.checkDiyPick(slotId, pick, data); } catch { return null; }
  if (!chk || !('ok' in chk)) return null;
  const slot = slotDeps.diySlot(slotId, data);
  if (!slot) return null;
  let normal;
  let elite;
  try {
    normal = slotDeps.diyRecord(slotId, chk.pick, { elite: false, data });
    elite = slotDeps.diyRecord(slotId, chk.pick, { elite: true, data });
  } catch { return null; }
  if (!normal || !elite) return null;
  return { baseId: slot.baseId, goldenId: slot.goldenId, normal, elite, pick: chk.pick };
}

/** Whether two pick maps say the same thing (identity differs every rebuild, so compare the entries). */
function sameDiyPicks(a, b) {
  const ka = Object.keys(a || {});
  const kb = Object.keys(b || {});
  if (ka.length !== kb.length) return false;
  return ka.every((k) => {
    const x = a[k];
    const y = b[k];
    return !!y && x.charId === y.charId && x.skillIndex === y.skillIndex && (x.uniEquipId ?? null) === (y.uniEquipId ?? null);
  });
}

/**
 * Compose the pair of records of one mod-owned slot (slot-rules "更多自选位"). The game's `diyRecord` is reused through a
 * data shim that carries the mod's chess records and `diy.slots` entries, so a mod slot validates and composes exactly
 * like one of the game's own. Null when the pick is illegal or the data is missing.
 * @returns {{ baseId: string, goldenId: string, normal: object, elite: object, pick: object }|null}
 */
function composeExtraSlot(gd, e) {
  const base = gd?.raw;
  const slotId = extraSlotId(e?.k, false);
  const table = extraChessTable(gd);
  const slot = table?.[slotId];
  if (!base || !slot || !slotDeps.diyRecord || !slotDeps.checkDiyPick) return null;
  const data = {
    chess: { ...base.chess, ...table },
    backups: { ...base.backups, diy: extraDiyTable(base.backups?.diy, diyExtras) },
  };
  let chk;
  try { chk = slotDeps.checkDiyPick(slotId, e.pick, data); } catch { return null; }
  if (!chk || !('ok' in chk)) return null;
  let normal;
  let elite;
  try {
    normal = slotDeps.diyRecord(slotId, chk.pick, { elite: false, data });
    elite = slotDeps.diyRecord(slotId, chk.pick, { elite: true, data });
  } catch { return null; }
  if (!normal || !elite) return null;
  return { baseId: slotId, goldenId: extraSlotId(e.k, true), normal, elite, pick: chk.pick };
}

/**
 * Re-derive a seat's 自选 stock after a kit change, WITHOUT resetting the copies it already holds (`initDiyStock` rebuilds
 * every cap from scratch, which would hand back sold copies). A slot whose bonds are now all banned loses its stock, the
 * same rule the game applies once the bans are drawn.
 */
function refreshDiyStock(ps, off) {
  const stock = ps?.diyStock;
  const gd = ps?.m?.gd;
  if (!stock?.entries || !gd || !(off instanceof Set)) return;
  const banned = [];
  // a slot that is no longer slotted at all (a mod slot the panel removed) must lose its stock too
  for (const id of [...stock.entries.keys()]) if (!Object.prototype.hasOwnProperty.call(ps.diy || {}, id)) stock.entries.delete(id);
  for (const slotId of Object.keys(ps.diy || {})) {
    const rec = ps._diyRecords?.get?.(slotId);
    const bonds = rec && Array.isArray(rec.bonds) ? rec.bonds : [];
    if (bonds.length > 0 && bonds.every((b) => off.has(b))) { stock.entries.delete(slotId); banned.push(slotId); continue; }
    const cap = gd.poolCopies(slotId);
    if (!(cap > 0)) { stock.entries.delete(slotId); continue; }
    const slot = slotDeps.diySlot ? slotDeps.diySlot(slotId, gd.raw) : null;
    const entry = stock.entries.get(slotId);
    if (!entry) stock.entries.set(slotId, { cap, left: cap, tier: gd.tierOf(slotId), shopLevel: slot?.shopLevel ?? gd.tierOf(slotId) });
    else entry.cap = cap;
  }
  ps.diyBanned = Object.freeze(banned);
}

/** g.modDiy { slots } — the 自选位 kit. Not billed to the round's budget. */
function handleModDiy(match, playerId, msg, state, ERR) {
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isDiyCfg(msg)) return fail(ERR.BAD_TARGET, '自选位设置不合法');
  // the master switches: a group that is off contributes NOTHING here, which also means the panel's next push clears
  // whatever it had set (the payload is a full replacement, not a patch).
  const slotsCfg = state.enable.diy ? msg.slots : {};
  const extraCfg = state.enable.diyExtra ? msg.extra : [];
  const skillsCfg = state.enable.diy ? msg.skills : {};
  const modsCfg = state.enable.diy ? msg.mods : {};
  const data = match.gd?.raw || null;
  const knownSlots = new Set(Object.keys(data?.backups?.diy?.slots || {}));
  for (const e of extraCfg || []) if (e && Number.isInteger(e.k)) knownSlots.add(extraSlotId(e.k, false));
  const tables = data ? { bonds: data.bonds, garrisons: data.garrisons } : null;
  const next = new Map();
  for (const [slotId, raw] of Object.entries(slotsCfg || {})) {
    const base = slotBaseId(slotId);
    if (!knownSlots.has(base)) return fail(ERR.BAD_TARGET, `不是本局的位子（${slotId}）`);
    if (raw == null) continue;
    const cfg = normalizeSlotCfg(raw, tables);
    // an explicit-but-illegal config (a bond that does not exist) is refused rather than silently dropped
    const wanted = (Array.isArray(raw.bonds) && raw.bonds.length) || (Array.isArray(raw.addBonds) && raw.addBonds.length)
      || (Array.isArray(raw.garrisons) && raw.garrisons.length);
    if (!cfg && wanted) return fail(ERR.BAD_TARGET, `自选位设置里没有可用的盟约或特质（${slotId}）`);
    if (!cfg) continue;
    next.set(base, cfg);
  }
  diyPatcher.set(next);
  // the mod's own slots: a slot with no pick yet is not built (nothing to compose), and `k` is unique by construction
  const extras = [];
  const seen = new Set();
  for (const e of extraCfg || []) {
    if (!e || !e.pick || typeof e.pick.charId !== 'string' || seen.has(e.k)) continue;
    seen.add(e.k);
    extras.push({ k: e.k, tier: e.tier, pick: { charId: e.pick.charId, skillIndex: e.pick.skillIndex ?? null, uniEquipId: e.pick.uniEquipId ?? null } });
  }
  diyExtras = extras;
  const skills = Object.create(null);
  for (const [slotId, idx] of Object.entries(skillsCfg || {})) {
    if (Number.isInteger(idx) && idx >= 0 && idx <= 9) skills[slotBaseId(slotId)] = idx;
  }
  diySkills = skills;
  const mods = Object.create(null);
  for (const [slotId, id] of Object.entries(modsCfg || {})) {
    if (id === null || typeof id === 'string') mods[slotBaseId(slotId)] = id || null;
  }
  diyMods = mods;
  slotGen++; // the number edits changed: the memoised data patches have to be rebuilt
  // every seat is OFFERED the rebuild (the config is process-wide); `applyModDiy` itself declines on a bot, so only a
  // seat that can actually field 自选 pieces is touched
  let n = 0;
  for (const ps of match.players?.values?.() || []) {
    if (applyModDiy(ps, { recompute: true })) {
      if (ps.__modDiyOff) refreshDiyStock(ps, ps.__modDiyOff);
      n++;
    }
  }
  try { match.flush(); } catch (e) { match.reportError?.('modDiy', e); }
  return OK;
}

// -----------------------------------------------------------------------------------------------------
// the master switches (g.modEnable)
//
// The author's ask (2026-10-11): he keeps ending up "wanting everything", which flattens the game, so he wants a
// switch per GROUP of gameplay-changing features — and a switch has to mean the feature DOES NOT EXIST, not merely
// that new messages are refused. Hence `rollbackFeature`: turning one off takes back what is already in effect.
//
// 倍速 and 自动倒转 are not in the table and are untouched by any of this. Neither changes the simulation (the speed
// is presentation, and the auto loop spends only the seat's own funds on its own purchases), which is what leaves the
// "play it straight, but fast, and let the loop do the shopping" session possible.
// -----------------------------------------------------------------------------------------------------

/** g.modEnable { features } — set the master switches; each one turned off has its live state taken back. */
function handleEnable(match, playerId, msg, state, ERR) {
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isFeatures(msg.features)) return fail(ERR.BAD_TARGET, '开关参数不合法');
  const next = { ...state.enable };
  for (const [k, v] of Object.entries(msg.features)) if (FEATURE_KEYS.includes(k)) next[k] = v;
  const turnedOff = FEATURE_KEYS.filter((k) => state.enable[k] && !next[k]);
  state.enable = next;
  for (const k of turnedOff) {
    try { rollbackFeature(match, state, k); } catch (e) { match.reportError?.(`modEnable:${k}`, e); }
  }
  try {
    for (const ps of match.players?.values?.() || []) ps.dirty?.();
    match.flush();
  } catch (e) {
    match.reportError?.('modEnable', e);
  }
  return OK;
}

/** Take back one group's live effect. Everything here is process-wide, so it runs over every seat. */
function rollbackFeature(match, state, key) {
  const seats = [...(match.players?.values?.() || [])];
  if (key === 'shop') {
    // nothing persistent: a pick or a direct buy lands the moment it arrives, and the round's budget is spent as it
    // goes. Refusing the next one (the guard in the handlers) is the whole of it.
  } else if (key === 'sandboxBands') {
    for (const ps of seats) {
      ps.modBands = [];
      // The LP floor a stack raised is NOT taken back: lp is already spent and the game cannot unsay it. `applyMaxLp`
      // re-reads `modBands` on every band apply, so with the list emptied nothing keeps raising it.
      try { applyMaxLp(match, ps); } catch { /* the floor just stays where it was */ }
    }
  } else if (key === 'sandboxPlace') {
    // both the unlock and the cap are read at the CALL SITE (deployMapFor / _placementOf / the deployCap getter), so
    // clearing these two is enough — the same path handlePlace takes when the panel switches it off.
    state.sandbox.place = false;
    state.sandbox.cap = null;
    for (const ps of seats) ps.invalidateDeployMap?.();
  } else if (key === 'sandboxUnit') {
    state.unit = null;
    unitPatcher.set(null);
  } else if (key === 'diy' || key === 'diyExtra') {
    if (key === 'diy') diyPatcher.set(new Map());
    else diyExtras = [];
    for (const ps of seats) {
      // rebuild from the game's own records; with both maps empty this puts the seat back on `__diyBase` exactly
      try { applyModDiy(ps, { recompute: false }); } catch { /* the view stays; the strip catches up on recompute */ }
      try { if (ps.__modDiyOff) refreshDiyStock(ps, ps.__modDiyOff); } catch { /* stock refresh is best-effort */ }
    }
  } else if (key === 'shopFilter') {
    for (const ps of seats) ps.modShopFilter = { on: false, bonds: [] };
  }
  for (const ps of seats) { try { ps.recompute?.(); } catch { /* best effort */ } }
}

/** Install the 自选位 seams: the prep rebuild (setDiy / initDiyStock) and the stock refresh hook. */
function installSlotRules({ PlayerState, Battle, GameData, DataSource, support, diyMod, diyDataMod, bondsMetaMod, log }) {
  const missing = [];
  if (typeof diyMod?.diyGameData !== 'function') missing.push('server/match/player/diy.js diyGameData');
  else slotDeps.diyGameData = diyMod.diyGameData;
  if (typeof diyDataMod?.diySlot === 'function') slotDeps.diySlot = diyDataMod.diySlot;
  if (typeof diyDataMod?.diyRecord === 'function') slotDeps.diyRecord = diyDataMod.diyRecord;
  if (typeof diyDataMod?.checkDiyPick === 'function') slotDeps.checkDiyPick = diyDataMod.checkDiyPick;
  if (typeof bondsMetaMod?.computeBonds !== 'function') missing.push('server/match/bondsMeta.js computeBonds');
  if (typeof support?.gameData === 'function' && typeof support?.setGameData === 'function') slotDeps.support = support;
  else missing.push('server/sim/content/support/index.js setGameData');

  // the kit's number edits, resolved by the PREP side: a 特质 the author gave his own numbers lives under a minted id
  // (slot-rules mintGarrisonId) that the data does not have; a 盟约 keeps its own id but carries the author's `bb`.
  if (typeof GameData?.prototype?.garrison !== 'function') {
    missing.push('GameData.prototype.garrison');
  } else {
    const origGarrison = GameData.prototype.garrison;
    GameData.prototype.garrison = function garrison(id) {
      const patched = patchedDataOf(this.raw);
      return (patched !== this.raw ? patched.garrisons?.[id] : null) ?? origGarrison.call(this, id);
    };
    const origBond = GameData.prototype.bond;
    GameData.prototype.bond = function bond(id) {
      const patched = patchedDataOf(this.raw);
      return (patched !== this.raw ? patched.bonds?.[id] : null) ?? origBond.call(this, id);
    };
    // the mod's own slots: every accessor (`tierOf`, `poolCopies`, `chessPrice`, `baseIdOf`, `goldenIdOf`, …) reads the
    // chess table through this one method, so resolving them here is enough for the whole prep side
    const origChess = GameData.prototype.chess;
    GameData.prototype.chess = function chess(id) {
      const table = extraChessTable(this);
      if (table && isExtraSlotId(id) && table[id]) return table[id];
      return origChess.call(this, id);
    };
    log.info('hooked GameData.garrison / .bond / .chess (自选位 numbers + 更多位子)');
  }

  // the BATTLE side resolves a 自选 def through the DataSource's own tables (`rawChess` / `rawBackups`), so a mod slot
  // has to answer there too or its piece would come out as an unknown chess on both processes.
  if (typeof DataSource?.prototype?.rawChess === 'function') {
    const origRawChess = DataSource.prototype.rawChess;
    DataSource.prototype.rawChess = function rawChess(id) {
      const table = extraChessTable(this);
      if (table && isExtraSlotId(id) && table[id]) return table[id];
      return origRawChess.call(this, id);
    };
    const origRawBackups = DataSource.prototype.rawBackups;
    DataSource.prototype.rawBackups = function rawBackups() {
      const b = origRawBackups.call(this);
      if (!b || !diyExtras.length) return b;
      return { ...b, diy: extraDiyTable(b.diy, diyExtras) };
    };
    log.info('hooked DataSource.rawChess / .rawBackups (更多位子)');
  } else {
    missing.push('DataSource.prototype.rawChess');
  }

  // the BATTLE side reads its numbers from `support.gameData()`; the swap has to bracket the content install, which is
  // the one moment every bond / 特质 installer reads its `bb` (they capture it then and re-apply from the closure).
  if (typeof Battle?.prototype?._safe === 'function') {
    const origSafe = Battle.prototype._safe;
    Battle.prototype._safe = function _safe(fn, label, owner) {
      if (label !== 'installContent' || !slotDeps.support) return origSafe.call(this, fn, label, owner);
      const base = slotDeps.support.gameData();
      const patched = patchedDataOf(base);
      if (patched === base) return origSafe.call(this, fn, label, owner);
      slotDeps.support.setGameData(patched);
      try {
        return origSafe.call(this, fn, label, owner);
      } finally {
        slotDeps.support.setGameData(base);
      }
    };
    log.info('hooked Battle.prototype._safe (自选位 numbers)');
  } else {
    missing.push('Battle.prototype._safe');
  }

  if (typeof PlayerState?.prototype?.setDiy !== 'function') {
    missing.push('PlayerState.prototype.setDiy');
    return missing;
  }
  const origSetDiy = PlayerState.prototype.setDiy;
  PlayerState.prototype.setDiy = function setDiy(picks, opts) {
    const res = origSetDiy.call(this, picks, opts);
    // keep the game's own composed records as the base every rebuild starts from (applyModDiy must never layer)
    if (this._diyRecords instanceof Map) this.__diyBase = this._diyRecords;
    this.__diyPicks = { ...(this.diy || {}) };
    // the constructor calls this before hand / board exist: rebuild the records and the view, no bond recompute
    try { applyModDiy(this, { recompute: false }); } catch (e) { log.warn('自选位 kit rebuild failed', e?.message || e); }
    return res;
  };
  const origInitStock = PlayerState.prototype.initDiyStock;
  if (typeof origInitStock === 'function') {
    PlayerState.prototype.initDiyStock = function initDiyStock(off = new Set()) {
      this.__modDiyOff = off instanceof Set ? off : new Set();
      const res = origInitStock.call(this, off);
      // the kit may make a slot 本局禁用 (all its bonds banned) or un-ban it: re-derive the stock from the patched records
      try { if (!diyPatcher.empty) refreshDiyStock(this, this.__modDiyOff); } catch (e) { log.warn('自选位 stock refresh failed', e?.message || e); }
      return res;
    };
  } else {
    missing.push('PlayerState.prototype.initDiyStock');
  }
  return missing;
}

// -----------------------------------------------------------------------------------------------------
// the shop mutations
// -----------------------------------------------------------------------------------------------------

/**
 * Fill shop slot `slotIdx` with `id`. Same gates as PlayerState.buy's first half (prep phase, alive, not ready,
 * unsold slot, matching kind) and the same eligibility the roll itself obeys.
 * @returns {null | { error: string, detail?: string }} null = done
 */
function pickSlot(ps, slotIdx, id, { ERR, PHASE }) {
  const gate = ps._gate();
  if (gate) return gate;
  if (ps.m?.phase !== PHASE.PREP) return fail(ERR.WRONG_PHASE);

  const slots = ps.shop?.slots;
  if (!Array.isArray(slots) || !Number.isInteger(slotIdx) || slotIdx < 0 || slotIdx >= slots.length) return fail(ERR.BAD_TARGET);
  const cur = slots[slotIdx];
  if (cur && cur.sold) return fail(ERR.BAD_TARGET, '该槽位已售出');

  const layout = ps.shop.layout || { chess: slots.length, item: 0 };
  const frozen = !!ps.shop.frozen;

  if (slotIdx < layout.chess) {
    const bad = chessEligibility(ps, id, ERR);
    if (bad) return bad;
    slots[slotIdx] = { kind: 'chess', id, basePrice: ps.gd.chessPrice(id), frozen, sold: false };
  } else {
    const bad = itemEligibility(ps, id, ERR);
    if (bad) return bad;
    slots[slotIdx] = { kind: 'item', id, basePrice: ps.gd.itemPrice(id), frozen, sold: false };
  }

  ps.dirty();
  return null;
}

/**
 * Buy `id` straight into the hand: no shop slot, no roll, no refresh. Mirrors PlayerState.buy's first half
 * (PlayerState.js:888) against a synthetic slot, then runs the same tail (spend → acquire → stats → onBuy → after
 * spend → recompute). The synthetic slot matters: onBuy handlers read `ev.slot.id` (server/sim/content/bands/meta.js).
 * @returns {null | { error: string, detail?: string }} null = done
 */
function directBuy(ps, id, { ERR }) {
  const gate = ps._gate();
  if (gate) return gate; // already enforces PREP / alive / not ready

  const kind = ps.gd.chess(id) ? 'chess' : ps.gd.item(id) ? 'item' : null;
  if (!kind) return fail(ERR.BAD_TARGET, '不是可招募的干员或装备');
  const bad = kind === 'chess' ? chessEligibility(ps, id, ERR) : itemEligibility(ps, id, ERR);
  if (bad) return bad;

  const handFull = !ps.hand.some((p) => p == null);
  if (handFull && !(kind === 'chess' ? ps.completesChessMerge(id) : ps.completesItemMerge(id))) {
    return fail(ERR.HAND_FULL);
  }

  const slot = { kind, id, basePrice: kind === 'chess' ? ps.gd.chessPrice(id) : ps.gd.itemPrice(id), frozen: false, sold: false };
  const price = ps.priceOf(slot); // keeps the onPrice chain (band/garrison discounts) working
  if (ps.funds < price) return fail(ERR.NO_FUNDS);

  ps.spend(price);
  slot.sold = true;
  const piece = kind === 'chess' ? ps.acquireChess(id, { source: 'buy' }) : ps.acquireItem(id, { source: 'buy' });
  ps.stats.buys++;
  ps.round.buys++;
  ps.m.dispatch(ps, 'onBuy', { piece, slot, price, kind });
  ps._afterSpend(price, 'buy');
  ps.recompute();
  return null;
}

/** The eligibility the roll itself obeys for a base chess: visible, tier ≤ shop level, a copy left in the pool. */
function chessEligibility(ps, id, ERR) {
  const rec = ps.gd.chess(id);
  if (!rec || rec.isGolden || rec.isHidden || !Number.isInteger(rec.tier)) {
    return fail(ERR.BAD_TARGET, '不是可招募的干员');
  }
  // 自选编队 (0.2.0): `ps.gd` is THIS seat's own data view, so a slot they filled resolves to the composed record of
  // their own pick (`diyFor`, player/diy.js diyGameData). An unfilled slot, another seat's, or a bot's has no `diyFor`
  // and stays refused — exactly like the raw slot record the rolled shop would never draw.
  if (rec.isDiy) return diyEligibility(ps, id, rec, ERR);
  if (!rec.visible) return fail(ERR.BAD_TARGET, '不是可招募的干员');
  if (rec.tier > ps.shop.level) return fail(ERR.BAD_TARGET, '调度中心等级不足');
  if (!ps.m.pool?.has(id) || ps.m.pool.left(id) < 1) return fail(ERR.SOLD_OUT, '卡池里没有多余的该干员');
  return null;
}

/**
 * The eligibility a 自选 piece obeys: this seat's own stock of the slot, and the same 调度中心 gate the roll uses.
 * A slot's stock is per player and never enters the shared pool (player/diy.js DiyStock); a slot whose bonds are all
 * switched off this match has no stock at all, so it leaves the shop like a preset whose bonds are gone. The gate is
 * the slot's own `shopLevel` (activity_table: the tier-5 slots at level 5, the tier-6 ones at level 6), not its tier.
 */
function diyEligibility(ps, id, rec, ERR) {
  if (!rec.diyFor) return fail(ERR.BAD_TARGET, '不是本局可用的自选干员');
  const stock = ps.diyStock?.entries?.get(ps.gd.baseIdOf(id));
  if (!stock) return fail(ERR.BAD_TARGET, '不是本局可用的自选干员');
  if (ps.shop.level < stock.shopLevel) return fail(ERR.BAD_TARGET, `调度中心等级不足（自选干员要 Lv.${stock.shopLevel}）`);
  if (!(stock.left > 0)) return fail(ERR.SOLD_OUT, '这名自选干员的份额已经用完了');
  return null;
}

/** The eligibility the roll itself obeys for an item: shop-eligible and its tier unlocked. */
function itemEligibility(ps, id, ERR) {
  const rec = ps.gd.item(id);
  if (!rec) return fail(ERR.BAD_TARGET, '不是装备');
  const tier = Number.isInteger(rec.tier) ? rec.tier : 1;
  const list = ps.gd.shopItemsByTier?.[tier];
  if (tier > ps.shop.level || !Array.isArray(list) || !list.includes(id)) return fail(ERR.BAD_TARGET, '这档装备不会出现在商店');
  return null;
}

// -----------------------------------------------------------------------------------------------------
// the shop bond filter (阵营锁)
//
// The author's ask (2026-10-10): once you have settled on the bonds you are building, the shop stops offering
// anything else. The scope he set:
//
//   * the AUTOMATIC roll only — the panel's 自选/直购 list is left alone (he explicitly did not want it locked);
//   * this seat only — the setting rides on `ps.modShopFilter`, so the AI seats (same code, different seat) are a
//     no-op;
//   * the STRICT subset reading — an operator is kept only when EVERY one of its bonds is in the chosen set. So
//     under {炎, 灵巧, 奥术} the piece [炎, 维多利亚] is dropped and [炎, 灵巧] is kept (odds are narrow on
//     purpose; the panel shows the live admitted count so a selection that empties the shop is visible up front).
//
// The seam is `PlayerState.prototype._rollChessSlot` (server/match/player/economy.js:63): three lines that hand
// `{ maxTier, extra }` to `SharedPool.roll`, which already takes a `filter` — the very mechanism the game's own
// bond grants use (choices.js:484-491, builtinMeta.js:54). Re-implementing those three lines is the cheapest
// injection point; wrapping `pool.roll` instead would need a "which seat is rolling" side channel, since the pool
// is shared and seat-blind. `extra` (this seat's own 自选编队 stock) goes through the same filter, so a 自选
// operator outside the chosen bonds stops appearing too. A slot the filter leaves empty STAYS empty (`roll`
// returns null and `rollShop` already accepts null slots) — that is the lock working, so there is no fallback.
// -----------------------------------------------------------------------------------------------------

/** The seat's active filter, or null when it is off / empty (an empty set must not blank the shop by accident). */
function activeShopFilter(ps) {
  const f = ps?.modShopFilter;
  if (!f || !f.on || !Array.isArray(f.bonds) || !f.bonds.length) return null;
  return f;
}

/** `SharedPool.roll`'s `filter(id, entry)`: keep only chess EVERY one of whose bonds is in `bonds`. */
const bondSubset = (ps, bonds) => {
  const set = new Set(bonds);
  return (cid) => {
    const c = ps.gd.chess(cid);
    const bs = c && Array.isArray(c.bonds) ? c.bonds : null;
    return !!bs && bs.length > 0 && bs.every((b) => set.has(b));
  };
};

/**
 * The bonds that are actually in play this match, for the panel's picker: any bond carried by a chess that is in the
 * pool (so a 本局禁用 or hidden operator's bonds never show). Memoised on the match — the pool's roster is fixed for
 * the whole match, and this runs out of `privateView`, which is rebuilt on every change.
 */
function bondPool(ps) {
  const m = ps?.m;
  if (!m) return [];
  if (Array.isArray(m.__modBondPool)) return m.__modBondPool;
  const gd = ps.gd;
  const seen = new Set();
  const out = [];
  for (const id of gd.visibleChess || []) {
    if (!m.pool?.has?.(id)) continue;
    const c = gd.chess(id);
    for (const b of (c && Array.isArray(c.bonds)) ? c.bonds : []) {
      if (seen.has(b) || !gd.bond(b)) continue;
      seen.add(b);
      const rec = gd.bond(b);
      out.push({ id: b, name: rec.name || b, isCore: !!rec.isCore });
    }
  }
  out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  m.__modBondPool = out;
  return out;
}

/** How many DISTINCT operators the filter admits right now (same guards as the roll: in pool, tier ≤ level, copies
 *  left; plus this seat's 自选编队 stock). Lets the panel warn before a selection empties the shop. */
function shopFilterCount(ps, bonds) {
  const keep = bondSubset(ps, bonds);
  const level = ps.shop?.level ?? 1;
  let n = 0;
  for (const id of ps.gd.visibleChess || []) {
    if (!ps.m?.pool?.has?.(id)) continue;
    if (ps.gd.tierOf(id) > level || ps.m.pool.left(id) < 1) continue;
    if (keep(id)) n++;
  }
  for (const [id, e] of ps.diyStock?.entries || []) {
    if (!(e.left > 0) || e.shopLevel > level) continue;
    const rec = ps.gd.chess(id);
    if (rec && rec.diyFor && keep(id)) n++;
  }
  return n;
}

/** What the panel reads: this seat's 阵营锁, the bonds it may name, and the live admitted count. */
function shopFilterView(ps) {
  const f = ps?.modShopFilter;
  const on = !!(f && f.on);
  const bonds = f && Array.isArray(f.bonds) ? f.bonds : [];
  return { on, bonds, pool: bondPool(ps), count: on && bonds.length ? shopFilterCount(ps, bonds) : null };
}

/** g.modShopFilter { on, bonds } — the 阵营锁. Not billed to the round's budget. */
function handleShopFilter(match, playerId, msg, state, ERR) {
  if (!state.enable.shopFilter) return fail(ERR.BAD_TARGET, '阵营锁已关闭（总开关）');
  const seat = seatFor(match, playerId);
  if (seat.error) return seat.error;
  if (!isShopFilter(msg)) return fail(ERR.BAD_TARGET, '阵营锁参数不合法');
  const ps = seat.ps;
  const gd = match.gd;
  const bonds = [];
  for (const id of msg.bonds) {
    if (!gd.bond(id)) return fail(ERR.BAD_TARGET, `没有这个盟约（${id}）`);
    if (!bonds.includes(id)) bonds.push(id);
  }
  ps.modShopFilter = { on: !!msg.on, bonds };
  try { ps.dirty?.(); match.flush(); } catch (e) { match.reportError?.('modShopFilter', e); }
  return OK;
}

/** The `_rollChessSlot` wrapper: the game's own three lines with `filter` folded in when this seat's lock is on. */
function installShopFilter({ PlayerState, log }) {
  if (typeof PlayerState?.prototype?._rollChessSlot !== 'function') return ['PlayerState.prototype._rollChessSlot'];
  const origRollChess = PlayerState.prototype._rollChessSlot;
  PlayerState.prototype._rollChessSlot = function _rollChessSlot() {
    const f = activeShopFilter(this);
    if (!f) return origRollChess.call(this);
    const extra = typeof this.diyRollEntries === 'function' ? this.diyRollEntries() : null;
    const id = this.m.pool.roll(this.m.rngShop, {
      maxTier: this.shop.level,
      extra,
      filter: bondSubset(this, f.bonds),
    });
    return id ? { kind: 'chess', id, basePrice: this.gd.chessPrice(id), frozen: false, sold: false } : null;
  };
  log.info('hooked PlayerState._rollChessSlot (阵营锁)');
  return [];
}

// -----------------------------------------------------------------------------------------------------
// what the panel may offer
// -----------------------------------------------------------------------------------------------------

/**
 * The ids this player could legitimately roll into a shop slot right now: visible base chess of tier ≤ shop level
 * that are in this match's pool with a copy left, plus the shop-eligible items of those tiers, plus this seat's own
 * 自选编队 pieces.
 * Recomputed per private view (the view is rebuilt on every change), so it always agrees with the server.
 */
function pickable(ps) {
  const level = ps.shop?.level ?? 1;
  const chess = [];
  // every card THIS match's protocol deals, at any level: the auto-reverse target list filters on this, so a card
  // that is 本局禁用 or hidden never shows up in it (调度中心等级 is a temporary limit, not a ban — the list would
  // otherwise shrink to tier 1 at the start of every match)
  const pool = [];
  for (const id of ps.gd.visibleChess || []) {
    if (!ps.m?.pool?.has(id)) continue;
    pool.push(id);
    if (ps.gd.tierOf(id) > level || ps.m.pool.left(id) < 1) continue;
    chess.push(id);
  }
  const item = [];
  for (let t = 1; t <= level; t++) {
    const list = ps.gd.shopItemsByTier?.[t];
    if (Array.isArray(list)) item.push(...list);
  }
  // 自选编队 (0.2.0): this seat's own slotted operators. They never join the shared pool — each seat has its own stock
  // (player/diy.js DiyStock) and only its own shop draws from it — so they are listed from that stock instead. Listed
  // as soon as the seat has one with copies left, `ok: false` while the 调度中心 is still below the slot's own
  // `shopLevel` (the same gate diyRollEntries applies): the player's own picks must not be invisible just because the
  // level is low — the panel greys them and says which level opens them.
  const diy = [];
  for (const [id, e] of ps.diyStock?.entries || []) {
    if (!(e.left > 0)) continue;
    const rec = ps.gd.chess(id);
    if (!rec || !rec.diyFor) continue; // an unfilled slot has no composed record of ours
    diy.push({ id, tier: e.tier, level: e.shopLevel, ok: level >= e.shopLevel, left: e.left });
  }
  // slot counts come from the level's own table, not from the current roll: a private view sent before the shop rolled
  // (slots still empty) must still tell the panel which slots there are
  const lv = ps.gd.shopSlots(level) || { chess: 3, item: 1 };
  const layout = ps.shop?.layout;
  const chessSlots = layout && Number.isInteger(layout.chess) && layout.chess > 0 ? layout.chess : lv.chess;
  const itemSlots = layout && Number.isInteger(layout.item) && layout.item > 0 ? layout.item : lv.item;
  return { chess, pool, item, diy, chessSlots, itemSlots };
}

// =====================================================================================================
// RECORDER — one JSONL, one event per line. See README "记录了什么".
//
//   act     a seat action (human or bot): name, args, ok/err, and before/after fingerprints + a noop flag, so a
//           rejected action and a does-nothing action are both distinguishable. A HUMAN act also carries `snap`
//           (the full private view).
//   intent  the raw `g.*` a human sent (thin; covers intents with no PlayerState verb and validation rejects)
//   round   once per round: stage, the three special enemy types, this round's enemy plan, per-seat summary
//   prep    once per round per human: the full private view at the start of prep
//   combat  once per combat: each seat's kills/leaks/perfect
//   settle  once per round: each seat's LP before→after, damage taken, leaks, elimination
//   start   round 1: mode/difficulty/stage/factions/boss rounds/the 15-round type schedule
//   end     the match finished
// =====================================================================================================

function installRecorder({ Match, PlayerState, state, log }) {
  const missing = [];
  const emit = (ev) => emitEvent(state, log, ev);

  // -- per-seat actions --------------------------------------------------------------------------------
  for (const name of PS_ACTIONS) {
    if (typeof PlayerState.prototype[name] !== 'function') { missing.push(`PlayerState.${name}`); continue; }
    const orig = PlayerState.prototype[name];
    PlayerState.prototype[name] = function (...args) {
      const before = fingerprint(this);
      const h1 = stateHash(this);
      let res;
      try {
        res = orig.apply(this, args);
      } catch (e) {
        emit(actEvent(this, name, args, fail('THREW', String(e?.message || e)), before, fingerprint(this), null));
        throw e;
      }
      const noop = h1 != null && h1 === stateHash(this) && !(res && res.error);
      emit(actEvent(this, name, args, res, before, fingerprint(this), noop));
      return res;
    };
  }

  // -- match-level actions (act PlayerState is the first argument) --------------------------------------
  // a card or an autoplay toggle can act entirely outside the seat's visible state, so no noop verdict there
  const NOOP_TRACKED = (name) => name !== 'pickCard' && name !== 'setAutoplay';
  for (const name of MATCH_ACTIONS) {
    if (typeof Match.prototype[name] !== 'function') { missing.push(`Match.${name}`); continue; }
    const orig = Match.prototype[name];
    Match.prototype[name] = function (ps, ...rest) {
      const before = ps ? fingerprint(ps) : null;
      const h1 = ps && NOOP_TRACKED(name) ? stateHash(ps) : null;
      const res = orig.apply(this, [ps, ...rest]);
      if (ps && ps.playerId) {
        const noop = h1 != null && h1 === stateHash(ps) && !(res && res.error) ? true : null;
        emit(actEvent(ps, name, rest, res, before, fingerprint(ps), noop));
      }
      return res;
    };
  }

  // -- lifecycle --------------------------------------------------------------------------------------
  for (const [name, build] of [
    ['startRound', (m) => [roundEvent(m), m.round === 1 ? startEvent(m) : null]],
    ['enterPrep', (m) => prepEvents(m)],
    ['_finishCombat', (m) => [combatEvent(m)]],
  ]) {
    if (typeof Match.prototype[name] !== 'function') { missing.push(`Match.${name}`); continue; }
    const orig = Match.prototype[name];
    Match.prototype[name] = function (...args) {
      const res = orig.apply(this, args);
      try { for (const ev of build(this) || []) if (ev) emit(ev); } catch (e) { log.warn(`record ${name} failed`, e?.message || e); }
      return res;
    };
  }

  // settle needs the pre-charge LP; finish marks the end.
  if (typeof Match.prototype.settle !== 'function') {
    missing.push('Match.settle');
  } else {
    const origSettle = Match.prototype.settle;
    Match.prototype.settle = function (...args) {
      const before = new Map();
      for (const ps of this.players?.values?.() || []) before.set(ps.playerId, { lp: ps.lp, leaks: ps.stats?.leaks ?? 0 });
      const res = origSettle.apply(this, args);
      try { emit(settleEvent(this, before)); } catch (e) { log.warn('record settle failed', e?.message || e); }
      return res;
    };
  }
  if (typeof Match.prototype.finish !== 'function') {
    missing.push('Match.finish');
  } else {
    const origFinish = Match.prototype.finish;
    Match.prototype.finish = function (...args) {
      const res = origFinish.apply(this, args);
      try { emit(endEvent(this)); } catch (e) { log.warn('record finish failed', e?.message || e); }
      return res;
    };
  }

  return missing;
}

// ---- event builders ----------------------------------------------------------------------------------

function actEvent(ps, fn, args, res, before, after, noop) {
  const ok = !(res && typeof res === 'object' && res.error);
  const ev = {
    k: 'act',
    t: nowIso(),
    round: ps.m?.round ?? null,
    phase: ps.m?.phase ?? null,
    seat: ps.playerId,
    ai: !!ps.isBot,
    controlled: !!ps.botControlled, // true once a human toggled AI 托管: `ai` is then misleading
    fn,
    args: jsonSafe(args),
    ok: !!ok,
    before,
    after,
  };
  if (noop !== null && noop !== undefined) ev.noop = !!noop;
  if (!ok) { ev.err = res.error; if (res.detail) ev.detail = res.detail; }
  if (!ps.isBot) ev.snap = safeView(ps);
  return ev;
}

function roundEvent(m) {
  return {
    k: 'round',
    t: nowIso(),
    round: m.round,
    stageId: m.stageId ?? null,
    factions: Array.from(m.factions || []),
    wave: waveBrief(m),
    seats: seatBriefs(m),
  };
}

function startEvent(m) {
  return {
    k: 'start',
    t: nowIso(),
    round: m.round,
    mode: m.mode ?? null,
    difficulty: m.difficulty ?? null,
    // the match's master seed and its battleId prefix: without them a recorded run cannot be replayed headlessly
    // (Match.js sets this.seed from the lobby's seedFn; battlePrefix is `<seed36>[-<matchNo36>]`). Old logs lack them.
    seed: (Number(m.seed) >>> 0) || null,
    battleId: m.battlePrefix ?? null,
    stageId: m.stageId ?? null,
    factions: Array.from(m.factions || []),
    bossRound: m.gd?.bossRound ?? null,
    hiddenRound: m.gd?.hiddenRound ?? null,
    schedule: scheduleBrief(m),
  };
}

function prepEvents(m) {
  const out = [];
  for (const ps of m.players?.values?.() || []) {
    if (ps.isBot || ps.spectator || !ps.alive) continue;
    out.push({ k: 'prep', t: nowIso(), round: m.round, seat: ps.playerId, brief: seatBrief(ps), snap: safeView(ps) });
  }
  return out;
}

function combatEvent(m) {
  const seats = [];
  for (const [pid, r] of m.lastResults || []) {
    if (!r) continue;
    seats.push({
      seat: pid,
      killed: r.killed ?? null,
      total: r.total ?? null,
      leaks: (r.leaked || []).filter((l) => l && l.counted !== false).length,
      perfect: r.perfect !== false,
    });
  }
  return { k: 'combat', t: nowIso(), round: m.round, seats };
}

function settleEvent(m, before) {
  const seats = [];
  for (const ps of m.players?.values?.() || []) {
    const b = before.get(ps.playerId) || { lp: ps.lp, leaks: ps.stats?.leaks ?? 0 };
    const leaks = (ps.stats?.leaks ?? 0) - b.leaks;
    seats.push({
      seat: ps.playerId,
      lpBefore: b.lp,
      lpAfter: ps.lp,
      damage: b.lp - ps.lp,
      leaks,
      eliminated: !ps.alive,
    });
  }
  return { k: 'settle', t: nowIso(), round: m.round, seats };
}

function endEvent(m) {
  return { k: 'end', t: nowIso(), round: m.round, victory: !!m.victory, outcome: jsonSafe(m.outcome ?? null), seats: seatBriefs(m) };
}

// ---- small helpers -----------------------------------------------------------------------------------

function seed(ps) {
  return {
    seat: ps.playerId,
    ai: !!ps.isBot,
    controlled: !!ps.botControlled,
    alive: !!ps.alive,
    lp: ps.lp,
    funds: ps.funds,
    level: ps.shop?.level ?? null,
    handN: ps.hand ? ps.hand.filter(Boolean).length : 0,
    boardN: ps.deployCount ?? 0,
    bandId: ps.bandId ?? null,
  };
}

function seatBrief(ps) {
  const s = seed(ps);
  s.bonds = bondsBrief(ps);
  return s;
}

function seatBriefs(m) {
  const out = [];
  for (const ps of m.players?.values?.() || []) out.push(seatBrief(ps));
  return out;
}

function bondsBrief(ps) {
  const out = [];
  let view;
  try { view = ps.bondsView ? ps.bondsView() : ps.bonds; } catch { view = null; }
  for (const [id, b] of Object.entries(view || {})) {
    if (!b || !((b.count > 0) || (b.layers > 0) || b.active)) continue;
    out.push({ id, count: b.count ?? 0, tier: b.tier ?? 0, layers: b.layers ?? 0, active: !!b.active });
  }
  return out;
}

function waveBrief(m) {
  if (Array.isArray(m.bossWaves) && m.bossWaves.length) {
    return { boss: true, groups: m.bossWaves.map((g) => ({ players: g.players, spawns: spawnsBrief(g.wave) })) };
  }
  const w = m.wave;
  if (!w) return null;
  const p = w.pick || {};
  return {
    boss: false,
    templateId: w.templateId ?? null,
    timeLimit: w.timeLimit ?? null,
    pick: { round: p.round ?? null, type: p.type ?? null, key: p.key ?? null, normal: p.normal ?? null, elite: p.elite ?? null },
    spawns: spawnsBrief(w),
  };
}

function spawnsBrief(w) {
  return (w?.spawns || []).map((s) => ({
    t: s.time,
    enemyKey: s.enemyKey,
    count: s.count,
    gate: s.preview?.gate ?? null,
    elite: !!s.preview?.elite,
    boss: !!s.preview?.boss,
    tag: s.tag ?? null,
  }));
}

function scheduleBrief(m) {
  const sc = m.factions && m.factions.schedule;
  if (!sc || typeof sc !== 'object') return null;
  return { typeSlots: jsonSafe(sc.typeSlots ?? null), picks: jsonSafe(sc.picks ?? null) };
}

/** A small readable summary of a seat, for the log. */
function fingerprint(ps) {
  const shop = Array.isArray(ps.shop?.slots)
    ? ps.shop.slots.map((s) => (s ? `${s.id}${s.sold ? '!' : ''}` : '-')).join(',')
    : '';
  return {
    funds: ps.funds,
    level: ps.shop?.level ?? null,
    lp: ps.lp,
    handN: ps.hand ? ps.hand.filter(Boolean).length : 0,
    boardN: ps.deployCount ?? 0,
    shop,
  };
}

/**
 * The full player-visible state as one string: hand (uid+id), board (tile+uid+id+facing+items), shop, funds, level,
 * LP, ready, frozen, band. Two equal hashes ⇒ the action changed nothing the player can feel — the `noop` verdict
 * (a light fingerprint is not enough: a `move` to another tile, an `equip`, a `setReady` all leave counts unchanged).
 */
function stateHash(ps) {
  try {
    const hand = (ps.hand || []).map((p) => (p ? `${p.uid}:${p.id}` : '-')).join(',');
    const board = [...(ps.board?.entries?.() || [])]
      .map(([k, p]) => `${k}:${p.uid}:${p.id}:${p.dir ?? ''}:${(p.items || []).map((i) => i.uid).join('+')}`)
      .sort()
      .join(',');
    const shop = Array.isArray(ps.shop?.slots)
      ? ps.shop.slots.map((s) => (s ? `${s.id}${s.sold ? '!' : ''}` : '-')).join(',')
      : '';
    return [ps.funds, ps.shop?.level, ps.lp, ps.ready ? 1 : 0, ps.shop?.frozen ? 1 : 0, ps.bandId ?? '', hand, board, shop].join('|');
  } catch {
    return null;
  }
}

function safeView(ps) {
  try { return ps.privateView(); } catch { return null; }
}

/** JSON-safe copy for the log; anything unserializable degrades to a string, never throws. */
function jsonSafe(v) {
  try {
    JSON.stringify(v);
    return v;
  } catch {
    try { return String(v); } catch { return null; }
  }
}

function nowIso() {
  return new Date().toISOString();
}

/** The raw human intents (thin): covers intents with no PlayerState verb, plus validation/quota rejects. */
function recordIntent(state, log, match, playerId, msg, res) {
  if (!state.record) return;
  if (!msg || typeof msg.t !== 'string' || !msg.t.startsWith('g.')) return;
  const ps = match.players?.get(playerId);
  if (!ps || ps.isBot) return; // bots never go through handle; only humans are logged here
  const { t, ...payload } = msg;
  const ev = {
    k: 'intent',
    t: nowIso(),
    round: match.round ?? null,
    phase: match.phase ?? null,
    seat: playerId,
    type: t,
    msg: jsonSafe(payload),
    ok: !(res && res.error),
  };
  if (res && res.error) { ev.err = res.error; if (res.detail) ev.detail = res.detail; }
  emitEvent(state, log, ev);
}

/** One line per auto batch: what the loop was asked for and what it got done (never the individual cycles). */
function autoEvent(ps, a) {
  return {
    k: 'auto',
    t: nowIso(),
    round: ps?.m?.round ?? null,
    seat: ps?.playerId ?? null,
    cardIds: a.cardIds,
    cycles: a.cycles,
    equipCoins: !!a.equipCoins,
    idCard: !!a.idCard,
    bought: a.bought,
    done: a.done,
    gold: a.gold,
    layers: a.layers,
    stop: a.stop,
  };
}

function emitEvent(state, log, ev) {
  if (!state.record || !state.logFile) return;
  let line;
  try {
    line = JSON.stringify(ev);
  } catch (e) {
    line = JSON.stringify({ k: (ev && ev.k) || 'event', t: nowIso(), stringifyError: String(e?.message || e) });
  }
  try {
    fs.appendFileSync(state.logFile, `${line}\n`);
  } catch (e) {
    log.warn('record write failed', e?.message || e);
  }
}

function openLog(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  return path.join(dir, `session-${stamp}.jsonl`);
}
