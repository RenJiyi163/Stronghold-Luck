// overlay.js — the pick-your-own shop panel (browser half of Stronghold-Luck).
//
// Loaded by the launcher's front server, which appends one <link> + one <script> to the game's index.html. Nothing of
// the game's own client code is replaced: this module imports the game's own singletons (the same module instances the
// app is running on) and drives them.
//
//   * it registers `g.modPick` / `g.modBuy` / `g.modConfig` in the shared C2S table so the app's validator accepts them;
//   * it reads the match state from the game's store (`match.private`) and sends intents over the game's socket;
//   * `private.shop.modPickable` is written by the server patch — its absence means the server is NOT modded, and the
//     whole panel stays hidden (so this file is inert against a vanilla `npm start`).
//
// Three actions, all server-checked: fill a shop slot with a chosen unit (放入槽位), buy a unit straight into the hand
// (直购), and set the per-round budget the first two share.

import { C2S, loadoutOptions } from '/shared/protocol.js';
import { ERR_TEXT } from '/shared/constants.js';
import { store } from '/js/store.js';
import { net } from '/js/net.js';
import { data } from '/js/data.js';
import { chessPortraitUrl, itemIconUrl } from '/js/ui/assetUrls.js';
import { mergeProgress, ownDiyRecord } from '/js/ui/gameLogic.js';
import { PROF_NAME } from '/js/ui/loadoutModel.js';
import { AUTO_CARDS, AUTO_CLASS_HINT, AUTO_CLASS_LABEL, AUTO_DEFAULT_IDS } from './auto-rules.js';
import { createUnitPatcher, MULT_FIELDS, normalizeUnitCfg, SCOPE_LABEL, UNIT_FIELDS, UNIT_SCOPES, unitCovers } from './unit-rules.js';
import {
  createSlotPatcher, extraDiyData, extraDiyTable, extraSlotId, EXTRA_TIERS, isExtraSlotId, MAX_EXTRA_SLOTS,
  normalizeSlotCfg, patchContentSeam, patchGameData, slotBaseId,
} from './slot-rules.js';

const PICK = 'g.modPick';
const BUY = 'g.modBuy';
const CONFIG = 'g.modConfig';
const SPEED = 'g.modSpeed';
const BANDS = 'g.modBands';
const PLACE = 'g.modPlace';
const UNIT = 'g.modUnit';
const SHOPFILTER = 'g.modShopFilter';
const DIY = 'g.modDiy';
const isId = (v) => typeof v === 'string' && v.length > 0 && v.length <= 64;
const isLimit = (v) => Number.isInteger(v) && v >= 0 && v <= 99;
const isSpeed = (v) => Number.isInteger(v) && v >= 1 && v <= 16;
const isIds = (v) => Array.isArray(v) && v.every(isId);
/** 阵营锁 readings: 'has' = 带所选里任意一条即留（并集）, 'only' = 干员的盟约全落在所选内才留（子集）。 */
const isFilterMode = (v) => v === 'has' || v === 'only';
const isCap = (v) => v === null || (Number.isInteger(v) && v >= 0 && v <= 99);
/** the whole unit config rides in one field; the server clamps it, this only has to look like the shape */
const isUnitCfg = (v) => v === null || (typeof v === 'object' && !Array.isArray(v) && typeof v.on === 'boolean' && UNIT_SCOPES.includes(v.scope));
if (!Object.hasOwn(C2S, PICK)) C2S[PICK] = { slot: (v) => Number.isInteger(v) && v >= 0 && v <= 15, id: isId };
if (!Object.hasOwn(C2S, BUY)) C2S[BUY] = { id: isId };
if (!Object.hasOwn(C2S, CONFIG)) C2S[CONFIG] = { pickLimit: isLimit };
if (!Object.hasOwn(C2S, SPEED)) C2S[SPEED] = { n: isSpeed };
if (!Object.hasOwn(C2S, BANDS)) C2S[BANDS] = { ids: isIds };
if (!Object.hasOwn(C2S, PLACE)) C2S[PLACE] = { on: (v) => typeof v === 'boolean', cap: isCap };
if (!Object.hasOwn(C2S, UNIT)) C2S[UNIT] = { cfg: isUnitCfg };
if (!Object.hasOwn(C2S, SHOPFILTER)) C2S[SHOPFILTER] = { on: (v) => typeof v === 'boolean', bonds: isIds, mode: isFilterMode };
// the 自选位 kit: the whole per-slot map rides in one field; the server normalizes (validates ids, clamps numbers)
const isDiySlots = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
  && Object.keys(v).length <= 64 && Object.values(v).every((s) => s === null || (!!s && typeof s === 'object' && !Array.isArray(s)));
const isDiyExtra = (e) => !!e && typeof e === 'object' && !Array.isArray(e)
  && Number.isInteger(e.k) && typeof e.tier === 'number'
  && (!e.pick || (typeof e.pick === 'object' && typeof e.pick.charId === 'string' && e.pick.charId.length > 0));
if (!Object.hasOwn(C2S, DIY)) C2S[DIY] = { slots: isDiySlots, extra: (v) => v == null || (Array.isArray(v) && v.every(isDiyExtra)) };

// The server refuses an over-budget action with its own code (MOD_LIMIT). That code is not in the frozen ERR table, so
// the wire frame carries it as code INTERNAL with our text in `detail` (server/net.js errorMsg); read `detail` first.
const errText = (e) => (typeof e?.detail === 'string' && e.detail) || ERR_TEXT?.[e?.code] || e?.message || '操作失败';

void data.load('chess');
void data.load('items');
void data.load('assets');
void data.load('backups'); // 自选编队 pieces are composed from chess.json + backups.json (ui/gameLogic/diy.js)
void data.load('bands');   // the sandbox page lists 策略 by name (bands.json)
void data.load('stages');  // and the deploy unlock has to widen this browser's own copy of the stage legends
void data.load('tokens');  // 战术锚点 summons are ranged-only by default; the unlock clears that too
void data.load('bonds');     // the 自选位 page names 盟约 by their display name
void data.load('garrisons'); // and 特质 (data/garrisons.json) by theirs

const local = {
  open: false, tab: 0, query: '', prof: '', mode: 'slot', limit: null, speed: null, view: 'name', size: null,
  page: 'shop', // 'shop' | 'sandbox'
  sb: { bands: [], pool: [], place: false, cap: null, filter: '' },
  // the unit rules (技能 / 技力 / 属性): the config, plus the operator list's own search box. 启用 defaults ON — every field
  // starts empty, and an empty config is a no-op on both sides (unit-rules.js unitHasEffect), so the panel never sits in a
  // "filled in but doing nothing" state. 清除 / 未启用 is how it gets turned off.
  unit: { on: true, pin: true, scope: 'one', id: null, skill: null, spCost: null, initSp: null, mult: 1, stats: {}, query: '' },
  // the 阵营锁: the chosen bonds (multi-select, as before) plus the reading that joins them — 'has' = 带所选里任意一条
  // 即留（并集）, 'only' = 干员的盟约全落在所选内才留（子集）. Kept per browser like the rest; pushed once a match is
  // under way (`ps.modShopFilter` is per-seat and resets with every match, so the push is per match).
  filter: { on: false, bonds: [], mode: 'only' },
  // the 自选位 kit: per slot base id, the 盟约 it carries (`bonds` = replace, null = keep the operator's own) and the 特质
  // it bears. Kept per browser; pushed once a match is under way (the server holds it process-wide).
  // `extra` = the mod's own slots (更多位子): `{ k, tier, charId, skillIndex, uniEquipId }`, k from 1 and unique.
  diy: {
    slots: {}, extra: [], open: null, query: '', numberFor: null, pickFor: null, pickQuery: '',
    // the skill each slot's piece carries, `{ [slotBaseId]: index }`; a slot with no entry keeps what it was composed
    // with (the game's own 自选编队 pick, which already defaults to the LAST skill)
    skills: {},
    // and the 模组: `{ [slotBaseId]: uniEquipId | null }` (null = 不带模组). Absent = keep the composed one.
    mods: {},
    // 「新位子默认」: what a freshly added 自造位子 starts with, and what 「用默认」 tops a slot up with. The 盟约 are
    // seeded with 调和 (a member of it enjoys every core 盟约 while it is active, the cheapest way to make a 自选 piece
    // core); the 特质 start empty — the author picks his own.
    defaultBonds: ['maniShip'],
    defaultGarrisons: [],
  },
};
let flashTimer = null;
/** the last rendered budget: lets a card click decide without a round-trip */
let curQuota = { unlimited: true, left: Infinity, used: 0, limit: 0 };

// ---- tiny DOM helpers ---------------------------------------------------------------------------------

function el(tag, props = null, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2).toLowerCase(), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.append(typeof kid === 'string' || typeof kid === 'number' ? String(kid) : kid);
  }
  return n;
}

const clear = (n) => { while (n.firstChild) n.removeChild(n.firstChild); return n; };

// ---- the master switches: one place that answers "is this group on" ----------------------------------
//
// The SERVER is what acts on the switches (it refuses that group's intents and takes back what is already in effect).
// The panel has to follow it, or a switched-off group lingers: the 自造位子 are composed HERE from `local.diy.extra` and
// injected into the game's own 自选编队 screen, so without this a switch that is off still draws the slots the server
// already rolled back — visible, but refusing every pick.
//
// A group reads as on only when BOTH sides say so: the panel's own switch (`local.enable`, the 总开关 page's memory,
// which loads further down — before then everything is on, the server's own default) and the server's echo
// (`view.modEnable`, so a reload or a second tab shows what the server actually honours). Either one saying off hides
// the group at once, which is the point.
function enableOn(k) {
  const mem = local.enable;
  if (mem && mem[k] === false) return false;
  const s = store.get()?.match?.private?.modEnable;
  if (s && s[k] === false) return false;
  return true;
}

/** Where a switched-off group's controls would be: a line saying why they are gone. */
const offNote = (label) => el('div', { class: 'spmod-sbsection spmod-offnote' },
  el('span', { class: 'spmod-hint' }, `「${label}」已被总开关关掉，这一组整个不生效；到「开关」页把它打开。`));

/** Show or hide a draggable bar; a bar that becomes visible is first pulled back inside the window. */
function showBar(bar, show) {
  bar.hidden = !show;
  if (show) clampBar(bar, bar.__clampKey || null);
  return show;
}

// ---- shell --------------------------------------------------------------------------------------------

const root = el('div', { class: 'spmod', hidden: true });
const fab = el('button', { class: 'spmod-fab', type: 'button', title: '自选商店' }, '自选');
const panel = el('div', { class: 'spmod-panel', role: 'dialog', 'aria-label': '自选商店' });
const grip = el('div', { class: 'spmod-grip', title: '拖动改变面板大小（按浏览器记住）' });
root.append(fab, panel);
document.body.append(root);

// the entry point is draggable (the game's own chrome owns every edge); a plain click opens the panel
const FAB_POS_KEY = 'spmod.fabPos';
const LIMIT_KEY = 'spmod.pickLimit';
let justDragged = false;
try {
  const p = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
  if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
    fab.style.left = `${p.x}px`;
    fab.style.top = `${p.y}px`;
    fab.style.right = 'auto';
  }
} catch { /* ignore */ }
try {
  const n = Number(localStorage.getItem(LIMIT_KEY));
  if (isLimit(n)) local.limit = n;
} catch { /* ignore */ }

fab.__clampKey = FAB_POS_KEY;
window.addEventListener('resize', () => clampBar(fab, FAB_POS_KEY));

let drag = null;
fab.addEventListener('pointerdown', (e) => {
  const r = fab.getBoundingClientRect();
  drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, x: r.left, y: r.top, moved: false };
  try { fab.setPointerCapture(e.pointerId); } catch { /* ignore */ }
});
fab.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const x = Math.max(0, Math.min(window.innerWidth - fab.offsetWidth, e.clientX - drag.dx));
  const y = Math.max(0, Math.min(window.innerHeight - fab.offsetHeight, e.clientY - drag.dy));
  if (Math.abs(x - drag.x) > 3 || Math.abs(y - drag.y) > 3) drag.moved = true;
  drag.x = x;
  drag.y = y;
  fab.style.left = `${x}px`;
  fab.style.top = `${y}px`;
  fab.style.right = 'auto';
});
fab.addEventListener('pointerup', (e) => {
  const d = drag;
  drag = null;
  if (!d) return;
  try { fab.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  if (d.moved) {
    justDragged = true;
    try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ x: Math.round(d.x), y: Math.round(d.y) })); } catch { /* ignore */ }
  }
});
fab.addEventListener('click', () => {
  if (justDragged) { justDragged = false; return; }
  setOpen(!local.open);
});
root.addEventListener('click', (e) => { if (e.target === root && local.open) setOpen(false); });

function setOpen(open) {
  local.open = open;
  root.classList.toggle('is-open', open);
  if (open) render(true);
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && local.open) { setOpen(false); e.stopPropagation(); }
});

// ---- the panel's size and its card style (both kept per browser) ---------------------------------------
//
// The panel used to be one fixed box: about four rows of small portraits, cropped to a band of forehead. It is the
// player's box now — a preset, a corner grip, or a preset then nudged — and each card is either its portrait (in the
// art's own 1:2 shape, nothing cut off) or one plain row with the operator's name, which is what you want when the
// list is long.

const SIZE_KEY = 'spmod.size';
const VIEW_KEY = 'spmod.view';
/** presets in rem (1rem = the game's 100 design px, scaled with the viewport); null = fill the window */
const SIZE_PRESETS = [['小', 8.6, 5.4], ['中', 10.4, 7.6], ['大', 13.4, 9.6], ['满', null, null]];
const MIN_W = 5.4;
const MIN_H = 3.4;
/** the game's root font-size: rem → px, so a dragged size is stored in real pixels */
const remPx = () => parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;

// The panel was sized for a desktop: on a phone everything in it came out at ~40% of the size it was drawn at, and
// the rows and chips were too small to hit with a finger. Two different things are at work, so two different fixes:
//
//   * the TEXT rides the game's own text root (--t, 设置 →「文字大小」) and never drops below its 大 step (76px), which is
//     css/overlay.css, nothing to do here;
//   * the LAYOUT (paddings, min-widths, grid columns) stays on the layout root, which the game clamps at 40px on a
//     phone, so it needs a hand-written larger set.
//
// This puts `spmod-touch` on <html> where that set applies: a coarse pointer, or a layout root small enough that the
// panel's own 14-design-px text would land under ~9px (under ~1230×690 CSS px). Kept current as the window changes.
const coarsePointer = () => {
  try { return !!(matchMedia?.('(pointer: coarse)')?.matches || matchMedia?.('(any-pointer: coarse)')?.matches); }
  catch { return false; }
};
// The layout root is clamp(40px, min(100vw/19.2, 100vh/10.8), 240px), so "the root is small" is exactly a viewport
// condition: it is below 64px once the window is under 1229×692. Watched as media queries rather than off a `resize`
// event, because a query's change event fires on the condition itself — a plain window resize does not always reach
// the handler (the same emulated resize that moves the root font can land before the new value is readable).
const SMALL_W = matchMedia('(max-width: 1229px)');
const SMALL_H = matchMedia('(max-height: 692px)');
const COARSE = matchMedia('(pointer: coarse)');
const ANY_COARSE = matchMedia('(any-pointer: coarse)');
function applyTouchLayout() {
  const el = document?.documentElement;
  if (!el) return;
  const small = SMALL_W.matches || SMALL_H.matches || remPx() < 64;
  try { el.classList.toggle('spmod-touch', small || coarsePointer()); } catch { /* ignore */ }
  applySize(); // a stored size is pixels for the window it was chosen in, so every re-layout re-fits it (see fitSize)
}
for (const mq of [SMALL_W, SMALL_H, COARSE, ANY_COARSE]) {
  if (typeof mq.addEventListener === 'function') mq.addEventListener('change', applyTouchLayout);
  else if (typeof mq.addListener === 'function') mq.addListener(applyTouchLayout);   // Safari < 14
}
applyTouchLayout();
addEventListener('resize', applyTouchLayout, { passive: true });
// the game re-lays-out a beat after a rotation settles (device.js); this rides along with it
addEventListener('orientationchange', () => { applyTouchLayout(); setTimeout(applyTouchLayout, 400); });

function loadPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(SIZE_KEY) || 'null');
    if (s && Number.isFinite(s.w) && Number.isFinite(s.h)) local.size = { w: s.w, h: s.h };
  } catch { /* ignore */ }
  try {
    const v = localStorage.getItem(VIEW_KEY);
    if (v === 'art' || v === 'name') local.view = v;
  } catch { /* ignore */ }
}
loadPrefs();

/** The largest box the window allows right now. The 满 preset is exactly this, so it doubles as the clamp. */
function sizeLimits() {
  const r = remPx();
  return {
    minW: MIN_W * r,
    minH: MIN_H * r,
    maxW: Math.max(MIN_W * r, window.innerWidth * 0.96),
    maxH: Math.max(MIN_H * r, window.innerHeight * 0.94),
  };
}

/** Fit a wanted size into what the window allows; `Infinity` means "as big as it goes" (the 满 preset). */
function fitSize(w, h) {
  const L = sizeLimits();
  return {
    w: Math.max(L.minW, Math.min(L.maxW, w)),
    h: Math.max(L.minH, Math.min(L.maxH, h)),
  };
}

/**
 * Push the current size onto the panel (px when the player chose one, the CSS rem default otherwise).
 *
 * A stored size is a pair of pixels for the window it was chosen in, so it is fitted on the way out: a box picked on a
 * desktop (满 is 96% of *that* viewport) would otherwise hang off a phone, its header and footer cut off by the
 * centring transform. Same idea as clampBar for the floating bars. The stored value is left as it was, so the desktop
 * box is still there when the window grows back.
 */
function applySize() {
  panel.classList.toggle('is-sized', !!local.size); // is-sized pins the height; without it the panel hugs its content
  if (!local.size) {
    panel.style.removeProperty('--spmod-w');
    panel.style.removeProperty('--spmod-h');
    return;
  }
  const s = fitSize(local.size.w, local.size.h);
  panel.style.setProperty('--spmod-w', `${Math.round(s.w)}px`);
  panel.style.setProperty('--spmod-h', `${Math.round(s.h)}px`);
}

function saveSize() {
  try { localStorage.setItem(SIZE_KEY, JSON.stringify(local.size)); } catch { /* ignore */ }
}

/** Which preset the current size is (for marking the buttons); -1 = dragged to something of its own. */
function presetOf() {
  if (!local.size) return 1; // the CSS default is the 中 box
  const r = remPx();
  return SIZE_PRESETS.findIndex(([, w, h]) => w != null && Math.abs(local.size.w - w * r) < 2 && Math.abs(local.size.h - h * r) < 2);
}

function setSize(wRem, hRem) {
  const r = remPx();
  local.size = fitSize(wRem == null ? Infinity : wRem * r, hRem == null ? Infinity : hRem * r);
  saveSize();
  applySize();
  render(true);
}

let sizeDrag = null;
grip.addEventListener('pointerdown', (e) => {
  const r = panel.getBoundingClientRect();
  sizeDrag = { x: e.clientX, y: e.clientY, w: r.width, h: r.height };
  try { grip.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  e.preventDefault();
  e.stopPropagation();
});
grip.addEventListener('pointermove', (e) => {
  if (!sizeDrag) return;
  local.size = fitSize(sizeDrag.w + (e.clientX - sizeDrag.x), sizeDrag.h + (e.clientY - sizeDrag.y));
  applySize();
});
grip.addEventListener('pointerup', (e) => {
  if (!sizeDrag) return;
  sizeDrag = null;
  try { grip.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
  saveSize();
  render(true);
});
applySize();

function setView(v) {
  local.view = v === 'art' ? 'art' : 'name';
  try { localStorage.setItem(VIEW_KEY, local.view); } catch { /* ignore */ }
  render(true);
}

/**
 * Put every draggable back at its default spot. A stored position is a pair of pixels for the window it was dragged
 * in, so a bar can end up parked outside the viewport; the clamp heals that on its own, and this is the manual way
 * back for the entry button and any other case (a second screen, a projector, whatever the window became).
 */
function resetPositions() {
  for (const [node, key] of [[fab, FAB_POS_KEY], [speedBar, 'spmod.speedPos'], [autoBar, 'spmod.autoPos'], [sbBar, 'spmod.sandboxPos']]) {
    try { localStorage.removeItem(key); } catch { /* ignore */ }
    node.style.removeProperty('left');
    node.style.removeProperty('top');
    node.style.removeProperty('right');
  }
  render(true);
}

// ---- the sandbox: extra 策略 + the deploy unlock ---------------------------------------------------------
//
// The player's box of toys, and it is meant to be overdone: "我可以不用，但我不能没有". Two halves, both kept per
// browser and pushed to the server once a match is under way (the same idiom the pick limit and the speed use) —
// 「钉住」 just means the values survive into the next match.
//
//   * 策略. The game drafts ONE strategy per seat and every effect reads that single `ps.bandId`. Extra ids ride on
//     `ps.modBands` and the server runs each one's own handler too; the starting LP takes the biggest of the picks.
//   * 地块. The server widens the deploy map; the browser has its own copy of stages.json, so it has to widen that
//     too or the drag would refuse tiles the server would take. The browser's rule is the same one: every tile whose
//     legend says it cannot be built on becomes buildable (high ground as ranged-only), `deployTiles` is dropped so
//     the UI falls back to the legend, and tiles a device took away are left alone.

const SB_KEY = 'spmod.sandbox';
const DEPLOY_UNLOCK = '__luckDeployUnlock';

function loadSandboxPrefs() {
  try {
    const s = JSON.parse(localStorage.getItem(SB_KEY) || 'null');
    if (!s || typeof s !== 'object') return;
    if (Array.isArray(s.bands)) local.sb.bands = s.bands.filter((x) => typeof x === 'string');
    local.sb.place = !!s.place;
    local.sb.cap = Number.isInteger(s.cap) && s.cap >= 0 && s.cap <= 99 ? s.cap : null;
  } catch { /* ignore */ }
}
loadSandboxPrefs();

function saveSandboxPrefs() {
  try {
    localStorage.setItem(SB_KEY, JSON.stringify({ bands: local.sb.bands, place: local.sb.place, cap: local.sb.cap }));
  } catch { /* ignore */ }
}

/**
 * Widen (or restore) this browser's own copy of every stage, so the drag mirror agrees with the server.
 *
 * Two things, because the client's own mirror decides what the drag is allowed to drop on:
 *   1. the tile legend — every glyph becomes buildable and LOW, so the derived deploy set holds EVERY tile of the own
 *      board as 'melee' (any unit). `height` is what the server keeps out of it, but the client only uses it for the
 *      tile tooltip and the fallback renderer, and leaving it HIGH would keep 高台 tiles ranged-only — which is exactly
 *      the rule the author wants gone (the game's own version of it is a per-chess trait, not a tile property, so the
 *      tile model cannot express it; see the server's `_placementOf` patch for that half);
 *   2. `rangedTilesOnly` on the summon records — those tokens are the only pieces the client can still call 'HIGH',
 *      and 'HIGH' needs a ranged-ONLY tile, which no longer exists.
 */
function applyDeployUnlock(on) {
  for (const st of data.list('stages')) {
    if (!st || typeof st !== 'object') continue;
    if (on) {
      if (!st[DEPLOY_UNLOCK]) st[DEPLOY_UNLOCK] = { tiles: st.tiles, deployTiles: st.deployTiles };
      const legend = st[DEPLOY_UNLOCK].tiles;
      if (legend && typeof legend === 'object') {
        const next = {};
        for (const [g, t] of Object.entries(legend)) {
          next[g] = t && typeof t === 'object' && (t.buildable !== 'ALL' || t.height !== 'LOW')
            ? { ...t, buildable: 'ALL', height: 'LOW' }
            : t;
        }
        st.tiles = next;
      }
      st.deployTiles = null; // deploySets then derives from the legend instead of the prebuilt list
    } else if (st[DEPLOY_UNLOCK]) {
      st.tiles = st[DEPLOY_UNLOCK].tiles;
      st.deployTiles = st[DEPLOY_UNLOCK].deployTiles;
      delete st[DEPLOY_UNLOCK];
    }
  }
  for (const t of data.list('tokens')) {
    if (!t || typeof t !== 'object') continue;
    if (on) {
      if (!t[DEPLOY_UNLOCK]) t[DEPLOY_UNLOCK] = { rangedTilesOnly: t.rangedTilesOnly };
      if (t.rangedTilesOnly === true) t.rangedTilesOnly = false;
    } else if (t[DEPLOY_UNLOCK]) {
      t.rangedTilesOnly = t[DEPLOY_UNLOCK].rangedTilesOnly;
      delete t[DEPLOY_UNLOCK];
    }
  }
}

function sendBands() {
  const pool = new Set(local.sb.pool || []);
  const ids = local.sb.bands.filter((id) => pool.size === 0 || pool.has(id));
  net.request(BANDS, { ids }).catch((e) => console.warn('[luck] bands refused', errText(e)));
}

function sendPlace() {
  net.request(PLACE, { on: local.sb.place, cap: local.sb.cap }).catch((e) => console.warn('[luck] deploy unlock refused', errText(e)));
}

/** Toggle a strategy on/off and push the set. `data.list('bands')` names them; the server drops anything unknown. */
function toggleBand(id) {
  const i = local.sb.bands.indexOf(id);
  if (i >= 0) local.sb.bands.splice(i, 1);
  else local.sb.bands.push(id);
  saveSandboxPrefs();
  sendBands();
  render(true);
}

let sbPushedFor = null;
/** Adopt the server's state (it is the truth for the switch), then apply the unlock to this browser's stages. */
function renderSandbox() {
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  const sb = priv?.modSandbox;
  const modded = !!priv?.shop?.modPickable || Number.isFinite(Number(priv?.modSpeed));
  const show = !!sb && modded && !!pub && pub.phase !== 'LOBBY';
  if (!showBar(sbBar, show)) return;
  local.sb.pool = Array.isArray(sb.pool) ? sb.pool : [];
  const serverBands = Array.isArray(sb.bands) ? sb.bands : [];
  const place = !!sb.place;
  const cap = sb.cap ?? null;
  if (place !== local.sb.place) { local.sb.place = place; applyDeployUnlock(place); lastSig = null; }
  local.sb.cap = cap;
  if (sbPlace.checked !== place) sbPlace.checked = place;
  sbCount.textContent = serverBands.length ? `策略 +${serverBands.length}` : '';
  sbCount.title = serverBands.map((id) => data.lookup('bands', id)?.name || id).join('、');
  // 「钉住」: the remembered set goes out once per match, and only with ids this match actually allows
  const ids = JSON.stringify(serverBands);
  const mine = JSON.stringify(local.sb.bands.filter((id) => local.sb.pool.includes(id)));
  const key = `${st?.public?.stageId || ''}|${st?.public?.modeId || ''}`;
  if (sbPushedFor !== key) {
    sbPushedFor = key;
    if (mine !== ids && mine !== '[]') sendBands();
  }
}

/** A strategy's display line: 名字 · 初始 LP · 效果名. */
function bandLabel(id) {
  const b = data.lookup('bands', id);
  if (!b) return id;
  const lp = Number.isFinite(Number(b.totalHp)) ? ` · LP ${b.totalHp}` : '';
  return `${b.name || id}${lp}${b.effectName ? ` · ${b.effectName}` : ''}`;
}

// ---- the unit rules: 技能 / 技力 / 属性 ---------------------------------------------------------------------
//
// One operator's kit, edited by hand: which skill it carries, what that skill costs, and any stat of its body. The config
// is kept per browser and pushed once a match is under way (the same idiom the pick limit and the sandbox use); 钉住 is
// what makes it follow into the NEXT match.
//
// Where each half lands (see unit-rules.js and the server patch's long note): 属性 and 技力 go to BOTH processes' sims —
// the battle spec carries no stats, so each side resolves them from its own chess.json and both have to be told. 换技能
// rides on the spec's `skillIndex`, which the server writes, so it needs no browser half at all.
//
// 作用目标: 这一名 / 我的全部 are this tab's own field (the player's battle is simulated HERE — the server only runs the
// AI seats' fields, so it is deliberately left alone for those two); 全场 additionally patches the server, which is
// process-wide and therefore reaches every seat's field, the AI teammates included. 换技能 is 这一名-only: every operator
// has its own skill table, so "all of mine" has nothing to carry.

const UNIT_KEY = 'spmod.units';
/** The tab's own patcher — shared by the panel (which sets the config) and the sim wrappers below (which read it). */
const unitPatcher = createUnitPatcher();

function loadUnitPrefs() {
  try {
    const saved = normalizeUnitCfg(JSON.parse(localStorage.getItem(UNIT_KEY) || 'null'));
    if (saved) local.unit = { ...saved, query: '' };
  } catch { /* ignore */ }
}
loadUnitPrefs();

function saveUnitPrefs() {
  try {
    const { query: _q, ...rest } = local.unit;
    localStorage.setItem(UNIT_KEY, JSON.stringify(rest));
  } catch { /* ignore */ }
}

/** Adopt the config into this tab's sim (the browser half; the server half goes out with sendUnits). */
function applyUnitCfg() {
  unitPatcher.set(enableOn('sandboxUnit') && local.unit.on ? normalizeUnitCfg(local.unit) : null);
}

function sendUnits() {
  applyUnitCfg();
  net.request(UNIT, { cfg: normalizeUnitCfg(local.unit) }).catch((e) => console.warn('[luck] unit cfg refused', errText(e)));
}

/** Every operator the picker may name: the whole chess table. 自选 slots are skipped (they have no body of their own) and
 *  so is the 精锐 record of a pair — it carries the same name as its base, and the rules here already treat the two as
 *  one operator (unit-rules.js baseChessId), so listing both would just double every name. */
function unitCandidates() {
  const out = [];
  for (const c of data.list('chess')) {
    const id = c?.chessId || c?.id;
    if (!c || c.isDiy || c.isGolden || !id) continue;
    out.push({ id, rec: c });
  }
  out.sort((a, b) => ((a.rec.tier ?? 9) - (b.rec.tier ?? 9)) || String(a.rec.name || '').localeCompare(String(b.rec.name || ''), 'zh'));
  return out;
}

/** The skills the selected operator may actually carry: the same set the 干员调配 screen offers (shared/protocol.js
 *  loadoutOptions — the normal and the elite record have to agree on the index, and the sim re-checks it on the way in). */
function skillChoices(id) {
  const rec = id ? data.lookup('chess', id) : null;
  if (!rec) return [];
  const golden = rec.goldenId ? data.lookup('chess', rec.goldenId) : null;
  const opt = loadoutOptions(rec, golden);
  const names = new Map();
  for (const r of [rec, golden]) for (const s of (Array.isArray(r?.skills) ? r.skills : [])) if (!names.has(s.index)) names.set(s.index, s.name);
  return (opt.skills || []).map((i) => ({ index: i, name: names.get(i) || `技能 ${i + 1}`, isDefault: i === opt.defaultSkill }));
}

/** One number box. Empty = 不改 (null). `field` is a data hook for the self-check (and any future scripting). */
function unitNum(value, onChange, title = '', field = '') {
  return el('input', {
    class: 'spmod-limit', type: 'number', step: 'any', min: '0', 'data-field': field || null,
    value: value == null ? '' : String(value), title: title || undefined,
    onChange: (e) => {
      const raw = e.currentTarget.value.trim();
      const n = raw === '' ? null : Number(raw);
      const v = raw === '' || !Number.isFinite(n) ? null : Math.max(0, n);
      e.currentTarget.value = v == null ? '' : String(v);
      onChange(v);
    },
  });
}

/** Rewrite one field of the config and push the whole thing (the server clamps; nothing here is billed to the budget). */
function editUnit(patch) {
  Object.assign(local.unit, patch);
  saveUnitPrefs();
  sendUnits();
  render(true);
}

function drawUnitsSection() {
  const u = local.unit;
  const on = !!u.on;

  const scopeSeg = el('div', { class: 'spmod-seg' }, ...UNIT_SCOPES.map((s) => el('button', {
    class: ['spmod-segbtn', u.scope === s && 'is-on'].filter(Boolean).join(' '),
    type: 'button',
    title: s === 'one' ? '只改选中的这一名（也能换它的携带技能）'
      : s === 'mine' ? '改我场上每一名干员（技能那一栏对多名没有意义，会置灰）'
        : '连三个 AI 队友的场次一起改（服务端也打补丁）',
    onClick: () => editUnit({ scope: s }),
  }, SCOPE_LABEL[s])));

  const head = el('div', { class: 'spmod-sbrow' },
    el('div', { class: 'spmod-seg' },
      el('button', {
        class: ['spmod-segbtn', on && 'is-on'].filter(Boolean).join(' '), type: 'button',
        title: '开/关这一整套改动（关掉 = 还原成原版数值）',
        onClick: () => editUnit({ on: !on }),
      }, on ? '已启用' : '未启用'),
    ),
    el('span', { class: 'spmod-hint' }, '作用目标'),
    scopeSeg,
    el('label', { class: 'spmod-sbchk' },
      el('input', { type: 'checkbox', checked: u.pin ? '' : null, onChange: (e) => editUnit({ pin: e.currentTarget.checked }) }, null),
      '钉住'),
  );

  const kids = [head];

  if (u.scope === 'one') {
    const q = (u.query || '').trim().toLowerCase();
    const list = unitCandidates().filter(({ rec }) => !q
      || String(rec.name || '').toLowerCase().includes(q)
      || String(rec.appellation || '').toLowerCase().includes(q));
    const grid = el('div', { class: 'spmod-units' }, ...list.slice(0, 400).map(({ id, rec }) => el('button', {
      class: ['spmod-unit', u.id === id && 'is-on'].filter(Boolean).join(' '),
      type: 'button', 'data-unit': id,
      title: `${rec.name || id} · ${rec.tier ?? '?'} 阶${rec.subProfessionName ? ` · ${rec.subProfessionName}` : ''}`,
      onClick: () => editUnit({ id, skill: null }),
    },
      el('span', { class: 'spmod-unitname' }, rec.name || id),
      el('i', { class: 'spmod-unittier' }, String(rec.tier ?? '?')),
    )));
    kids.push(el('div', { class: 'spmod-sbsub' },
      el('input', {
        class: 'spmod-search', type: 'search', placeholder: '搜索干员…', value: u.query || '', autocomplete: 'off',
        onInput: (e) => { local.unit.query = e.currentTarget.value; render(true); },
      }),
      grid,
      el('span', { class: 'spmod-hint' }, list.length > 400 ? `列出前 400 名（共 ${list.length}）—— 用搜索缩小范围` : ''),
    ));

    // 换技能: only the indexes this record really offers. A skill without a hand-written kit falls back to the generic
    // one (content/index.js selectSkillSpec) — legal, just bland, so it is a note rather than a refusal.
    const skills = skillChoices(u.id);
    const sel = el('select', {
      class: 'spmod-prof', disabled: skills.length ? null : true,
      title: '换成这一名干员的其它携带技能（只能换它自己有的）',
      onChange: (e) => {
        const v = e.currentTarget.value;
        editUnit({ skill: v === '' ? null : Number(v) });
      },
    },
      el('option', { value: '' }, u.id ? '保持原样' : '先选一名干员'),
      ...skills.map((s) => el('option', { value: String(s.index), selected: u.skill === s.index }, `S${s.index + 1} ${s.name}${s.isDefault ? '（默认）' : ''}`)),
    );
    kids.push(el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-sbtitle' }, '携带技能'), sel,
      el('span', { class: 'spmod-hint' }, '换成没有专属实现的技能会退化成通用技能；补位/自选编队的技能不跟着改'),
    ));
  } else {
    kids.push(el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-hint' }, u.scope === 'mine' ? '我场上每一名干员都吃下面这套数值（技能不换——每名干员的技能表不同）'
        : '全场每一名干员都吃下面这套数值，含三个 AI 队友（技能不换）'),
    ));
  }

  const spRow = el('div', { class: 'spmod-sbrow' },
    el('span', { class: 'spmod-sbtitle' }, '技力'),
    el('label', { class: 'spmod-statfield' }, el('span', null, '技能消耗'), unitNum(u.spCost, (v) => editUnit({ spCost: v }), '技能释放所需技力；留空 = 不改', 'spCost')),
    el('label', { class: 'spmod-statfield' }, el('span', null, '初始技力'), unitNum(u.initSp, (v) => editUnit({ initSp: v }), '开场白送的技力；留空 = 不改', 'initSp')),
  );

  const statRow = el('div', { class: 'spmod-statgrid' }, ...UNIT_FIELDS.map(([k, label]) => el('label', {
    class: 'spmod-statfield',
    title: k === 'aspd' ? '攻速，100 = 原速（越大越快）' : k === 'blockCnt' ? '阻挡数' : '',
  },
    el('span', null, label),
    unitNum(u.stats[k], (v) => editUnit({ stats: { ...u.stats, [k]: v } }), '留空 = 不改', k),
  )));

  const multRow = el('div', { class: 'spmod-sbrow' },
    el('span', { class: 'spmod-sbtitle' }, '总倍率'),
    unitNum(u.mult === 1 ? null : u.mult, (v) => editUnit({ mult: v == null ? 1 : v }), `乘在所有属性上（${[...MULT_FIELDS].length} 项；费用、再部署除外）`, 'mult'),
    el('span', { class: 'spmod-hint' }, '留空 = ×1。逐项填的值优先，倍率只作用在没填的那些上'),
    el('button', {
      class: 'spmod-sbbtn', type: 'button', title: '清掉这一页的全部改动并关闭',
      onClick: () => { local.unit = { ...local.unit, on: false, id: null, skill: null, spCost: null, initSp: null, mult: 1, stats: {} }; editUnit({}); },
    }, '清除'),
  );

  kids.push(spRow, el('div', { class: 'spmod-sbsub' },
    el('div', { class: 'spmod-sbtitle' }, '属性（留空 = 不改；填的是绝对值）'),
    statRow,
    multRow,
  ));

  return el('div', { class: 'spmod-sbsection' },
    el('div', { class: 'spmod-sbtitle' }, '单位（技能 / 技力 / 属性）'),
    ...kids,
  );
}

let unitPushedFor = null;
/** 钉住: push the remembered config once per match, the way the sandbox's strategies are pushed. */
function renderUnits() {
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  if (!pub) return;
  if (pub.phase === 'LOBBY' || !priv) { unitPushedFor = null; return; }
  const modded = !!priv.shop?.modPickable || Number.isFinite(Number(priv.modSpeed));
  if (!modded) return;
  const key = `${pub.stageId || ''}|${pub.modeId || ''}`;
  if (unitPushedFor === key) return;
  unitPushedFor = key;
  if (local.unit.pin && local.unit.on) sendUnits();
}

// ---- the battle half of the extra strategies -------------------------------------------------------------
//
// The player's own field is simulated in THIS tab (client-side combat), by the same sim the server runs; the extras ride
// on the battle spec. `bands/battle.js install()` installs each player's IN_BATTLE buffs from that player's single
// `bandId`, so the extras need the same one-band-at-a-time pass here. The sim modules are loaded lazily by the battle
// runner; importing them from here hands back the very same instances (the module cache is keyed by URL), and they are
// safe to load before the runner's own data setup.

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
  if (n > 0) console.info('[luck] battle-side extra strategies installed:', n);
  return n;
}

let simBandsPatched = false;
async function patchSimBands() {
  if (simBandsPatched) return;
  simBandsPatched = true;
  try {
    const [b, n, support] = await Promise.all([
      import('/sim/Battle.js'), import('/sim/content/bands.js'), import('/sim/content/support/index.js'),
    ]);
    const Battle = b?.Battle;
    if (!Battle?.prototype) return;
    // Both halves of the seam, in the order they have to run: the extras go in while the 自选位 numbers are still
    // swapped in, and the swap unwinds last. The bracket itself is slot-rules.patchContentSeam — 0.3.0 calls
    // installContent straight from the Battle constructor, so the `_safe('installContent')` wrapper this used to be
    // never fires any more.
    const swapStack = [];
    const ok = patchContentSeam(Battle, {
      beforeInstall: () => {
        // the content modules read `bb` from support.gameData(), so a swap bracketing the install is what reaches them
        // (see slot-rules.patchGameData). Every installer captures its records at this moment and re-applies from the
        // closure, so restoring right after is safe.
        const base = typeof support?.gameData === 'function' ? support.gameData() : null;
        const patched = base ? patchGameData(diyPatcher.entries(), base) : base;
        swapStack.push(base);
        if (patched && patched !== base) support.setGameData(patched);
      },
      afterInstall: (battle) => {
        try { installExtraBands(battle, n); } catch (e) { console.warn('[luck] battle-side extra strategies failed', e); }
        const base = swapStack.pop();
        if (base !== undefined && base !== null) support?.setGameData?.(base);
      },
    });
    if (!ok) { console.warn('[luck] sim band patch failed: the Battle class has no content seam'); return; }
    console.info('[luck] sim band patch ready');
  } catch (e) {
    console.warn('[luck] sim band patch failed', e);
  }
}
void patchSimBands();

// ---- the unit rules, browser half -----------------------------------------------------------------------
//
// The player's own field is simulated HERE, so the stats / 技力 overrides have to be applied to this process's own sim
// too — the server's copy of them only reaches the AI seats' fields (and vice versa: this half is what makes scope
// 这一名 / 我的全部 do anything at all). Same two seams as the server patch (see unit-rules.js for why they differ):
//
//   * `/sim/simdata.js` DataSource.getChess — the stats. The battle runner builds its own DataSource from the same
//     module instance, and `withUnitLoadouts` (spec.js) wraps it in a delegating view, so the prototype is enough.
//   * `/sim/skills.js` SkillRuntime.reset — 技力, because a kit's own SkillPass may name its own spCost / initSp.
//
// 换技能 needs nothing here: the chosen `skillIndex` is in the battle spec the server sends.

let simUnitsPatched = false;
async function patchSimUnits() {
  if (simUnitsPatched) return;
  simUnitsPatched = true;
  try {
    const [simdata, skills] = await Promise.all([import('/sim/simdata.js'), import('/sim/skills.js')]);
    const DataSource = simdata?.DataSource;
    if (typeof DataSource?.prototype?.getChess === 'function') {
      const orig = DataSource.prototype.getChess;
      DataSource.prototype.getChess = function getChess(id, loadout = null) {
        // unitPatcher owns the stats, diyPatcher the 盟约 / 特质 of a 自选 def — the same two halves the server patch runs
        return diyPatcher.def(unitPatcher.def(id, orig.call(this, id, loadout)));
      };
    }
    // 更多位子: the sim composes a 自选 def from the DataSource's own tables, so a mod slot has to answer here too
    if (typeof DataSource?.prototype?.rawChess === 'function') {
      const origRawChess = DataSource.prototype.rawChess;
      DataSource.prototype.rawChess = function rawChess(id) {
        const table = extraChess();
        if (table && isExtraSlotId(id) && table[id]) return table[id];
        return origRawChess.call(this, id);
      };
      const origRawBackups = DataSource.prototype.rawBackups;
      DataSource.prototype.rawBackups = function rawBackups() {
        const b = origRawBackups.call(this);
        const extras = extraSlotsNow();
        if (!b || !extras.length) return b;
        const diy = extraDiyTable(b.diy, extras);
        return diy && diy !== b.diy ? { ...b, diy } : b;
      };
    }
    const SkillRuntime = skills?.SkillRuntime;
    if (typeof SkillRuntime?.prototype?.reset === 'function') {
      const orig = SkillRuntime.prototype.reset;
      SkillRuntime.prototype.reset = function reset(carry) {
        const cfg = unitPatcher.cfg;
        const u = this.unit;
        const id = u ? (u.defId ?? u.def?.id) : null;
        if (cfg && u && u.kind === 'op' && id != null && unitCovers(cfg, id)) {
          if (cfg.spCost != null) this.baseSpCost = cfg.spCost;
          if (cfg.initSp != null) this.initSp = cfg.initSp;
        }
        return orig.call(this, carry);
      };
    }
    console.info('[luck] sim unit patch ready');
  } catch (e) {
    console.warn('[luck] sim unit patch failed', e);
  }
}
void patchSimUnits();

// ---- the sandbox bar: the two knobs worth reaching for without opening the panel ------------------------

const sbBar = el('div', { class: 'spmod-sandbox', hidden: true, title: '沙盒：地块解锁与策略叠加（完整设置在「自选 → 沙盒」里）' });
const sbPlace = el('input', {
  type: 'checkbox',
  title: '解锁布置地块限制（原本不能放的格子都能放；近战仍然上不了高台）',
  onChange: (e) => { local.sb.place = e.currentTarget.checked; applyDeployUnlock(local.sb.place); saveSandboxPrefs(); sendPlace(); render(true); },
});
const sbCount = el('span', { class: 'spmod-sblabel' }, '');
sbBar.append(
  el('span', { class: 'spmod-sblabel' }, '沙盒'),
  el('label', { class: 'spmod-sbchk' }, sbPlace, '地块'),
  sbCount,
  el('button', {
    class: 'spmod-sbbtn', type: 'button',
    onClick: () => { local.page = 'sandbox'; setOpen(true); },
  }, '设置'),
);
root.append(sbBar);
makeDraggable(sbBar, 'spmod.sandboxPos');

function drawSandboxPage(v) {
  const sb = local.sb;
  const primary = v.priv.bandId || null;
  const chosen = [primary, ...sb.bands].filter(Boolean);
  const lps = chosen.map((id) => Number(data.lookup('bands', id)?.totalHp)).filter(Number.isFinite);
  const lp = lps.length ? Math.max(...lps) : null;

  const head = el('div', { class: 'spmod-sbhead' },
    el('span', { class: 'spmod-hint' }, primary ? `本局主策略：${data.lookup('bands', primary)?.name || primary}` : '还没选策略'),
    el('span', { class: 'spmod-sbhint' }, `已叠 ${sb.bands.length} 个${lp ? ` · 起手 LP ${lp}` : ''}`),
  );

  // -- 策略 ---------------------------------------------------------------------------------------------
  const rows = el('div', { class: 'spmod-bands' });
  const q = (local.tabQuery || '').trim().toLowerCase();
  const list = (sb.pool.length ? sb.pool : []).filter((id) => {
    if (!q) return true;
    const b = data.lookup('bands', id);
    return `${b?.name || ''}${b?.effectName || ''}${b?.desc || ''}`.toLowerCase().includes(q);
  });
  list.sort((a, b) => (Number(data.lookup('bands', b)?.totalHp) || 0) - (Number(data.lookup('bands', a)?.totalHp) || 0));
  for (const id of list) {
    const b = data.lookup('bands', id);
    const on = id === primary || sb.bands.includes(id);
    rows.append(el('button', {
      class: ['spmod-band', on && 'is-on', id === primary && 'is-primary'].filter(Boolean).join(' '),
      type: 'button', 'data-band': id,
      title: `${b?.desc || ''}`,
      onClick: () => { if (id !== primary) toggleBand(id); },
    },
      el('span', { class: 'spmod-bandname' }, b?.name || id),
      el('span', { class: 'spmod-bandmeta' }, `LP ${b?.totalHp ?? '?'}${b?.effectName ? ` · ${b.effectName}` : ''}`),
      el('span', { class: 'spmod-bandtag' }, id === primary ? '主' : on ? '叠' : ''),
    ));
  }

  const bandsBox = el('div', { class: 'spmod-sbsection' },
    el('div', { class: 'spmod-sbtitle' }, '策略（主策略在游戏自己的草稿里选，这里叠额外的；起手 LP 取最大的）'),
    el('div', { class: 'spmod-filters' },
      el('input', {
        class: 'spmod-search', type: 'search', placeholder: '搜索策略…', value: local.tabQuery || '', autocomplete: 'off',
        onInput: (e) => { local.tabQuery = e.currentTarget.value; render(true); },
      }),
    ),
    rows,
  );

  // -- 地块 ---------------------------------------------------------------------------------------------
  const capInput = el('input', {
    class: 'spmod-limit', type: 'number', min: '0', max: '99', step: '1',
    value: sb.cap == null ? '' : String(sb.cap), placeholder: '8',
    title: '部署数量上限（留空 = 游戏自己的 8；召唤物不占）',
    onChange: (e) => {
      const raw = e.currentTarget.value.trim();
      const n = raw === '' ? null : Math.max(0, Math.min(99, Math.trunc(Number(raw) || 0)));
      local.sb.cap = n;
      saveSandboxPrefs();
      sendPlace();
      render(true);
    },
  });
  const placeBox = el('div', { class: 'spmod-sbsection' },
    el('div', { class: 'spmod-sbtitle' }, '地块'),
    el('label', { class: 'spmod-sbrow' },
      el('input', {
        type: 'checkbox', checked: sb.place ? '' : null,
        onChange: (e) => { local.sb.place = e.currentTarget.checked; applyDeployUnlock(local.sb.place); saveSandboxPrefs(); sendPlace(); render(true); },
      }, null),
      el('span', null, '解锁布置地块限制（原本不能放的格子都能放；近战仍然上不了高台）'),
    ),
    el('label', { class: 'spmod-sbrow' }, el('span', null, '部署上限'), capInput),
  );

  panel.append(el('div', { class: 'spmod-body spmod-sbbody' }, head,
    enableOn('sandboxPlace') ? placeBox : offNote('沙盒 · 地块解锁'),
    enableOn('sandboxBands') ? bandsBox : offNote('沙盒 · 策略叠加'),
    enableOn('sandboxUnit') ? drawUnitsSection() : offNote('沙盒 · 单位')));
}

// ---- battle speed -------------------------------------------------------------------------------------
//
// The engine already has the knob: `gameSpeed` (game seconds per real second) is what every client battle's
// `b.start.speed` comes from, what the server-run fields tick at, and what every deadline/release is measured in.
// The server patch just lets us turn it mid-match. Two halves follow it here:
//
//   * a battle already running in this tab — `battleRunner` steps toward wall-clock × `entry.speed`, so each live
//     entry has its `speed` retuned and its `t0` moved to keep the game clock exactly where it is (no jump);
//   * the render engine interpolates units at the battle's speed (`render/app.js setLocalFeed`) — retuned in place,
//     so nothing re-enters the battle.
//
// The sim itself is untouched, so a battle runs tick for tick the same at any speed; only the wall-clock it costs
// changes.

const SPEED_KEY = 'spmod.speed';
const SPEED_CHOICES = [1, 2, 4, 8];
const TICK = 1 / 30; // the sim's fixed tick (public/js/battle/runner.js)
try {
  const n = Number(localStorage.getItem(SPEED_KEY));
  if (isSpeed(n)) local.speed = n;
} catch { /* ignore */ }

const speedBar = el('div', { class: 'spmod-speed', hidden: true, title: '作战倍速（不影响结果）' });
const speedBtns = new Map();
speedBar.append(el('span', { class: 'spmod-speed-label' }, '倍速'));
for (const n of SPEED_CHOICES) {
  const btn = el('button', {
    class: 'spmod-speedbtn', type: 'button',
    title: `${n} 倍速${n === 2 ? '（游戏原速）' : n === 1 ? '（放慢）' : ''}`,
    onClick: () => setSpeed(n),
  }, `${n}×`);
  speedBtns.set(n, btn);
  speedBar.append(btn);
}
/** Tells the player the 结算/回合开始 waits were shortened too (they do not follow the battle speed by themselves). */
const speedPace = el('span', { class: 'spmod-speed-label' }, '');
speedBar.append(speedPace);
root.append(speedBar);

/** The speed the match is actually at (the server's number when we have it), and whether the server is patched. */
let curSpeed = 2;
/** How fast the fixed 过场 steps are running (1 = the game's own pacing; < 1 = shortened to match the battle speed). */
let curPace = 1;
let serverModded = false;
let pushedSpeed = null;
let speedFlashTimer = null;

/** Drag a bar anywhere; the spot is kept per browser. A press on one of its controls never starts a drag. */
/**
 * Keep a bar inside the window, and heal a spot that no longer fits.
 *
 * A dragged position is stored in pixels for the window it was dragged in. Drag the bar near the right edge on a wide
 * screen, come back on a smaller window, and the bar sits at x = 2400 with nothing on screen: it is `display: flex`,
 * visible, opacity 1, and simply outside the viewport. It looks exactly like the bar is gone, with no way back.
 *
 * So it is clamped whenever the bar is SHOWN (not only at load: at load it is still `hidden`, and a hidden bar has no
 * box to measure), on every resize, and the corrected spot is written back — the bad value heals itself once.
 */
function clampBar(bar, key = null) {
  if (bar.hidden) return;
  const r = bar.getBoundingClientRect();
  if (!r.width || !r.height) return; // not laid out yet (its container is display:none) — nothing to clamp against
  const x = Math.max(0, Math.min(window.innerWidth - r.width, r.left));
  const y = Math.max(0, Math.min(window.innerHeight - r.height, r.top));
  if (x === r.left && y === r.top) return;
  bar.style.left = `${x}px`;
  bar.style.top = `${y}px`;
  bar.style.right = 'auto';
  if (key) { try { localStorage.setItem(key, JSON.stringify({ x: Math.round(x), y: Math.round(y) })); } catch { /* ignore */ } }
}

function makeDraggable(bar, key) {
  try {
    const p = JSON.parse(localStorage.getItem(key) || 'null');
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) {
      bar.style.left = `${p.x}px`;
      bar.style.top = `${p.y}px`;
      bar.style.right = 'auto';
    }
  } catch { /* ignore */ }
  bar.__clampKey = key;
  window.addEventListener('resize', () => clampBar(bar, key));
  let d = null;
  bar.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, input, label')) return;
    const r = bar.getBoundingClientRect();
    d = { dx: e.clientX - r.left, dy: e.clientY - r.top };
    try { bar.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  bar.addEventListener('pointermove', (e) => {
    if (!d) return;
    const x = Math.max(0, Math.min(window.innerWidth - bar.offsetWidth, e.clientX - d.dx));
    const y = Math.max(0, Math.min(window.innerHeight - bar.offsetHeight, e.clientY - d.dy));
    bar.style.left = `${x}px`;
    bar.style.top = `${y}px`;
    bar.style.right = 'auto';
  });
  bar.addEventListener('pointerup', (e) => {
    if (!d) return;
    d = null;
    try { bar.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
    try { localStorage.setItem(key, JSON.stringify({ x: bar.offsetLeft, y: bar.offsetTop })); } catch { /* ignore */ }
  });
}

makeDraggable(speedBar, 'spmod.speedPos');

/** Point the local battles already running in this tab at `n`, without moving their clock. */
function applySpeed(n) {
  const runner = globalThis.__SP_RUNNER__;
  try {
    if (runner && runner._entries && typeof runner.state === 'function') {
      const st = runner.state();
      if (!(st && st.paused)) { // frozen: retuning now would mis-schedule against the pause instant
        const now = globalThis.performance ? performance.now() : Date.now();
        for (const e of runner._entries.values()) {
          if (!e || e.done || !(e.speed > 0) || e.speed === n) continue;
          const ticks = Number(e.battle && e.battle.tickCount) || 0;
          e.speed = n;
          e.t0 = now - ((ticks * TICK) / n) * 1000; // targetTick(e, now) stays == ticks
        }
      }
    }
  } catch (err) { console.warn('[luck] retune runner speed failed', err); }
  try { globalThis.__SP_VIEW__?.raw?.setLocalFeed?.({ on: true, speed: n }); } catch (err) { console.warn('[luck] retune render speed failed', err); }
}

function speedFlash(ok) {
  speedBar.classList.toggle('is-err', !ok);
  speedBar.classList.toggle('is-ok', ok);
  if (speedFlashTimer) clearTimeout(speedFlashTimer);
  speedFlashTimer = setTimeout(() => speedBar.classList.remove('is-err', 'is-ok'), 1200);
}

/** Push `n` to the server (which paces every field off it) and adopt it here. */
function sendSpeed(n, { silent = false } = {}) {
  pushedSpeed = n;
  applySpeed(n);
  net.request(SPEED, { n }).then(
    () => { if (!silent) speedFlash(true); },
    (e) => { pushedSpeed = null; if (!silent) speedFlash(false); console.warn('[luck] speed refused', errText(e)); },
  );
}

function setSpeed(n) {
  if (!isSpeed(n)) return;
  local.speed = n;
  curSpeed = n;
  try { localStorage.setItem(SPEED_KEY, String(n)); } catch { /* ignore */ }
  markSpeed();
  sendSpeed(n);
}

function markSpeed() {
  for (const [n, btn] of speedBtns) btn.classList.toggle('is-on', n === curSpeed);
}

/** Show / hide the bar and mark the live speed; also the one-time push of a remembered choice. */
function renderSpeed() {
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  if (priv?.shop?.modPickable || Number.isFinite(Number(priv?.modSpeed))) serverModded = true;
  const server = Number(priv?.modSpeed);
  if (Number.isFinite(server)) curSpeed = server;
  // a speed remembered from an earlier session, against a server that is not at it yet (fresh process): push once
  if (serverModded && local.speed != null) {
    if (Number.isFinite(server) && server === local.speed) pushedSpeed = null;
    else if (pushedSpeed == null) sendSpeed(local.speed, { silent: true });
  }
  // the fixed presentation steps (结算 / 回合开始 / 战斗结束) do NOT follow the battle speed on their own — the server
  // shortens them in a solo match (modPace.delayScale, see installPresentationScale)
  const ds = Number(priv?.modPace?.delayScale);
  curPace = Number.isFinite(ds) && ds > 0 ? ds : 1;
  speedPace.textContent = curPace < 1 ? `过场 ×${Math.round(curPace * 100) / 100}` : '';
  speedPace.title = curPace < 1
    ? `结算 / 回合开始 / 战斗结束的固定等待也跟着倍速缩短了（×${Math.round(curPace * 100) / 100}）`
    : '过场等待是游戏自己的固定时长，不跟倍速；单人局里这张外挂会把它一起缩短';
  const show = serverModded && !!pub && pub.phase !== 'LOBBY';
  if (!showBar(speedBar, show)) return;
  markSpeed();
}

// ---- auto reverse (自动倒转) — a dedicated start/stop, shaped like the speed bar ------------------------
//
// One batch = the server runs N cycles of 直购目标卡 → 装备它掉出来的币 → 卖回. While the toggle is on we keep
// sending the next batch as soon as the last one answers (so the pace is the server's), and we stop the instant
// the server says the run ended — it flips `on` off itself when the seat readies, the shop closes or the money
// runs out. The loop only ever touches the operator IT bought and the coins THAT operator dropped, so a hand of
// saved operators and coins is left alone.

const AUTO = 'g.modAuto';
const AUTO_KEY = 'spmod.auto';
/**
 * The candidates live in ./auto-rules.js — the same module the server patch imports, so the panel and the loop cannot
 * drift on which card is which class. This list is a catalogue, not the menu: only the entries THIS match deals
 * (privateView `shop.modPickable.pool`) are ticked-able, so a card the protocol banned, or one the game keeps hidden
 * (红豆, 蜜蜡 — `visible: false`, so no roll and no buy ever hands one over), is never offered. See syncAutoTargets.
 */
const isCycles = (v) => Number.isInteger(v) && v >= 1 && v <= 2000;
const isBool = (v) => typeof v === 'boolean';
if (!Object.hasOwn(C2S, AUTO)) C2S[AUTO] = { on: isBool, cardIds: isIds, cycles: isCycles, equipCoins: isBool, idCard: isBool };

local.auto = { cardIds: [...AUTO_DEFAULT_IDS], cycles: 40, equipCoins: true, idCard: false, refresh: true, mode: 'shop' };
try {
  const saved = JSON.parse(localStorage.getItem(AUTO_KEY) || 'null');
  if (saved && typeof saved === 'object') {
    // the pre-2026-10-11 shape held ONE id in `cardId`; carry it over as a one-card tick set
    const ids = Array.isArray(saved.cardIds) ? saved.cardIds : (isId(saved.cardId) ? [saved.cardId] : null);
    if (ids) local.auto.cardIds = AUTO_CARDS.filter((c) => ids.includes(c.id)).map((c) => c.id);
    if (isCycles(saved.cycles)) local.auto.cycles = saved.cycles;
    local.auto.equipCoins = !!saved.equipCoins;
    local.auto.idCard = !!saved.idCard;
    if (typeof saved.refresh === 'boolean') local.auto.refresh = saved.refresh;
    if (saved.mode === 'shop' || saved.mode === 'direct') local.auto.mode = saved.mode;
  }
} catch { /* ignore */ }
local.autoOpen = false;

const autoBar = el('div', { class: 'spmod-auto', hidden: true, title: '自动买卖：反复「买到目标卡 → 装备它掉出来的币 → 卖回」（只碰它自己买的那些）' });
/**
 * The targets are a tick list, not a dropdown (author, 2026-10-11): several cards share one loop, each cycle buying
 * whichever ticked card is on the table. Which ones may be bought WHEN is the loop's own business — `deferred` cards
 * (下期兑现) are skipped while the rolls are free, and the two 道具类 cards start unticked. See ./auto-rules.js.
 */
const autoTargetsBtn = el('button', {
  class: 'spmod-autosel spmod-autotarget', type: 'button', 'data-auto': 'targets',
  title: '勾选要倒的卡：一张也行，几张共用同一个循环（只列本局协议里有的）',
  onClick: () => { local.autoOpen = !local.autoOpen; renderAuto(true); },
}, '目标 0');
const autoTargetsBox = el('div', { class: 'spmod-autotargetbox', hidden: true });
const autoNum = el('input', {
  class: 'spmod-limit', type: 'number', min: '1', max: '2000', step: '10', value: String(local.auto.cycles),
  title: '每次请求跑几轮循环',
  onChange: (e) => { local.auto.cycles = clampCycles(e.currentTarget.value); e.currentTarget.value = String(local.auto.cycles); saveAuto(); },
});
const autoCoins = el('input', { type: 'checkbox', title: '把目标卡掉出来的盟约之币装备掉（回收资金）', onChange: (e) => { local.auto.equipCoins = e.currentTarget.checked; saveAuto(); } });
const autoIdc = el('input', { type: 'checkbox', title: '资金有余时买「随身身份牌」装上（金币换层数）', onChange: (e) => { local.auto.idCard = e.currentTarget.checked; saveAuto(); } });
const autoRef = el('input', { type: 'checkbox', title: '商店里没有目标卡时替你把刷新按下去（奇迹层数够就是免费刷新；找不到就停）', onChange: (e) => { local.auto.refresh = e.currentTarget.checked; saveAuto(); } });
const autoMode = el('select', {
  class: 'spmod-autosel',
  title: '买到手的方式：商店＝用游戏自己的刷新与购买（不改玩法，任何开关关着都能用）；直购＝模组直接塞进手里（属于「自选商店」那一组）',
  onChange: (e) => { local.auto.mode = e.currentTarget.value === 'direct' ? 'direct' : 'shop'; saveAuto(); },
});
autoMode.append(el('option', { value: 'shop' }, '商店'), el('option', { value: 'direct' }, '直购'));
autoMode.value = local.auto.mode;
if (local.auto.equipCoins) autoCoins.setAttribute('checked', '');
if (local.auto.idCard) autoIdc.setAttribute('checked', '');
if (local.auto.refresh) autoRef.setAttribute('checked', '');
const autoBtn = el('button', { class: 'spmod-autobtn', type: 'button', 'data-auto': 'run', onClick: () => setAuto(!autoWanted) }, '启动');
const autoTally = el('span', { class: 'spmod-autolabel', 'data-auto': 'tally' }, '');
autoBar.append(el('span', { class: 'spmod-autolabel' }, '自动买卖'), autoMode, autoTargetsBtn, autoNum,
  el('label', { class: 'spmod-autochk' }, autoRef, '刷新'),
  el('label', { class: 'spmod-autochk' }, autoCoins, '币'), el('label', { class: 'spmod-autochk' }, autoIdc, '身份牌'), autoBtn, autoTally,
  autoTargetsBox);
root.append(autoBar);
makeDraggable(autoBar, 'spmod.autoPos');

/**
 * What the PLAYER asked for — the label follows this, never the server's echo. `modAuto.on` only ever means "my last
 * batch used up its cycles", and that flag outlives the run: reload the page mid-run, or lose the tab for a moment,
 * and it stays true with nothing pumping. A button reading 停止 at that point costs a dead click before it can start
 * again, so the server's verdict is used for one thing only — ending a run it ended itself (see renderAuto).
 */
let autoWanted = false;
let autoDriving = false; // whether THIS tab is the one sending the batches
let autoLastIds = []; // the last tick set actually sent (a stop frame needs a non-empty list)
let autoOfferKey = null; // this match's offer, so the tick list is rebuilt only when it changes
let autoPool = new Set(); // the ids this match deals that the catalogue knows (what the tick list may offer)
let autoSendIds = []; // ticked ∩ offered ∩ buyable-at-this-level — what a batch actually carries
let autoFlashTimer = null;

function saveAuto() {
  try { localStorage.setItem(AUTO_KEY, JSON.stringify(local.auto)); } catch { /* ignore */ }
}
function clampCycles(v) {
  return Math.max(1, Math.min(2000, Math.trunc(Number(v) || 1)));
}

function autoFlash(ok) {
  autoBar.classList.toggle('is-err', !ok);
  autoBar.classList.toggle('is-ok', ok);
  if (autoFlashTimer) clearTimeout(autoFlashTimer);
  autoFlashTimer = setTimeout(() => autoBar.classList.remove('is-err', 'is-ok'), 1200);
}

/** Send one batch; chain the next when it answers, so the pace is the server's and batches never overlap. */
function autoTick() {
  if (!autoDriving) return;
  const { cycles, equipCoins, idCard, refresh, mode } = local.auto;
  const cardIds = autoSendIds;
  if (cardIds.length === 0) { setAuto(false); return; }
  autoLastIds = cardIds;
  net.request(AUTO, { on: true, cardIds, cycles, equipCoins, idCard, refresh, mode }).then(
    () => { if (autoDriving) setTimeout(autoTick, 30); },
    (e) => {
      // the server refused the batch outright: the run is over, so drop back to 启动 instead of sitting on a 停止
      // that would need a dead click
      autoDriving = false;
      autoWanted = false;
      markAuto();
      autoFlash(false);
      console.warn('[luck] auto stopped', errText(e));
    },
  );
}

/** The one button: start when the player has not asked for a run, stop when they have. */
function setAuto(on) {
  autoWanted = on;
  autoDriving = on;
  if (on) {
    autoFlash(true);
    autoTick();
  } else {
    const cardIds = autoSendIds.length ? autoSendIds : autoLastIds;
    const { cycles, equipCoins, idCard, refresh, mode } = local.auto;
    // a stop frame still has to carry a non-empty list (the intent's own validator), so fall back to whatever is on
    // offer; if the match offers nothing at all there is nothing to stop and no batch was ever accepted
    const stopIds = cardIds.length ? cardIds : [...autoPool];
    if (stopIds.length) net.request(AUTO, { on: false, cardIds: stopIds, cycles, equipCoins, idCard, refresh, mode }).catch(() => {});
  }
  markAuto();
}

function markAuto() {
  autoBtn.classList.toggle('is-on', autoWanted);
  autoBtn.textContent = autoWanted ? '停止' : '启动';
}

/**
 * The dropdown lists exactly the catalogue entries THIS match deals: `modPickable.pool` is the match's own pool
 * (visible, nothing 本局禁用), so 红豆/蜜蜡 and anything the protocol banned never appear. Rebuilt only when that
 * offer changes; the player's pick survives a rebuild while it is still on the table.
 */
function syncAutoTargets(pool, level) {
  // 直购 obeys the shop roll's own tier gate (a card above 调度中心 Lv. is refused), so a target this level cannot buy
  // yet would stop the loop on its very first cycle and look like a dead button. Only the cards this level can already
  // buy are sent; the rest are listed with the level they need, so the reason is on screen instead of in a tally.
  const tierOf = (id) => { const t = Number(data.lookup('chess', id)?.tier); return Number.isInteger(t) ? t : 9; };
  const here = AUTO_CARDS.filter((c) => pool.has(c.id)).sort((a, b) => tierOf(a.id) - tierOf(b.id));
  const usable = here.filter((c) => tierOf(c.id) <= level);
  autoPool = new Set(here.map((c) => c.id));
  // what a batch carries: the ticked cards, kept in catalogue order
  local.auto.cardIds = AUTO_CARDS.filter((c) => local.auto.cardIds.includes(c.id)).map((c) => c.id);
  autoSendIds = usable.filter((c) => local.auto.cardIds.includes(c.id)).map((c) => c.id);
  const key = `${here.map((c) => c.id).join(',')}|${usable.map((c) => c.id).join(',')}|L${level}|${autoSendIds.join(',')}`;
  if (key === autoOfferKey) return;
  autoOfferKey = key;

  const none = usable.length === 0;
  autoTargetsBtn.disabled = none;
  autoBtn.disabled = none || autoSendIds.length === 0; // nothing ticked = nothing to drive
  if (autoWanted && none) setAuto(false);
  const ticked = autoSendIds.length;
  autoTargetsBtn.textContent = `目标 ${ticked}/${usable.length}`;
  autoTargetsBtn.classList.toggle('is-empty', ticked === 0);
  autoTargetsBtn.title = none
    ? (here.length ? `本局的倒转目标都还买不了（调度中心等级不够，最低要 Lv.${Math.min(...here.map((c) => tierOf(c.id)))}）` : '本局没有可倒转的卡')
    : `勾选要倒的卡：一张也行，几张共用同一个循环（已勾 ${ticked} 张）`;

  clear(autoTargetsBox);
  autoTargetsBox.hidden = !local.autoOpen;
  if (!local.autoOpen) return;
  if (none) {
    autoTargetsBox.append(el('div', { class: 'spmod-autotargetnote' },
      here.length ? `本局的倒转目标都还买不了：调度中心要 Lv.${Math.min(...here.map((c) => tierOf(c.id)))}` : '本局没有可倒转的卡'));
    return;
  }
  let lastCls = null;
  for (const c of here) {
    const t = tierOf(c.id);
    const ok = t <= level;
    if (c.cls !== lastCls) {
      lastCls = c.cls;
      autoTargetsBox.append(el('div', { class: 'spmod-autotargetnote' }, AUTO_CLASS_HINT[c.cls] || AUTO_CLASS_LABEL[c.cls] || c.cls));
    }
    const box = el('input', {
      type: 'checkbox', 'data-auto-id': c.id,
      // a level-locked row renders UNticked: its tick is kept in localStorage but it is not sent either (autoSendIds
      // is the usable set), so showing it ticked would make the count disagree with what a batch carries
      checked: ok && local.auto.cardIds.includes(c.id),
      disabled: !ok,
      onChange: (e) => toggleAutoTarget(c.id, e.currentTarget.checked),
    });
    // a non-economy card is only ever taken in the free-rolling regime (see autoCardAllowedNow) — say so on the row
    autoTargetsBox.append(el('label', {
      class: `spmod-autotarget is-${c.cls}${ok ? '' : ' is-locked'}`,
      title: ok
        ? `${c.name} · ${c.note}（${AUTO_CLASS_LABEL[c.cls]}${c.economy
          ? '，收费刷时也抓'
          : '，不直接给钱：收费刷时只在这张买进卖出不亏的情况下才抓，比如远见减价之后'}）`
        : `${c.name} 要调度中心 Lv.${t}`,
    }, box, el('span', { class: 'spmod-autotargetname' }, `${c.name} · ${c.note}`),
      el('em', { class: 'spmod-autotargetcls' },
        ok ? (c.economy ? AUTO_CLASS_LABEL[c.cls] : `${AUTO_CLASS_LABEL[c.cls]}·非经济`) : `Lv.${t}`)));
  }
}

/** One tick: remember it, and end a run whose send set just went empty. */
function toggleAutoTarget(id, on) {
  const set = new Set(local.auto.cardIds);
  if (on) set.add(id); else set.delete(id);
  local.auto.cardIds = AUTO_CARDS.filter((c) => set.has(c.id)).map((c) => c.id);
  saveAuto();
  renderAuto(true); // force a rebuild so the button count and the send set follow
}

/** Show / hide the bar, rebuild the target list, and end the run when the SERVER ended it. */
function renderAuto(force) {
  if (force) autoOfferKey = null; // the tick list or the open state changed under us — rebuild it
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  const modded = !!priv?.shop?.modPickable || Number.isFinite(Number(priv?.modSpeed));
  const a = priv?.modAuto;
  // A stop the server made on its own (ready / no funds / phase / would-merge) ends the player's intent too. Its
  // `on: false` echo of our own stop (stop 'off') and its `on: true` from a finished batch are both ignored.
  if (a && a.on === false && autoWanted && a.stop && a.stop !== 'off') {
    autoDriving = false;
    autoWanted = false;
  }
  const show = modded && !!pub && pub.phase !== 'LOBBY';
  if (!showBar(autoBar, show)) {
    // the bar is gone (lobby / match over / unmodded): drop the run too, or the next match opens with a 停止 on a
    // loop nothing is driving — the same dead click, just across matches
    autoDriving = false;
    autoWanted = false;
    return;
  }
  syncAutoTargets(new Set(priv?.shop?.modPickable?.pool || priv?.shop?.modPickable?.chess || []), Number(priv?.shop?.level) || 1);
  if (a && Number.isFinite(a.done)) {
    // which of the two rolling regimes the batch ran in (奇迹满一百 / 有免费次数 = 免费刷，其余 = 收费刷)
    const parts = typeof a.free === 'boolean' ? [a.free ? '免费刷' : '收费刷'] : [];
    parts.push(`${a.done} 轮`);
    if (Number.isFinite(a.refreshes) && a.refreshes > 0) parts.push(`刷 ${a.refreshes}`);
    if (Number.isFinite(a.gold)) parts.push(`金 ${a.gold >= 0 ? '+' : ''}${a.gold}`);
    if (Number.isFinite(a.layers)) parts.push(`层 +${a.layers}`);
    if (!a.on && a.stop && a.stop !== 'off') parts.push(`停：${a.stop}`);
    autoTally.textContent = parts.join(' · ');
  }
  markAuto();
}

// ---- the shop bond filter (阵营锁) -------------------------------------------------------------------------
//
// The shop's automatic roll is server-side (PlayerState._rollChessSlot → SharedPool.roll), so this half only sends the
// chosen bond set and shows what came back: the bonds in play are listed from the server's `pool`, and the live
// admitted operator count is the server's (it is the one that knows the current level and the copies left). The whole
// thing is kept per browser, and `ps.modShopFilter` is per-seat, so it has to go out once per match (see render()).

const FILTER_KEY = 'spmod.shopfilter';
try {
  const s = JSON.parse(localStorage.getItem(FILTER_KEY) || 'null');
  if (s && typeof s === 'object') {
    local.filter.on = !!s.on;
    if (Array.isArray(s.bonds)) local.filter.bonds = s.bonds.filter(isId);
    // A build in between kept a single `bond`; fold it back into the set.
    else if (typeof s.bond === 'string' && isId(s.bond)) local.filter.bonds = [s.bond];
    // 'only' is the original 2026-10-10 reading, so a saved set from before the mode existed keeps its meaning.
    if (isFilterMode(s.mode)) local.filter.mode = s.mode;
  }
} catch { /* ignore */ }

function saveShopFilterPrefs() {
  try { localStorage.setItem(FILTER_KEY, JSON.stringify(local.filter)); } catch { /* ignore */ }
}

/** The chosen bonds' display names, out of the pool the server reported (falls back to the raw ids). */
function filterBondNames(ids) {
  const pool = view()?.shop?.modShopFilter?.pool;
  const list = Array.isArray(pool) ? pool : [];
  return ids.map((id) => {
    const hit = list.find((b) => b.id === id);
    return hit ? (hit.name || hit.id) : id;
  });
}

function sendShopFilter() {
  net.request(SHOPFILTER, { on: local.filter.on, bonds: local.filter.bonds, mode: local.filter.mode }).then(
    () => flash(local.filter.on
      ? (local.filter.bonds.length
        ? `阵营锁已开：${local.filter.mode === 'has' ? '包含' : '仅限'} · ${filterBondNames(local.filter.bonds).join('+')}`
        : '阵营锁已开（还没选盟约，先不过滤）')
      : '阵营锁已关', true),
    (e) => flash(errText(e)),
  );
}

function setShopFilterOn(on) {
  local.filter.on = !!on;
  saveShopFilterPrefs();
  sendShopFilter();
  render(true);
}

/** Many bonds at a time; a chip toggles itself in and out of the set. */
function toggleShopBond(id) {
  const i = local.filter.bonds.indexOf(id);
  if (i >= 0) local.filter.bonds.splice(i, 1);
  else local.filter.bonds.push(id);
  saveShopFilterPrefs();
  sendShopFilter();
  render(true);
}

function setShopFilterMode(mode) {
  if (!isFilterMode(mode) || local.filter.mode === mode) return;
  local.filter.mode = mode;
  saveShopFilterPrefs();
  sendShopFilter();
  render(true);
}

/** The 阵营锁 row: the switch, the reading (包含 / 仅限), the multi-select bond chips, and the live admitted count
 *  (0 is called out — the shop would blank). */
function shopFilterRow(v) {
  const sf = v.shop?.modShopFilter;
  if (!sf) return null;
  const on = !!local.filter.on;
  const chosen = new Set(local.filter.bonds);
  const mode = isFilterMode(local.filter.mode) ? local.filter.mode : 'only';
  const pool = Array.isArray(sf.pool) ? sf.pool : [];
  const count = Number.isInteger(sf.count) ? sf.count : null;
  const what = mode === 'has' ? '包含：带所选里任意一条就留' : '仅限：盟约全在所选里才留';
  const empty = chosen.size > 0 && count === 0;
  let hint = '还没选盟约（选之前不过滤）';
  if (chosen.size) hint = `${what} · 已选 ${chosen.size} 条 · 当前可选 ${count ?? '?'} 名干员`;
  if (empty) hint = `${what} · 已选 ${chosen.size} 条 · 当前可选 0 名（商店会刷空，再加几条或换成「包含」）`;
  return el('div', { class: 'spmod-sbsection spmod-shopfilter' },
    el('div', { class: 'spmod-sbtitle' }, '阵营锁'),
    el('label', { class: 'spmod-sbrow' },
      el('input', { type: 'checkbox', checked: on ? '' : null, onChange: (e) => setShopFilterOn(e.currentTarget.checked) }, null),
      el('span', null, '商店只刷所选盟约的干员（盟约可多选；口径决定取并集还是取子集；只管你这一座的自动刷新）'),
    ),
    on ? el('div', { class: 'spmod-filtermode' },
      ...[['has', '包含'], ['only', '仅限']].map(([m, label]) => el('button', {
        class: ['spmod-modebtn', mode === m && 'is-on'].filter(Boolean).join(' '),
        type: 'button', 'data-mode': m,
        title: m === 'has' ? '并集：干员带了所选里任意一条盟约就留下' : '子集：干员的每条盟约都在所选里才留下',
        onClick: () => setShopFilterMode(m),
      }, label)),
    ) : null,
    on ? el('div', { class: 'spmod-bondchips' },
      ...pool.map((b) => el('button', {
        class: ['spmod-bondchip', chosen.has(b.id) && 'is-on'].filter(Boolean).join(' '),
        type: 'button', 'data-bond': b.id, title: b.isCore ? `${b.name}（核心盟约）` : b.name,
        onClick: () => toggleShopBond(b.id),
      }, b.name || b.id)),
    ) : null,
    on ? el('div', { class: ['spmod-sbhint', empty && 'is-warn'].filter(Boolean).join(' ') }, hint) : null,
  );
}

// ---- the 自选位 kit: per-slot 盟约 / 特质 -------------------------------------------------------------------
//
// A 自选编队 piece carries only the 盟约 its operator's 势力 derives — and 53 of the 86 possible operators derive to
// 协防干员, while 阿戈尔 and 谢拉格 are unreachable — plus no 特质 at all (the official rule). This page overrides that
// PER SLOT: whichever operator the player slots there counts as the 盟约 he names and bears the 特质 he names.
//
// The kit follows the SLOT, not the operator (the author's rule, 2026-10-10), so re-slotting keeps it. 替换 vs 叠加: 替换
// REPLACES the operator's own 盟约 list (bonds), 叠加 ADDS to it (addBonds); an empty 替换 list means "no 盟约 at all".
//
// Both halves run the same shared module (slot-rules.js): the server rebuilds the composed records and the battle defs,
// and this tab patches its own sim, because the player's own field is simulated HERE (the unit rules above work the same
// way). 特质 are named by their `_a` id; the elite form follows automatically (slot-rules pairs the `_b` twin).

const DIY_KEY = 'spmod.diySlots';
/** This tab's own patcher — shared by the panel (which sets it) and the sim wrapper in patchSimUnits below. */
const diyPatcher = createSlotPatcher();

/**
 * While the pointer is held down on a 盟约 chip, sweeping across the others applies the same on/off (`bondDrag.on`) to
 * each one. Cleared on mouseup anywhere; `.click()` (no mousedown) still toggles a single chip, which is what the
 * self-test drives.
 */
let bondDrag = null;
let chipJustPressed = false;
document.addEventListener('mouseup', () => { bondDrag = null; });

const slotTables = () => ({ bonds: data.get('bonds'), garrisons: data.get('garrisons') });
/** 特质的触发时机（data/garrisons.json eventType），给面板一个看得懂的名字。 */
const GAR_EVENT = Object.freeze({
  IN_BATTLE: '作战', SERVER_GAIN: '获得', SERVER_CHESS_SOLD: '售出', SERVER_PRICE: '价格',
  SERVER_PREP_START: '休整期开始', SERVER_PREP_FIN: '休整期结束', SERVER_REFRESH_SHOP: '刷新',
});
/** The order the picker shows those groups in: the ones you feel while 休整期 first, then 作战. */
const GAR_ORDER = Object.freeze(['SERVER_GAIN', 'SERVER_CHESS_SOLD', 'SERVER_PRICE', 'SERVER_REFRESH_SHOP', 'SERVER_PREP_START', 'SERVER_PREP_FIN', 'IN_BATTLE']);
const stripTags = (s) => String(s ?? '').replace(/<[^>]+>/g, '');

/**
 * Every 特质 a slot may be given, as `{ id, desc, event, owners, eliteDesc }`. Only the `_a` (normal) form of each pair
 * is listed: the game pairs them itself, a normal chess carries `garrison_XX_a` on its `_a` record and `garrison_XX_b`
 * on its `_b` one, so a piece that is 精锐 gets the elite version AUTOMATICALLY. Listing both would only make the author
 * choose a thing he does not have to choose (and the `_b` entries are the same 特质 with bigger numbers).
 * `owners` = the 棋子 the 特质 comes from (the record's own `owners` list), which is what "标注源头是哪一张卡" means.
 */
function garrisonOptions() {
  const table = data.get('garrisons') || {};
  const chess = data.get('chess') || {};
  const out = [];
  for (const [id, g] of Object.entries(table)) {
    if (!g) continue;
    if (id.endsWith('_b') && table[id.replace(/_b$/, '_a')]) continue; // the elite twin of a listed pair
    const twin = id.endsWith('_a') ? table[id.replace(/_a$/, '_b')] : null;
    out.push({
      id,
      desc: stripTags(g.desc),
      eliteDesc: twin ? stripTags(twin.desc) : null,
      event: g.eventType,
      owners: [...new Set((g.owners || []).map((c) => chess[c]?.name).filter(Boolean))],
    });
  }
  return out;
}

/**
 * The 特质 picker, shared by a slot's own list and the 「新位子默认」 list: grouped by 触发时机, only the `_a` (normal)
 * form of each pair (the elite one is applied by the game itself, see garrisonOptions), and every row names the 棋子 it
 * comes from. `key` identifies the target (`'default'`, or a slot base id) — it drives the open/close state and the
 * self-test's selectors.
 */
function garrisonPicker({ key, ids, onAdd }) {
  const q = (local.diy.query || '').trim().toLowerCase();
  const pool = garrisonOptions().filter((g) => !ids.includes(g.id) && (!q
    || g.id.toLowerCase().includes(q) || g.desc.toLowerCase().includes(q)
    || g.owners.some((n) => n.toLowerCase().includes(q))));
  const groups = [];
  for (const ev of GAR_ORDER) {
    const list = pool.filter((g) => g.event === ev);
    if (list.length) groups.push({ ev, list: list.slice(0, 40), more: Math.max(0, list.length - 40) });
  }
  return el('div', { class: 'spmod-sbsub' },
    el('div', { class: 'spmod-sbrow' },
      el('input', {
        class: 'spmod-search', type: 'search', placeholder: '搜索特质…（也可以搜它来自哪张卡）', value: local.diy.query || '', autocomplete: 'off',
        'data-garquery': key,
        onInput: (e) => { local.diy.query = e.currentTarget.value; render(true); },
      }),
      el('span', { class: 'spmod-hint' }, '只列普通形态那一条；精锐形态的那一条会自动接上'),
    ),
    el('div', { class: 'spmod-gars' }, ...groups.flatMap(({ ev, list, more }) => [
      el('div', { class: 'spmod-gargroup' }, `${GAR_EVENT[ev] || ev}（${list.length}${more ? `+${more}` : ''}）`),
      ...list.map((g) => el('button', {
        class: 'spmod-gar', type: 'button', 'data-garrison': g.id, 'data-slot': key,
        title: `${g.id}\n普通：${g.desc}${g.eliteDesc ? `\n精锐：${g.eliteDesc}` : ''}`,
        onClick: () => onAdd(g.id),
      },
        el('span', { class: 'spmod-gartext' }, g.desc),
        g.owners.length ? el('span', { class: 'spmod-garsrc' }, `来自 ${g.owners.slice(0, 4).join('、')}${g.owners.length > 4 ? ` 等 ${g.owners.length} 枚` : ''}`) : null,
      )),
    ])),
    groups.length ? null : el('span', { class: 'spmod-hint' }, Object.keys(data.get('garrisons') || {}).length ? '没有匹配的特质' : '特质表还没载入'),
  );
}

/** The chosen 特质s as removable chips (`entries` = `[{ id, bb }]`; a ✎ marks the ones whose numbers were edited). */
function garrisonChips(entries, key, onRemove) {
  const table = data.get('garrisons') || {};
  return el('div', { class: 'spmod-garchips' }, ...entries.map((entry) => {
    const rec = table[entry.id];
    const twin = entry.id.endsWith('_a') ? table[entry.id.replace(/_a$/, '_b')] : null;
    const desc = stripTags(rec?.desc || entry.id);
    return el('button', {
      class: ['spmod-garchip', entry.bb && 'is-on'].filter(Boolean).join(' '), type: 'button',
      'data-garrison': entry.id, 'data-slot': key,
      title: `${GAR_EVENT[rec?.eventType] || ''}\n普通：${desc}${twin ? `\n精锐：${stripTags(twin.desc)}` : ''}${entry.bb ? '\n（数值改过，✎）' : ''}`,
      onClick: () => onRemove(entry.id),
    }, `${desc.slice(0, 14)}${desc.length > 14 ? '…' : ''}${entry.bb ? ' ✎' : ''} ✕`);
  }));
}

/**
 * The 模组 a 自选 piece may carry at a slot's elite stage: the modules of its elite unit form
 * (data/backups.json `units[charId].forms['2/60/7/<equipLevel>'].modules`), minus the ones that only work in another
 * game mode (ISW- / SO- / RA- — the same set shared/diy.js isDiyModule excludes from a roster).
 */
function diyModuleChoices(charId, slotBase) {
  const u = data.getRaw('backups')?.units?.[charId];
  if (!u?.forms) return [];
  const status = data.getRaw('chess')?.[String(slotBase).replace(/_a$/, '_b')]?.status;
  const key = `${status?.phase ?? 2}/${status?.level ?? 60}/${status?.skillLevel ?? 7}/${status?.equipLevel ?? 1}`;
  const form = u.forms[key] || Object.values(u.forms)[Object.values(u.forms).length - 1];
  return (form?.modules || [])
    .filter((m) => m && m.uniEquipId && !/^(?:ISW|SO|RA)-/.test(String(m.typeName || '')))
    .map((m) => ({
      id: m.uniEquipId,
      name: u.moduleNames?.[m.uniEquipId]?.name || m.uniEquipId,
      type: u.moduleNames?.[m.uniEquipId]?.typeName || m.typeName || '',
    }));
}
/** Every slot the MATCH's data defines (the game's four; the mod's own come from `local.diy.extra`). */
function allSlots() {
  const slots = data.get('backups')?.diy?.slots;
  if (!slots || typeof slots !== 'object') return [];
  return Object.entries(slots)
    .filter(([slotId]) => !isExtraSlotId(slotId))
    .map(([slotId, s]) => ({ slotId, tier: s?.tier ?? '?', shopLevel: s?.shopLevel ?? s?.tier ?? '?' }));
}

/** The operators a 自选 pick may name: the game's prototypes plus the owned 6★ pool (data/backups.json diy). */
function diyOperatorPool() {
  const diy = data.getRaw('backups')?.diy || {};
  const proto = [...new Set([...(diy.prototypes?.['5'] || []), ...(diy.prototypes?.['6'] || [])])];
  const ids = [...new Set([...proto, ...(diy.ownedPool || [])])];
  return ids.map((id) => ({ id, isProto: proto.includes(id), ...(diy.operators?.[id] || {}) }));
}

/**
 * The skills a 自选 pick of `charId` may carry: `[{ index, name }]` for the indexes present in BOTH of its unit forms
 * (shared/diy.js checkDiyPick requires exactly that; the chess records are irrelevant — a 自选 body comes from
 * data/backups.json `units[charId].forms`). A 原型干员 has none: it carries its locked skill.
 */
function diySkillChoices(charId) {
  const forms = data.getRaw('backups')?.units?.[charId]?.forms;
  if (!forms || typeof forms !== 'object') return [];
  const list = Object.values(forms).filter(Boolean);
  if (!list.length) return [];
  const names = new Map((list[0]?.skills || []).map((s) => [s.index, s.name]));
  const sets = list.map((f) => new Set((f.skills || []).map((s) => s.index)));
  return [...names.keys()].filter((i) => sets.every((s) => s.has(i))).sort((a, b) => a - b)
    .map((i) => ({ index: i, name: names.get(i) || `技能 ${i + 1}` }));
}

/** Whether `charId` is one of the game's 原型干员 (its skill and module are fixed by the data, lockedSelection). */
function isProtoChar(charId) {
  const diy = data.getRaw('backups')?.diy;
  return !!charId && [...(diy?.prototypes?.['5'] || []), ...(diy?.prototypes?.['6'] || [])].includes(charId);
}

/**
 * The skill a 自选 piece carries: the panel's own choice for the slot when it has one, else whatever was composed —
 * which for a 原型干员 is its locked skill. The game's OWN picker defaults to the LAST skill (ui/diyModel.js
 * defaultPick), and so does this one; an earlier version defaulted to the first, which is what the author caught.
 */
function slotSkillIndex(base, composed) {
  const own = local.diy.skills[base];
  if (Number.isInteger(own)) return own;
  if (composed != null && Number.isInteger(composed)) return composed;
  return null;
}

/** Remember the skill a slot carries, and push it (the server re-composes that slot's record around it). */
function setSlotSkill(slotId, index) {
  const base = slotBaseId(slotId);
  if (!Number.isInteger(index)) { delete local.diy.skills[base]; } else local.diy.skills[base] = index;
  saveDiyPrefs();
  sendDiy();
  render(true);
}

/** Remember the 模组 a slot carries (`null` = 不带模组) and push it, same rebuild path as the skill. */
function setSlotModule(slotId, uniEquipId) {
  const base = slotBaseId(slotId);
  local.diy.mods[base] = uniEquipId || null;
  saveDiyPrefs();
  sendDiy();
  render(true);
}
/**
 * An empty raw slot config. The default mode is **跟随干员** (`bonds: null`): a slot the author only gave a 特质 or a
 * number to must keep the operator's own 盟约, or adding a 特质 would silently strip 协防干员 along with it. Clicking a
 * 盟约 chip from 跟随干员 switches to 替换 with that chip (that is what "give this slot this 盟约" means).
 */
const emptyDiyCfg = () => ({ mode: 'keep', bonds: null, addBonds: [], garrisons: [], bondBb: {} });
const idList = (v) => (Array.isArray(v) ? v.filter(isId) : []);
const isBbObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** 特质 entries as `{ id, bb }` — `bb` only when the author gave that 特质 his own numbers (slot-rules mints an id for it). */
const garList = (v) => {
  if (!Array.isArray(v)) return [];
  const out = [];
  for (const g of v) {
    const id = typeof g === 'string' ? g : g?.id;
    if (!isId(id) || out.some((x) => x.id === id)) continue;
    const bb = isBbObj(g?.bb) ? { ...g.bb } : null;
    out.push(bb && Object.keys(bb).length ? { id, bb } : { id });
  }
  return out;
};
/** A `bb` object after setting one key (`null` removes it); null when nothing is left over the stock numbers. */
const setBb = (bb, key, value) => {
  const out = { ...(isBbObj(bb) ? bb : {}) };
  if (value == null) delete out[key]; else out[key] = value;
  return Object.keys(out).length ? out : null;
};

function loadDiyPrefs() {
  try {
    const saved = JSON.parse(localStorage.getItem(DIY_KEY) || 'null');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return;
    const tables = slotTables();
    for (const [slotId, raw] of Object.entries(saved.slots || {})) {
      if (!normalizeSlotCfg(raw, tables)) continue; // a slot whose ids no longer exist (a game update) is dropped
      const mode = raw?.mode === 'add' ? 'add' : raw?.mode === 'keep' ? 'keep' : 'replace';
      const bondBb = {};
      if (isBbObj(raw.bondBb)) for (const [id, bb] of Object.entries(raw.bondBb)) if (isBbObj(bb)) bondBb[id] = { ...bb };
      local.diy.slots[slotBaseId(slotId)] = {
        mode,
        bonds: mode === 'replace' ? idList(raw.bonds) : null,
        addBonds: mode === 'add' ? idList(raw.addBonds) : [],
        garrisons: garList(raw.garrisons),
        bondBb,
      };
    }
    const extra = [];
    const seen = new Set();
    for (const e of Array.isArray(saved.extra) ? saved.extra : []) {
      const k = Math.trunc(Number(e?.k));
      if (!Number.isInteger(k) || k < 1 || k > MAX_EXTRA_SLOTS || seen.has(k)) continue;
      if (!EXTRA_TIERS.includes(Math.trunc(Number(e?.tier)))) continue;
      seen.add(k);
      extra.push({
        k,
        tier: Math.trunc(Number(e.tier)),
        charId: isId(e.charId) ? e.charId : null,
        skillIndex: Number.isInteger(e.skillIndex) ? e.skillIndex : null,
        uniEquipId: isId(e.uniEquipId) ? e.uniEquipId : null,
      });
    }
    local.diy.extra = extra;
    if (isBbObj(saved.skills)) {
      for (const [slotId, idx] of Object.entries(saved.skills)) {
        if (Number.isInteger(idx) && idx >= 0 && idx <= 9) local.diy.skills[slotBaseId(slotId)] = idx;
      }
    }
    if (isBbObj(saved.mods)) {
      for (const [slotId, id] of Object.entries(saved.mods)) {
        if (id === null || isId(id)) local.diy.mods[slotBaseId(slotId)] = id || null;
      }
    }
    if (Array.isArray(saved.defaultBonds)) local.diy.defaultBonds = saved.defaultBonds.filter(isId);
    if (Array.isArray(saved.defaultGarrisons)) local.diy.defaultGarrisons = saved.defaultGarrisons.filter(isId);
    bumpExtra();
  } catch { /* ignore */ }
}

function saveDiyPrefs() {
  try {
    localStorage.setItem(DIY_KEY, JSON.stringify({
      slots: local.diy.slots, extra: local.diy.extra, skills: local.diy.skills, mods: local.diy.mods,
      defaultBonds: local.diy.defaultBonds, defaultGarrisons: local.diy.defaultGarrisons,
    }));
  } catch { /* ignore */ }
}

/** Add a mod-owned slot; the tier defaults to 6 (the strongest) and the operator is picked afterwards. */
function addExtraSlot() {
  const used = new Set(local.diy.extra.map((e) => e.k));
  let k = 1;
  while (used.has(k) && k <= MAX_EXTRA_SLOTS) k++;
  if (k > MAX_EXTRA_SLOTS) return;
  local.diy.extra = [...local.diy.extra, { k, tier: 6, charId: null, skillIndex: null, uniEquipId: null }];
  // seed the new slot with the remembered defaults (盟约 in 叠加, so the operator's own 盟约 stays; 特质 as they are)
  const seed = slotBaseId(extraSlotId(k, false));
  if (local.diy.defaultBonds.length || local.diy.defaultGarrisons.length) {
    local.diy.slots[seed] = {
      mode: local.diy.defaultBonds.length ? 'add' : 'keep',
      bonds: null,
      addBonds: [...local.diy.defaultBonds],
      garrisons: local.diy.defaultGarrisons.map((id) => ({ id })),
      bondBb: {},
    };
  }
  local.diy.pickFor = extraSlotId(k, false);
  bumpExtra();
  saveDiyPrefs();
  sendDiy();
  render(true);
}

function removeExtraSlot(k) {
  local.diy.extra = local.diy.extra.filter((e) => e.k !== k);
  delete local.diy.slots[slotBaseId(extraSlotId(k, false))];
  bumpExtra();
  saveDiyPrefs();
  sendDiy();
  render(true);
}

/** Rewrite one mod slot (its tier or its pick). A tier change keeps the pick; a pick change keeps the kit. */
function editExtra(k, patch) {
  local.diy.extra = local.diy.extra.map((e) => (e.k === k ? { ...e, ...patch } : e));
  bumpExtra();
  saveDiyPrefs();
  sendDiy();
  render(true);
}

/** Adopt the kit into this tab's own sim (the browser half; the server half goes out with sendDiy). */
function applyDiyCfg() {
  // the whole kit (盟约 / 特质 / 数值) is the `diy` group: switch it off and this tab's sim goes back to the game's own
  // records too, so it agrees with the server (which rolled the same thing back).
  if (!enableOn('diy')) { diyPatcher.set(new Map()); return; }
  const map = new Map();
  const tables = slotTables();
  for (const [slotId, raw] of Object.entries(local.diy.slots)) {
    const cfg = normalizeSlotCfg(raw, tables);
    if (cfg) map.set(slotBaseId(slotId), cfg);
  }
  diyPatcher.set(map);
}

/** The configs worth sending: a slot with nothing set yet is left out, so the server never has to clear it. */
function diyPayload() {
  const slots = {};
  const exOn = enableOn('diyExtra'); // the 自造位子 group
  const kitOn = enableOn('diy');     // the 盟约 / 特质 / 数值 group
  // only slots the server can actually build: the game's own four, plus the mod ones that already have an operator
  // (a kit sent for a slot with no piece is refused outright, which would flash an error at the author for nothing).
  // A group the master switch has turned off contributes nothing, so the payload matches what the server will honour.
  const known = new Set(allSlots().map((s) => slotBaseId(s.slotId)));
  if (exOn) for (const e of local.diy.extra) if (e.charId) known.add(slotBaseId(extraSlotId(e.k, false)));
  if (kitOn) for (const [slotId, raw] of Object.entries(local.diy.slots)) {
    if (known.has(slotBaseId(slotId)) && normalizeSlotCfg(raw, slotTables())) {
      slots[slotBaseId(slotId)] = { bonds: raw.bonds, addBonds: raw.addBonds, garrisons: raw.garrisons, bondBb: raw.bondBb };
    }
  }
  const extra = (exOn ? local.diy.extra : [])
    .filter((e) => e.charId)
    .map((e) => ({ k: e.k, tier: e.tier, pick: { charId: e.charId, skillIndex: e.skillIndex ?? null, uniEquipId: e.uniEquipId ?? null } }));
  // the game's own slots keep their pick (`room.diy`); the panel only says which skill / 模组 to carry
  const skills = {};
  if (kitOn) for (const [slotId, idx] of Object.entries(local.diy.skills)) {
    if (Number.isInteger(idx) && known.has(slotBaseId(slotId))) skills[slotBaseId(slotId)] = idx;
  }
  const mods = {};
  if (kitOn) for (const [slotId, id] of Object.entries(local.diy.mods)) {
    if (known.has(slotBaseId(slotId))) mods[slotBaseId(slotId)] = id || null;
  }
  return { slots, extra, skills, mods };
}

function sendDiy() {
  applyDiyCfg();
  net.request(DIY, diyPayload()).catch((e) => console.warn('[luck] 自选位 kit refused', errText(e)));
}

/** Rewrite one slot's config and push the whole thing — the server clamps, nothing here is billed to the budget. */
function editDiy(slotId, patch) {
  const base = slotBaseId(slotId);
  const next = { ...(local.diy.slots[base] || emptyDiyCfg()), ...patch };
  const mode = next.mode === 'add' ? 'add' : next.mode === 'keep' ? 'keep' : 'replace';
  const picked = new Set(mode === 'replace' ? idList(next.bonds) : mode === 'add' ? idList(next.addBonds) : []);
  // the number edits ride the slot's own 盟约 list: a bond the slot no longer names keeps no edit behind (unchecking it
  // then really does put the 盟约 back to its stock numbers)
  const bondBb = {};
  if (isBbObj(next.bondBb)) for (const [id, bb] of Object.entries(next.bondBb)) if (picked.has(id) && isBbObj(bb)) bondBb[id] = { ...bb };
  local.diy.slots[base] = {
    mode,
    bonds: mode === 'replace' ? idList(next.bonds) : null,
    addBonds: mode === 'add' ? idList(next.addBonds) : [],
    garrisons: garList(next.garrisons),
    bondBb,
  };
  saveDiyPrefs();
  sendDiy();
  render(true);
}

/**
 * Turn one 盟约 on/off for a slot, in whatever mode the slot is in right now. It reads the STORED config instead of a
 * render-time snapshot, so sweeping the pointer across several chips never loses a toggle (each repaint would otherwise
 * hand the next chip a stale list). A 跟随干员 slot turns into 替换 on the first one, which is what clicking means too.
 */
function setBondOf(slotId, id, on) {
  const base = slotBaseId(slotId);
  const cur = local.diy.slots[base] || emptyDiyCfg();
  const mode = cur.mode === 'add' ? 'add' : 'replace';
  const list = new Set(idList(mode === 'replace' ? cur.bonds : cur.addBonds));
  if (on) list.add(id); else list.delete(id);
  editDiy(base, mode === 'replace' ? { mode: 'replace', bonds: [...list] } : { mode: 'add', addBonds: [...list] });
}

/** 「用默认」: add the remembered default 盟约s on top of whatever this slot already has (it never removes anything). */
function applyDefaultBonds(slotId) {
  const base = slotBaseId(slotId);
  const cur = local.diy.slots[base] || emptyDiyCfg();
  const mode = cur.mode === 'add' ? 'add' : cur.mode === 'replace' ? 'replace' : 'add';
  const list = new Set(idList(mode === 'replace' ? cur.bonds : cur.addBonds));
  for (const id of local.diy.defaultBonds) list.add(id);
  editDiy(base, mode === 'replace' ? { mode: 'replace', bonds: [...list] } : { mode: 'add', addBonds: [...list] });
}

/** 「新位子默认」: which 盟约 a newly added 自造位子 starts with. */
function toggleDefaultBond(id) {
  const i = local.diy.defaultBonds.indexOf(id);
  if (i >= 0) local.diy.defaultBonds.splice(i, 1); else local.diy.defaultBonds.push(id);
  saveDiyPrefs();
  render(true);
}

/** 「新位子默认」: and which 特质. Added/removed from the default list only, never from a slot. */
function addDefaultGarrison(id) {
  if (!local.diy.defaultGarrisons.includes(id)) local.diy.defaultGarrisons = [...local.diy.defaultGarrisons, id];
  saveDiyPrefs();
  render(true);
}

function removeDefaultGarrison(id) {
  local.diy.defaultGarrisons = local.diy.defaultGarrisons.filter((x) => x !== id);
  saveDiyPrefs();
  render(true);
}

/** 「用默认」 on a slot's 特质 row: add the default 特质s on top of whatever the slot already has (never removes). */
function applyDefaultGarrisons(slotId) {
  const base = slotBaseId(slotId);
  const cur = local.diy.slots[base] || emptyDiyCfg();
  const have = new Set((cur.garrisons || []).map((g) => (typeof g === 'string' ? g : g?.id)));
  const next = [...(cur.garrisons || [])];
  for (const id of local.diy.defaultGarrisons) if (!have.has(id)) next.push({ id });
  editDiy(base, { garrisons: next });
}

/** 还原: forget the slot entirely, so it follows the operator again. */
function resetDiy(slotId) {
  delete local.diy.slots[slotBaseId(slotId)];
  saveDiyPrefs();
  sendDiy();
  render(true);
}

loadDiyPrefs();
applyDiyCfg(); // this tab's own sim follows whatever was remembered, before any match exists

// ---- 更多位子: what this tab has to tell its OWN game about them -----------------------------------------
//
// The game's four slots are fixed in its data; a mod-owned slot is an `isDiy` chess record plus a `diy.slots` entry at
// whatever tier (slot-rules extraDiyData / extraDiyTable). The browser needs them in two places:
//
//   * the DATA STORE (`/js/data.js store`) — the game's own screens read the chess table and `backups.diy` through it
//     (the 自选编队 picker, the shop cards, the detail card, the bond strip's member list). The store object is a plain
//     object literal, so its methods are wrapped here; the game's modules imported the same object, so they see it too.
//   * the SIM's `DataSource` — a 自选 def is composed from `rawChess` / `rawBackups` (server/sim/simdata.js getDiy), so
//     without these two the piece would come out as an unknown chess in this tab's own battles (the server patch wraps
//     the same two).

/** The extra slots as the browser holds them: `{ k, tier }` pairs (the pick is sent separately in diyPayload). */
const extraSlotsNow = () => (enableOn('diyExtra') ? local.diy.extra.map((e) => ({ k: e.k, tier: e.tier })) : []);
let extraGen = -1;
let extraChessCache = null;
let extraTableCache = null;
function bumpExtra() { extraGen += 1; extraChessCache = null; extraTableCache = null; }

// The store's OWN readers, captured before the wrappers below are installed. The wrappers must never go back through
// `data.get` / `data.getRaw`, or a merge for `backups` would re-enter itself.
let storeGet = (name) => data.get(name);
let storeGetRaw = (name) => data.getRaw(name);

/** The chess records the extra slots add here, or null. Memoised until the slots change. */
function extraChess() {
  if (extraChessCache && extraChessCache.gen === extraGen) return extraChessCache.table;
  const extras = extraSlotsNow();
  const cfg = storeGetRaw('config') || storeGet('config');
  const table = extras.length ? (extraDiyData(extras, cfg?.economy)?.chess ?? null) : null;
  extraChessCache = { gen: extraGen, table };
  return table;
}

/** `backups.diy` with the extra slots merged in (prototypes / locked copied per tier), or the original table. */
function extraDiyTableHere() {
  if (extraTableCache && extraTableCache.gen === extraGen) return extraTableCache.table;
  const base = storeGetRaw('backups')?.diy;
  const extras = extraSlotsNow();
  const table = extras.length && base ? extraDiyTable(base, extras) : base;
  extraTableCache = { gen: extraGen, table };
  return table;
}

/** A cheap signature of what the backups merge depends on besides the data itself (the kit and this seat's picks). */
function picksSignature() {
  const picks = store.get()?.match?.private?.diy;
  const ids = picks && typeof picks === 'object'
    ? Object.keys(picks).map((k) => `${k}=${picks[k]?.charId || ''}`).join(',')
    : '';
  return `${extraGen}|${ids}|${JSON.stringify(local.diy.slots)}`;
}

/**
 * The 盟约 each slotted operator should show, for THIS side's own record composition: the game builds a 自选 piece's card
 * from its own data (`ui/gameLogic/diy.js diyRecordOf` reads `backups.diy.operators[charId].bonds`), so without this the
 * detail card would keep showing the operator's original 盟约 while the 盟约栏 (server-computed) shows the configured
 * one. The map is keyed by OPERATOR, so if the same operator sits in two slots with different kits the last one wins.
 * @param {any} diy the merged `backups.diy` table
 */
function slotOperatorBonds(diy) {
  const picks = store.get()?.match?.private?.diy;
  if (!picks || typeof picks !== 'object' || !diy?.operators) return null;
  const tables = slotTables();
  const out = {};
  for (const [slotId, pick] of Object.entries(picks)) {
    const charId = pick?.charId;
    if (!charId) continue;
    const cfg = normalizeSlotCfg(local.diy.slots[slotBaseId(slotId)], tables);
    if (!cfg || cfg.bonds === null) continue;
    const own = diy.operators[charId]?.bonds || [];
    const bonds = [...new Set([...cfg.bonds, ...cfg.addBonds])];
    if (bonds.length === own.length && bonds.every((b, i) => b === own[i])) continue;
    out[charId] = { ...(diy.operators[charId] || {}), bonds };
  }
  return Object.keys(out).length ? out : null;
}

/** Wrap the game's own data store so every reader (the game's screens included) sees the mod's slots. */
function patchDataStore() {
  if (data.__modDiyPatched) return;
  data.__modDiyPatched = true;
  const origGet = data.get;
  const origGetRaw = data.getRaw;
  const origLookup = data.lookup;
  const origList = data.list;
  storeGet = (name) => origGet.call(data, name);
  storeGetRaw = (name) => origGetRaw.call(data, name);
  // Both merges are memoised by (generation, base object): the game reads these tables from its render path, so a fresh
  // object every call would be wasteful — and `ui/gameLogic/diy.js` keys its own record cache BY the backups object, so
  // handing it a new one each time would defeat that cache too.
  let chessMerge = { gen: -1, base: null, out: null };
  const mergeChess = (v) => {
    const ex = extraChess();
    if (!ex || !v || typeof v !== 'object') return v;
    if (chessMerge.gen === extraGen && chessMerge.base === v) return chessMerge.out;
    const out = { ...v, ...ex };
    chessMerge = { gen: extraGen, base: v, out };
    return out;
  };
  let backupsMerge = { gen: -1, base: null, out: null };
  const mergeBackups = (v) => {
    if (!v || typeof v !== 'object') return v;
    const sig = picksSignature();
    if (backupsMerge.gen === extraGen && backupsMerge.base === v && backupsMerge.sig === sig) return backupsMerge.out;
    const diy = extraDiyTableHere();
    const ops = slotOperatorBonds(diy);
    const nextDiy = ops ? { ...diy, operators: { ...(diy?.operators || {}), ...ops } } : diy;
    const out = nextDiy && nextDiy !== v.diy ? { ...v, diy: nextDiy } : v;
    backupsMerge = { gen: extraGen, base: v, sig, out };
    return out;
  };
  data.get = (name) => (name === 'chess' ? mergeChess(origGet.call(data, name))
    : name === 'backups' ? mergeBackups(origGet.call(data, name)) : origGet.call(data, name));
  data.getRaw = (name) => (name === 'chess' ? mergeChess(origGetRaw.call(data, name))
    : name === 'backups' ? mergeBackups(origGetRaw.call(data, name)) : origGetRaw.call(data, name));
  data.lookup = (name, id) => (name === 'chess' ? (extraChess()?.[id] ?? origLookup.call(data, name, id))
    : origLookup.call(data, name, id));
  if (typeof origList === 'function') {
    data.list = (name) => (name === 'chess'
      ? Object.values(mergeChess(origGet.call(data, name)) || {})
      : origList.call(data, name));
  }
  console.info('[luck] data store patched (更多位子)');
}
patchDataStore();

/**
 * A 盟约 whose count does not look at its members at all: 绝技 counts every 精锐 chess on the board
 * (`countMode: BOARD_ALL_CHESS` / the `*_golden` threshold template; its effect lands on every elite regardless of who
 * carries it). Giving one to a piece therefore does nothing — the game's 258 chess records do not carry it either.
 */
const bondIgnoresMembers = (rec) => rec?.countMode === 'BOARD_ALL_CHESS' || rec?.thresholdTemplate === 'count_threshold_upward_golden';

/** The 23 盟约 of the match's data, as chips: the 8 core ones first, then the add-on ones, each with its own name. */
function bondChips() {
  const bonds = data.get('bonds');
  const list = Object.entries(bonds || {}).map(([id, b]) => ({
    id, name: b?.name || id, isCore: !!b?.isCore, ignored: bondIgnoresMembers(b),
  }));
  list.sort((a, b) => (a.ignored - b.ignored) || (b.isCore - a.isCore) || String(a.name).localeCompare(String(b.name), 'zh'));
  return list;
}

/** Every 盟约 that actually does something when a piece carries it (什么 全选 uses). */
const assignableBonds = () => bondChips().filter((b) => !b.ignored).map((b) => b.id);

/** One number box for a `bb` value: empty = 用原值. Unlike the unit page's unitNum this one allows negatives. */
function bbNum(value, onChange, title = '', field = '') {
  return el('input', {
    class: 'spmod-limit', type: 'number', step: 'any', 'data-field': field || null,
    value: value == null ? '' : String(value), title: title || undefined,
    onChange: (e) => {
      const raw = e.currentTarget.value.trim();
      const n = raw === '' ? null : Number(raw);
      const v = raw === '' || !Number.isFinite(n) ? null : n;
      e.currentTarget.value = v == null ? '' : String(v);
      onChange(v);
    },
  });
}

/**
 * One effect's editable numbers: a box per key the RECORD actually carries. That key set is what the installer reads —
 * inventing a key would do nothing, and hiding one would leave the author tuning blind.
 */
function bbEditor(stockBb, patch, onEdit, field) {
  const keys = Object.keys(stockBb || {});
  if (!keys.length) return el('span', { class: 'spmod-hint' }, '这条没有可填的数值');
  return el('div', { class: 'spmod-bbgrid' }, ...keys.map((k) => el('label', {
    class: ['spmod-statfield', patch && patch[k] != null && 'is-on'].filter(Boolean).join(' '),
    title: `${k}（原值 ${stockBb[k]}）`,
  },
    el('span', null, k),
    bbNum(patch ? patch[k] : null, (val) => onEdit(k, val), `留空 = 用原值（${stockBb[k]}）`, `${field}:${k}`),
  )));
}

/** One slot's row: the operator sitting there, its own 盟约, then the kit's 盟约 chips and its 特质 list. */
function diySlotRow(v, slot) {
  const base = slot.slotId;
  const raw = local.diy.slots[base] || null;
  const pick = v.priv?.diy?.[base] || null;
  const pickChar = pick?.charId || null;
  const ops = data.get('backups')?.diy?.operators || {};
  const opName = pick ? (ops[pick.charId]?.name || pick.charId) : null;
  const opBonds = pick ? (ops[pick.charId]?.bonds || []) : [];
  const bondNames = new Map(bondChips().map((b) => [b.id, b.name]));

  const mode = raw?.mode === 'add' ? 'add' : raw?.mode === 'replace' ? 'replace' : 'keep';
  const chosen = new Set(idList(mode === 'replace' ? raw?.bonds : mode === 'add' ? raw?.addBonds : []));

  const isExtra = !!slot.extra;
  const head = el('div', { class: 'spmod-sbrow' },
    el('span', { class: 'spmod-sbtitle' }, isExtra ? `自造位子 ${slot.extra.k}` : `${slot.tier} 阶位 ${base.slice(-6, -2)}`),
    el('span', { class: ['spmod-diywho', !opName && 'is-empty'].filter(Boolean).join(' ') },
      opName ? `${opName}${opBonds.length ? `（${opBonds.map((b) => bondNames.get(b) || b).join('、')}）` : ''}` : '这个位子还空着'),
    isExtra
      ? el('button', {
        class: 'spmod-sbbtn', type: 'button', 'data-diyremove': String(slot.extra.k),
        title: '删掉这个自造位子（它上面的配置也一起删）', onClick: () => removeExtraSlot(slot.extra.k),
      }, '移除')
      : el('span', { class: 'spmod-hint' }, `调度中心 Lv.${slot.shopLevel} 起出现在商店`),
  );

  const modeSeg = el('div', { class: 'spmod-seg' },
    el('button', {
      class: ['spmod-segbtn', mode === 'keep' && 'is-on'].filter(Boolean).join(' '), type: 'button', 'data-mode': 'keep',
      title: '不动干员本来的盟约（没勾过盟约时的默认状态；点下面任意一条就转成「替换」）',
      onClick: () => editDiy(base, { mode: 'keep', bonds: null, addBonds: [] }),
    }, '跟随干员'),
    el('button', {
      class: ['spmod-segbtn', mode === 'replace' && 'is-on'].filter(Boolean).join(' '), type: 'button', 'data-mode': 'replace',
      title: '把干员本来的盟约整个换掉，只算你勾的（一个都不勾 = 一条盟约都没有）',
      onClick: () => editDiy(base, { mode: 'replace', bonds: [...chosen] }),
    }, '替换'),
    el('button', {
      class: ['spmod-segbtn', mode === 'add' && 'is-on'].filter(Boolean).join(' '), type: 'button', 'data-mode': 'add',
      title: '在干员本来那条盟约之外，再加上你勾的（协防干员那条会留着）',
      onClick: () => editDiy(base, { mode: 'add', addBonds: [...chosen] }),
    }, '叠加'),
  );

  const chips = el('div', { class: 'spmod-bondchips' }, ...bondChips().map((b) => el('button', {
    class: ['spmod-bondchip', chosen.has(b.id) && 'is-on', b.ignored && 'is-dead'].filter(Boolean).join(' '),
    type: 'button', 'data-bond': b.id, 'data-slot': base, disabled: b.ignored || null,
    title: b.ignored
      ? `${b.name}：这条盟约数的不是成员（它数的是场上所有精锐的数量），挂给哪一名干员都没有效果，所以点不动`
      : `${b.isCore ? `${b.name}（核心盟约）` : b.name}。点一下勾上／取消；按住往下扫可以连着勾一片`,
    // 拖动连选: mousedown starts the sweep, mouseenter of another chip applies the same value
    onMouseDown: (e) => {
      if (b.ignored) return;
      e.preventDefault(); // no text selection while sweeping
      chipJustPressed = true;
      setTimeout(() => { chipJustPressed = false; }, 0);
      bondDrag = { base, on: !chosen.has(b.id) };
      setBondOf(base, b.id, bondDrag.on);
    },
    onMouseEnter: () => {
      if (b.ignored || !bondDrag || bondDrag.base !== base) return;
      setBondOf(base, b.id, bondDrag.on);
    },
    // a plain click (or a keyboard/programmatic one, which fires no mousedown) toggles just this one
    onClick: () => {
      if (b.ignored || chipJustPressed) return;
      setBondOf(base, b.id, !chosen.has(b.id));
    },
  }, b.name)));

  const clearBtn = el('button', {
    class: 'spmod-sbbtn', type: 'button', 'data-diyreset': base,
    title: '这个位子回到干员本来的盟约、且不带任何特质',
    onClick: () => resetDiy(base),
  }, '还原');

  // `garrisonIds` is the plain id list the chips and the picker work with; `garrisonCfg()` keeps the entries themselves
  // (a 特质 the author gave his own numbers carries a `bb`, and a merge must not drop it).
  const garrisonCfg = Array.isArray(raw?.garrisons) ? raw.garrisons : [];
  const garrisonIds = garrisonCfg.map((g) => (g.id || g));
  const open = local.diy.open === base;
  const table = data.get('garrisons') || {}; // the number editor below reads the stock records from it

  const garrisonBox = el('div', { class: 'spmod-sbsub' },
    el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-sbtitle' }, `特质（${garrisonIds.length}）`),
      el('button', {
        class: 'spmod-sbbtn', type: 'button', 'data-garadd': base,
        title: '给这个位子挂一条特质：别的棋子那套叠层 / 金币 / 价格 / 获得装备 / 和别的棋子配合的效果',
        onClick: () => { local.diy.open = open ? null : base; local.diy.query = ''; render(true); },
      }, open ? '收起' : '＋ 加特质'),
      el('button', {
        class: 'spmod-sbbtn', type: 'button', 'data-garde': base,
        title: `补上「新位子默认」那几条特质（${local.diy.defaultGarrisons.length} 条）`,
        onClick: () => applyDefaultGarrisons(base),
      }, '用默认'),
      el('span', { class: 'spmod-hint' }, '只作用在坐在这个位子上的干员'),
    ),
    garrisonIds.length ? garrisonChips(garrisonCfg, base, (id) => editDiy(base, { garrisons: garrisonCfg.filter((x) => (x.id || x) !== id) })) : null,
    open ? garrisonPicker({ key: base, ids: garrisonIds, onAdd: (id) => editDiy(base, { garrisons: [...garrisonCfg, id] }) }) : null,
  );

  // 携带技能: whichever skill of that operator's the piece fields. The game's own picker only ever offers this inside the
  // 自选编队 screen, and a mod slot is not there, so the panel owns it; for the game's own four slots it overrides the
  // skill the pick already carries (the server re-composes that slot's record around it).
  const composedSkill = (pick && Number.isInteger(pick.skillIndex)) ? pick.skillIndex : null;
  const curSkill = isExtra ? (slot.extra.skillIndex ?? null) : slotSkillIndex(base, composedSkill);
  const skillList = pickChar && !isProtoChar(pickChar) ? diySkillChoices(pickChar) : [];
  const skillRow = el('div', { class: 'spmod-sbrow' },
    el('span', { class: 'spmod-sbtitle' }, '携带技能'),
    el('select', {
      class: 'spmod-prof', 'data-diyskill': base, disabled: skillList.length ? null : true,
      title: skillList.length ? '这一名在这个位子上带哪个技能' : '原型干员的技能是数据里定的，改不了',
      onChange: (e) => {
        const v = e.currentTarget.value;
        if (isExtra) editExtra(slot.extra.k, { skillIndex: v === '' ? null : Number(v) });
        else setSlotSkill(base, v === '' ? null : Number(v));
      },
    },
      ...(skillList.length
        ? skillList.map((s) => el('option', { value: String(s.index), selected: curSkill === s.index }, `S${s.index + 1} ${s.name}`))
        : [el('option', { value: '' }, pickChar ? '原型干员（技能固定）' : '先挑一名干员')]),
    ),
    el('span', { class: 'spmod-hint' },
      skillList.length
        ? (curSkill == null ? '现在跟的是它在自选编队里选的那个' : `这一名带 S${curSkill + 1}`)
        : ''),
  );

  // 模组: the same idea as 携带技能. Modules only exist on the ELITE form (an E2 Lv60 piece), so a normal-form piece
  // carries the slot's record but the module stays inactive — exactly like a normal chess.
  const composedMod = (pick && typeof pick.uniEquipId === 'string') ? pick.uniEquipId : null;
  const curMod = isExtra
    ? (slot.extra.uniEquipId ?? null)
    : (Object.prototype.hasOwnProperty.call(local.diy.mods, base) ? local.diy.mods[base] : composedMod);
  const modList = pickChar && !isProtoChar(pickChar) ? diyModuleChoices(pickChar, base) : [];
  const modRow = el('div', { class: 'spmod-sbrow' },
    el('span', { class: 'spmod-sbtitle' }, '模组'),
    el('select', {
      class: 'spmod-prof', 'data-diymod': base, disabled: modList.length ? null : true,
      title: modList.length ? '这一名在这个位子上带哪个模组（精锐形态才生效）' : '这一名没有可用的模组',
      onChange: (e) => {
        const v = e.currentTarget.value;
        if (isExtra) editExtra(slot.extra.k, { uniEquipId: v === '' ? null : v });
        else setSlotModule(base, v === '' ? null : v);
      },
    },
      el('option', { value: '', selected: !curMod }, '不带模组'),
      ...modList.map((m) => el('option', { value: m.id, selected: curMod === m.id }, `${m.name}${m.type ? `（${m.type}）` : ''}`)),
    ),
    el('span', { class: 'spmod-hint' },
      modList.length ? (curMod ? '只在精锐形态生效' : '现在不带模组') : (pickChar ? '这一名没有可用的模组' : '先挑一名干员')),
  );

  // a mod-owned slot also picks its own TIER and its own operator (the game's 自选编队 screen only knows its own four
  // slots, and `diyPool` is DIY_TIERS-gated, so the panel is the only place these can be chosen)
  const pickOpen = isExtra && local.diy.pickFor === base;
  const pq = (local.diy.pickQuery || '').trim().toLowerCase();
  const pool = isExtra && pickOpen
    ? diyOperatorPool().filter((o) => !pq || String(o.name || '').toLowerCase().includes(pq) || String(o.appellation || '').toLowerCase().includes(pq))
    : [];
  const extraBox = isExtra ? el('div', { class: 'spmod-sbsub' },
    el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-sbtitle' }, '阶位'),
      el('select', {
        class: 'spmod-prof', 'data-diytier': String(slot.extra.k),
        title: '这个位子本身是几阶：价格、调度中心门槛、库存都按它算（能放的干员不变）',
        onChange: (e) => editExtra(slot.extra.k, { tier: Number(e.currentTarget.value) }),
      }, ...EXTRA_TIERS.map((t) => el('option', { value: String(t), selected: slot.extra.tier === t }, `${t} 阶`))),
      el('button', {
        class: 'spmod-sbbtn', type: 'button', 'data-diypick': base,
        title: '挑一名干员放进这个位子（预备干员或你持有的 6★）',
        onClick: () => { local.diy.pickFor = pickOpen ? null : base; local.diy.pickQuery = ''; render(true); },
      }, pickOpen ? '收起' : '选干员'),
      el('span', { class: 'spmod-hint' }, '自造的位子：阶位随便挑，商店按它刷出来'),
    ),
    pickOpen ? el('div', { class: 'spmod-sbsub' },
      el('input', {
        class: 'spmod-search', type: 'search', placeholder: '搜索干员…', value: local.diy.pickQuery || '', autocomplete: 'off',
        'data-diypickquery': base,
        onInput: (e) => { local.diy.pickQuery = e.currentTarget.value; render(true); },
      }),
      el('div', { class: 'spmod-units' }, ...pool.slice(0, 400).map((o) => el('button', {
        class: ['spmod-unit', slot.extra.charId === o.id && 'is-on'].filter(Boolean).join(' '),
        type: 'button', 'data-diyop': o.id, 'data-slot': base,
        title: `${o.name || o.id}${o.isProto ? ' · 原型干员（技能固定）' : ''}`,
        onClick: () => {
          // the same defaults the game's own 自选编队 picker starts an owned operator on: the LAST skill and the FIRST
          // module (ui/diyModel.js defaultPick). A 原型干员 has neither — its skill and module are fixed by the data.
          const skills = o.isProto ? [] : diySkillChoices(o.id);
          const mods = o.isProto ? [] : diyModuleChoices(o.id, extraSlotId(slot.extra.k, false));
          editExtra(slot.extra.k, {
            charId: o.id,
            skillIndex: o.isProto ? null : (skills[skills.length - 1]?.index ?? null),
            uniEquipId: o.isProto ? null : (mods[0]?.id ?? null),
          });
        },
      },
        el('span', { class: 'spmod-unitname' }, o.name || o.id),
        el('i', { class: 'spmod-unittier' }, o.isProto ? '原型' : '6★'),
      ))),
      pool.length ? null : el('span', { class: 'spmod-hint' }, '没有匹配的干员'),
    ) : null,
  ) : null;

  // 数值: one editable block per effect actually on this slot. 特质 numbers are per slot (a minted record); a 盟约's
  // numbers are shared by every one of its members in the match, because the game has a single record per bond id — the
  // hint says so, and slot-rules takes the first slot in data order when two of them edit the same 盟约.
  const numOpen = local.diy.numberFor === base;
  const hasEffects = chosen.size > 0 || garrisonIds.length > 0;
  const numBox = numOpen ? el('div', { class: 'spmod-sbsub' },
    el('span', { class: 'spmod-hint' },
      '盟约的数值整场共用一条：同一条盟约的改动会落在场上每一个带它的干员身上，两个位子改同一条时以先勾的那个为准。特质是每个位子各一份，互不影响。留空 = 用原值。'),
    ...[...chosen].map((bondId) => {
      const rec = data.get('bonds')?.[bondId];
      return el('div', { class: 'spmod-bbsection', 'data-bb': `bond:${bondId}` },
        el('div', { class: 'spmod-sbtitle' }, `盟约 · ${rec?.name || bondId}`),
        bbEditor(rec?.bb, raw?.bondBb?.[bondId], (k, val) => {
          const bb = setBb(raw?.bondBb?.[bondId], k, val);
          const next = { ...(raw?.bondBb || {}) };
          if (bb) next[bondId] = bb; else delete next[bondId];
          editDiy(base, { bondBb: next });
        }, bondId),
      );
    }),
    ...garrisonIds.map((gid) => {
      const entry = (raw?.garrisons || []).find((g) => g.id === gid) || { id: gid };
      const rec = table[gid];
      return el('div', { class: 'spmod-bbsection', 'data-bb': `garrison:${gid}` },
        el('div', { class: 'spmod-sbtitle' }, `特质 · ${GAR_EVENT[rec?.eventType] || rec?.eventType || gid}`),
        bbEditor(rec?.bb, entry.bb, (k, val) => {
          const bb = setBb(entry.bb, k, val);
          editDiy(base, { garrisons: (raw?.garrisons || []).map((g) => (g.id === gid ? (bb ? { id: gid, bb } : { id: gid }) : g)) });
        }, gid),
      );
    }),
    hasEffects ? null : el('span', { class: 'spmod-hint' }, '先勾一条盟约或加一条特质，再来填数值'),
  ) : null;

  return el('div', { class: 'spmod-sbsection spmod-diyslot', 'data-slot': base },
    head,
    extraBox,
    skillRow,
    modRow,
    el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-sbtitle' }, '盟约'), modeSeg, clearBtn,
      el('button', {
        class: 'spmod-sbbtn', type: 'button', 'data-diynum': base,
        title: '给挂上去的盟约 / 特质填数值（留空 = 用原值）',
        onClick: () => { local.diy.numberFor = numOpen ? null : base; render(true); },
      }, numOpen ? '收起数值' : '数值')),
    el('div', { class: 'spmod-sbrow' },
      el('span', { class: 'spmod-hint' }, '点一条勾上；按住往下扫可以连着勾一片'),
      el('div', { class: 'spmod-seg' },
        el('button', {
          class: 'spmod-segbtn', type: 'button', 'data-bondall': base,
          title: '把能生效的盟约全勾上（「绝技」不数成员，不在里面）',
          onClick: () => editDiy(base, mode === 'add' ? { mode: 'add', addBonds: assignableBonds() } : { mode: 'replace', bonds: assignableBonds() }),
        }, '全选'),
        el('button', {
          class: 'spmod-segbtn', type: 'button', 'data-bondnone': base,
          title: '这个位子的盟约全清（「替换」成一个都不勾）',
          onClick: () => editDiy(base, { mode: 'replace', bonds: [] }),
        }, '清空'),
        el('button', {
          class: 'spmod-segbtn', type: 'button', 'data-bonddef': base,
          title: `补上「新位子默认」那几条：${local.diy.defaultBonds.map((id) => bondNames.get(id) || id).join('、') || '（还没设）'}`,
          onClick: () => applyDefaultBonds(base),
        }, '用默认'),
      )),
    chips,
    numBox,
    garrisonBox,
  );
}

function drawDiyPage(v) {
  const slots = allSlots();
  const extraRows = local.diy.extra.map((e) => ({ slotId: extraSlotId(e.k, false), tier: e.tier, shopLevel: e.tier, extra: e }));
  const openDef = local.diy.open === 'default';
  // the 自选位 kit (盟约 / 特质 / 数值) is the `diy` group; the 自造位子 are the `diyExtra` group. When a switch is off
  // its section is replaced by a note, so a group the server rolled back never sits there looking usable.
  const kit = enableOn('diy') ? [
    el('div', { class: 'spmod-sbsection' },
      el('div', { class: 'spmod-sbtitle' }, '自选位'),
      el('span', { class: 'spmod-hint' },
        '点盟约给这个位子配上（可多选）；「替换」是只算你勾的，「叠加」是在干员本来的盟约之上再加。谁坐在这个位子上谁就吃这一套，换人不变。'),
    ),
    ...(slots.length ? slots.map((s) => diySlotRow(v, s)) : [el('p', { class: 'spmod-empty' }, '这局的数据里没有自选位。')]),
  ] : [offNote('自选位 · 盟约 / 特质 / 数值')];
  const extras = enableOn('diyExtra') ? [
    el('div', { class: 'spmod-sbsection' },
      el('div', { class: 'spmod-sbrow' },
        el('span', { class: 'spmod-sbtitle' }, `自造位子（${extraRows.length}）`),
        el('button', {
          class: 'spmod-sbbtn', type: 'button', 'data-diyadd': '1',
          title: `自己加一个自选位，阶位 1 到 6 随便挑（最多 ${MAX_EXTRA_SLOTS} 个）`,
          onClick: () => addExtraSlot(),
        }, '＋ 加一个位子'),
        el('span', { class: 'spmod-hint' }, '能放的干员还是那 88 名；位子的阶决定价格、商店门槛和库存'),
      ),
      el('div', { class: 'spmod-sbrow' },
        el('span', { class: 'spmod-sbtitle' }, '新位子默认带上'),
        el('span', { class: 'spmod-hint' }, '加一个自造位子时自动勾上这几条（「用默认」也补它们）；调和的意思是「它算所有核心盟约的成员」'),
      ),
      el('div', { class: 'spmod-bondchips' }, ...bondChips().filter((b) => !b.ignored).map((b) => el('button', {
        class: ['spmod-bondchip', local.diy.defaultBonds.includes(b.id) && 'is-on'].filter(Boolean).join(' '),
        type: 'button', 'data-defbond': b.id, 'data-slot': 'default',
        title: `新加的自造位子默认带上「${b.name}」`,
        onClick: () => toggleDefaultBond(b.id),
      }, b.name))),
      el('div', { class: 'spmod-sbrow' },
        el('span', { class: 'spmod-sbtitle' }, '特质默认'),
        el('button', {
          class: 'spmod-sbbtn', type: 'button', 'data-defgaradd': 'default',
          title: '给「新位子默认」挑几条特质：以后加的自造位子自动带上，任何位子也能点「用默认」补上',
          onClick: () => { local.diy.open = openDef ? null : 'default'; local.diy.query = ''; render(true); },
        }, openDef ? '收起' : '＋ 加特质'),
        el('span', { class: 'spmod-hint' }, local.diy.defaultGarrisons.length ? `现在 ${local.diy.defaultGarrisons.length} 条` : '还没设（可选）'),
      ),
      local.diy.defaultGarrisons.length
        ? garrisonChips(local.diy.defaultGarrisons.map((id) => ({ id })), 'default', removeDefaultGarrison)
        : null,
      openDef ? garrisonPicker({ key: 'default', ids: local.diy.defaultGarrisons, onAdd: addDefaultGarrison }) : null,
      extraRows.length ? null : el('span', { class: 'spmod-hint' }, '还没有自造位子。加一个，挑好阶位和干员就行。'),
    ),
    ...extraRows.map((s) => diySlotRow(v, s)),
  ] : [offNote('自选位 · 自造位子')];
  panel.append(el('div', { class: 'spmod-body spmod-sbbody' }, ...kit, ...extras));
}

let diyPushedFor = null;
/** Push the remembered kit once per match, the way the sandbox's strategies and the unit rules are pushed. */
function renderDiy() {
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  if (!pub) return;
  applyDiyCfg(); // the sim half follows the panel live, whatever the server holds
  if (pub.phase === 'LOBBY' || !priv) { diyPushedFor = null; return; }
  if (!(!!priv.shop?.modPickable || Number.isFinite(Number(priv.modSpeed)))) return;
  const key = `${pub.stageId || ''}|${pub.modeId || ''}`;
  if (diyPushedFor === key) return;
  diyPushedFor = key;
  sendDiy();
}

// ---- the master switches (总开关) ----------------------------------------------------------------------
//
// One switch per GROUP of gameplay-changing features, in the server's own order (server-patch.mjs FEATURE_KEYS). The
// SERVER is what acts on them: it refuses that group's intents AND takes back what is already in effect, so a switch
// really means "this group does not exist", not "the panel stopped sending". This page keeps its own memory (browser
// storage) and pushes it once per match, the way the sandbox strategies and the unit rules do.
//
// 倍速 and 自动倒转 are deliberately NOT here. Neither changes the simulation, so they stay available whatever these
// switches say: every switch off is「原版规则，但快，而且自动买卖」, which is the mode the author asked for.

const ENABLE = 'g.modEnable';
const ENABLE_KEY = 'spmod.enable';
/** [key, label, hint] — the keys are exactly the server's. */
const FEATURES = [
  ['shop', '自选商店 / 直购 / 额度', '把要的干员填进槽位、直接买到手上，以及每回合能用几次。'],
  ['sandboxBands', '沙盒 · 策略叠加', '一局里同时挂多个策略。'],
  ['sandboxPlace', '沙盒 · 地块解锁', '解除布置限制、近战可上高台，以及布阵上限。'],
  ['sandboxUnit', '沙盒 · 单位', '改干员的技能、技力与属性。'],
  ['diy', '自选位 · 盟约 / 特质 / 数值', '给自选编队的位子配盟约、特质与数值。'],
  ['diyExtra', '自选位 · 自造位子', '自己造位子（1 到 6 阶）。'],
  ['shopFilter', '阵营锁', '商店只刷所选盟约的干员：盟约可多选；包含＝带所选任一条即留（并集），仅限＝盟约全在所选内才留（子集）。'],
];
if (!Object.hasOwn(C2S, ENABLE)) {
  C2S[ENABLE] = { features: (v) => !!v && typeof v === 'object' && !Array.isArray(v) && Object.values(v).every((x) => typeof x === 'boolean') };
}
local.enable = Object.fromEntries(FEATURES.map(([k]) => [k, true]));
try {
  const saved = JSON.parse(localStorage.getItem(ENABLE_KEY) || 'null');
  if (saved && typeof saved === 'object') for (const [k] of FEATURES) if (typeof saved[k] === 'boolean') local.enable[k] = saved[k];
} catch { /* ignore */ }

function saveEnable() {
  try { localStorage.setItem(ENABLE_KEY, JSON.stringify(local.enable)); } catch { /* ignore */ }
}
function sendEnable() {
  net.request(ENABLE, { features: { ...local.enable } }).catch((e) => console.warn('[luck] enable refused', errText(e)));
}
function allOff() { return FEATURES.every(([k]) => !local.enable[k]); }
function anyOff() { return FEATURES.some(([k]) => !local.enable[k]); }
/** After a switch flips: drop the 自造位子 caches and re-adopt the sim halves this tab runs itself. */
function applySwitches() {
  bumpExtra();
  applyDiyCfg();
  applyUnitCfg();
}
function setEnable(k, on) {
  local.enable[k] = !!on;
  saveEnable();
  sendEnable();
  applySwitches();
  render(true);
}
function setAllEnable(on) {
  for (const [k] of FEATURES) local.enable[k] = !!on;
  saveEnable();
  sendEnable();
  applySwitches();
  render(true);
}

let enablePushedFor = null;
/** Push the remembered switches once per match. The server keeps them for the whole process, so this is a re-sync
 *  rather than the only source of truth — but it has to run even when this page is not open. */
function renderEnable() {
  const st = store.get()?.match;
  const priv = st?.private;
  const pub = st?.public;
  if (!pub) return;
  if (pub.phase === 'LOBBY' || !priv) { enablePushedFor = null; return; }
  if (!(!!priv.shop?.modPickable || Number.isFinite(Number(priv.modSpeed)))) return;
  const key = `${pub.stageId || ''}|${pub.modeId || ''}`;
  if (enablePushedFor === key) return;
  enablePushedFor = key;
  sendEnable();
}

function drawEnablePage(v) {
  const row = ([k, label, hint]) => {
    const box = el('input', { type: 'checkbox' });
    if (local.enable[k]) box.setAttribute('checked', '');
    box.addEventListener('change', (e) => setEnable(k, e.currentTarget.checked));
    // the group key rides on the ROW (the label), which is what a test or a bookmarklet addresses it by
    return el('label', { class: 'spmod-enablerow', 'data-enable': k, title: hint }, box,
      el('span', { class: 'spmod-enablelabel' }, label),
      el('span', { class: 'spmod-hint' }, hint));
  };
  panel.append(el('div', { class: 'spmod-body spmod-sbbody' },
    el('div', { class: 'spmod-sbsection' },
      el('div', { class: 'spmod-sbtitle' }, '总开关'),
      el('span', { class: 'spmod-hint' },
        '关掉哪一项，那一项就整个不存在：服务端不再接受它的设置，还会把已经生效的部分撤回去（已经改过的自选位、叠上的策略、解锁的地块都会收回）。'),
    ),
    el('div', { class: 'spmod-sbsection' },
      el('div', { class: 'spmod-sbrow' },
        el('button', { class: 'spmod-sbbtn', type: 'button', title: '全部关掉：只剩倍速与自动倒转，其余按原版规则来', onClick: () => setAllEnable(false) }, '全部关掉'),
        el('button', { class: 'spmod-sbbtn', type: 'button', title: '全部打开', onClick: () => setAllEnable(true) }, '全部打开'),
        el('span', { class: 'spmod-hint' }, allOff() ? '现在是原版规则（＋倍速、自动倒转）' : '有开关是开着的'),
      ),
    ),
    ...FEATURES.map(row),
    el('p', { class: 'spmod-hint' }, '开关记在这台机器的浏览器里，每局开始时推一次给服务端。'),
  ));
}

// ---- state --------------------------------------------------------------------------------------------

function view() {
  const priv = store.get()?.match?.private;
  const pub = store.get()?.match?.public;
  const pick = priv?.shop?.modPickable;
  if (!priv || !pick || !Array.isArray(pick.chess)) return null;
  return { priv, pub, pick, shop: priv.shop, slots: Array.isArray(priv.shop.slots) ? priv.shop.slots : [] };
}

/** This round's budget: limit 0 = 不限. */
function quotaOf(v) {
  const q = v?.pick?.quota;
  const limit = Number.isInteger(q?.limit) ? q.limit : 0;
  const used = Number.isInteger(q?.used) ? q.used : 0;
  const unlimited = limit <= 0;
  return { used, limit, unlimited, left: unlimited ? Infinity : Math.max(0, limit - used) };
}

function signature(v) {
  if (!v) return 'none';
  const slots = v.slots.map((s) => (s ? `${s.id}${s.sold ? '!' : ''}` : '-')).join(',');
  const q = quotaOf(v);
  // the 阵营锁 rides along: its admitted count is the server's, so a redraw is needed when that echo changes
  const sf = v.shop?.modShopFilter;
  // and so does the 自选位 kit's own echo: which operator sits in each slot (the 自选位 page names it, the 携带技能
  // dropdown is built from it) and what the server holds for the slots. Without this the page keeps whatever it drew
  // before the reply landed, which reads exactly like "the setting did nothing".
  const diyEcho = Object.entries(v.priv?.diy || {})
    .map(([slotId, p]) => `${slotId}:${p?.charId || ''}:${p?.skillIndex ?? ''}`).sort().join(',');
  const cfgEcho = Object.keys(v.priv?.modDiy?.slots || {}).sort().join(',');
  const expEcho = (v.priv?.modDiy?.extra || []).map((e) => `${e.k}:${e.pick?.charId || ''}:${e.pick?.skillIndex ?? ''}`).join(',');
  return [v.shop.level, v.priv.funds, v.pick.chess.length, v.pick.item.length, slots,
    local.tab, local.query, local.prof, local.open, local.mode, q.used, q.limit,
    local.filter.on ? 1 : 0, local.filter.bonds.join(','), local.filter.mode, sf?.count ?? '', diyEcho, cfgEcho, expEcho].join('|');
}

let lastSig = null;
let pushedLimit = null;
let filterPushedFor = null;
function render(force = false) {
  const v = view();
  if (!v) { root.hidden = true; lastSig = null; return; }
  root.hidden = false;
  clampBar(fab, FAB_POS_KEY); // the entry button too: it is only measured once the root is on screen
  // push the remembered budget once, so a value set in a previous session survives a page reload
  if (local.limit != null) {
    const server = v.pick.quota?.limit;
    if (local.limit !== server && local.limit !== pushedLimit) {
      pushedLimit = local.limit;
      net.request(CONFIG, { pickLimit: local.limit }).catch(() => { pushedLimit = null; });
    }
  }
  // the 阵营锁 is per-seat (`ps.modShopFilter`) and resets with every match, so the remembered set is pushed once per
  // match — the match key covers a brand-new match, and "server empty but we are not" covers the rest
  const sf = v.shop?.modShopFilter;
  if (sf) {
    const key = `${v.pub?.stageId || ''}|${v.pub?.modeId || ''}`;
    const localEmpty = !local.filter.on && local.filter.bonds.length === 0;
    const serverEmpty = !sf.on && (!Array.isArray(sf.bonds) || sf.bonds.length === 0);
    if ((filterPushedFor !== key || (serverEmpty && !localEmpty)) && !localEmpty) {
      filterPushedFor = key;
      const mine = JSON.stringify({ on: !!local.filter.on, bonds: local.filter.bonds, mode: local.filter.mode });
      const server = JSON.stringify({ on: !!sf.on, bonds: Array.isArray(sf.bonds) ? sf.bonds : [], mode: sf.mode ?? 'only' });
      if (mine !== server) net.request(SHOPFILTER, { on: local.filter.on, bonds: local.filter.bonds, mode: local.filter.mode }).catch(() => { filterPushedFor = null; });
    }
  }
  const sig = signature(v);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  if (local.tab >= Math.max(v.slots.length, (v.pick.chessSlots || 0) + (v.pick.itemSlots || 0))) local.tab = 0;
  if (local.open === false) { clear(panel); return; }
  drawKept(v);
}

/**
 * The panel is thrown away and rebuilt on every draw (`clear(panel)`), so its inner scroller would snap back to the top
 * on every click and on every server push. Carry the offset across the rebuild instead: the author reads a long page
 * (自选位 is the longest) and one tap must not lose his place. Switching PAGES starts at the top, since the content
 * below is entirely different.
 */
let drawnPage = null;
function drawKept(v) {
  const body = panel.querySelector('.spmod-body');
  const keep = local.page === drawnPage && body ? { top: body.scrollTop, left: body.scrollLeft } : null;
  drawnPage = local.page;
  drawPanel(v);
  if (!keep || (!keep.top && !keep.left)) return;
  const next = panel.querySelector('.spmod-body');
  if (next) { next.scrollTop = keep.top; next.scrollLeft = keep.left; }
}

/** One panel never takes the others down with it: a throw in any of the three leaves the other two working. */
const safely = (what, fn) => { try { fn(); } catch (e) { console.error(`[luck] ${what} failed`, e); } };
store.subscribe(() => { safely('render', render); safely('speed', renderSpeed); safely('auto', renderAuto); safely('sandbox', renderSandbox); safely('units', renderUnits); safely('diy', renderDiy); safely('enable', renderEnable); });
data.subscribe(() => { lastSig = null; safely('render', () => render(true)); safely('speed', renderSpeed); safely('auto', renderAuto); safely('sandbox', renderSandbox); safely('units', renderUnits); safely('diy', renderDiy); safely('enable', renderEnable); });

// ---- panel --------------------------------------------------------------------------------------------

function drawPanel(v) {
  clear(panel);
  const q = quotaOf(v);
  curQuota = q;

  const head = el('div', { class: 'spmod-head' },
    el('span', { class: 'spmod-title' }, local.page === 'sandbox' ? '沙盒' : local.page === 'diy' ? '自选位' : local.page === 'enable' ? '总开关' : '自选商店'),
    el('span', { class: 'spmod-stat' }, `调度中心 Lv.${v.shop.level} · 资金 ${v.priv.funds}`),
    el('div', { class: 'spmod-headright' },
      el('div', { class: 'spmod-seg' },
        el('button', {
          class: ['spmod-segbtn', local.page === 'shop' && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: '自选商店：挑干员进槽位或直购',
          onClick: () => { local.page = 'shop'; render(true); },
        }, '商店'),
        el('button', {
          class: ['spmod-segbtn', local.page === 'sandbox' && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: '沙盒：多选策略、解锁布置地块',
          onClick: () => { local.page = 'sandbox'; render(true); },
        }, '沙盒'),
        el('button', {
          class: ['spmod-segbtn', local.page === 'diy' && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: '自选位：给每个自选编队位子配盟约与特质',
          onClick: () => { local.page = 'diy'; render(true); },
        }, '自选位'),
        el('button', {
          class: ['spmod-segbtn', local.page === 'enable' && 'is-on', anyOff() && 'is-off'].filter(Boolean).join(' '), type: 'button',
          title: '总开关：一格一格关掉修改功能。全关只剩倍速与自动倒转',
          onClick: () => { local.page = 'enable'; render(true); },
        }, '开关'),
      ),
      el('div', { class: 'spmod-seg' },
        el('button', {
          class: ['spmod-segbtn', local.view === 'name' && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: '只列名字：一行一个，列表长的时候看得清',
          onClick: () => setView('name'),
        }, '名字'),
        el('button', {
          class: ['spmod-segbtn', local.view === 'art' && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: '显示立绘（按立绘原本的 1:2 比例，不再裁成一条额头）',
          onClick: () => setView('art'),
        }, '立绘'),
      ),
      el('div', { class: 'spmod-sizes' },
        el('span', null, '大小'),
        ...SIZE_PRESETS.map(([label], i) => el('button', {
          class: ['spmod-sizebtn', i === presetOf() && 'is-on'].filter(Boolean).join(' '), type: 'button',
          title: `${label}（也可以拖右下角自己定）`,
          onClick: () => setSize(SIZE_PRESETS[i][1], SIZE_PRESETS[i][2]),
        }, label)),
      ),
      el('button', {
        class: 'spmod-sizebtn', type: 'button',
        title: '把「自选」按钮、倍速条、自动倒转条放回默认位置（拖到屏幕外时点这个）',
        onClick: resetPositions,
      }, '复位'),
      el('button', { class: 'spmod-close', type: 'button', title: '关闭 (Esc)', onClick: () => setOpen(false) }, '×'),
    ),
  );

  if (local.page === 'sandbox') {
    panel.append(head);
    drawSandboxPage(v);
    panel.append(el('div', { class: 'spmod-flash', id: 'spmod-flash' }));
    panel.append(grip);
    return;
  }
  if (local.page === 'diy') {
    panel.append(head);
    drawDiyPage(v);
    panel.append(el('div', { class: 'spmod-flash', id: 'spmod-flash' }));
    panel.append(grip);
    return;
  }
  if (local.page === 'enable') {
    panel.append(head);
    drawEnablePage(v);
    panel.append(el('div', { class: 'spmod-flash', id: 'spmod-flash' }));
    panel.append(grip);
    return;
  }

  const tabs = el('div', { class: 'spmod-tabs' });
  const total = Math.max(v.slots.length, (v.pick.chessSlots || 0) + (v.pick.itemSlots || 0));
  for (let i = 0; i < total; i++) {
    const isItem = i >= v.pick.chessSlots;
    const slot = v.slots[i] ?? null;
    const label = isItem ? '装备' : `槽位 ${i + 1}`;
    // a slot holding one of the player's own 自选 pieces shows the operator they picked, not the raw slot id
    const cur = slot ? (isItem ? (data.lookup('items', slot.id)?.name || slot.id) : chessName(v, slot.id)) : '空';
    const cls = ['spmod-tab', i === local.tab && 'is-on', slot?.sold && 'is-sold', !slot && 'is-blank'].filter(Boolean).join(' ');
    tabs.append(el('button', {
      class: cls, type: 'button', disabled: !!slot?.sold,
      title: slot?.sold ? '该槽位已售出，刷新后可再选' : cur,
      onClick: () => { local.tab = i; local.query = ''; render(true); },
    }, el('b', null, label), el('span', null, slot?.sold ? '已售出' : cur)));
  }

  panel.append(head);
  // the shop page is the `shop` group (挑干员进槽位 / 直购 / 额度); the 阵营锁 row under it is `shopFilter`
  if (enableOn('shop')) {
    panel.append(tabs, toolbar(v, q));
    if (enableOn('shopFilter')) {
      const sfRow = shopFilterRow(v);
      if (sfRow) panel.append(sfRow);
    } else {
      panel.append(offNote('阵营锁'));
    }
    const isItem = local.tab >= v.pick.chessSlots;
    if (isItem) drawItemPicker(v);
    else drawChessPicker(v);
  } else {
    panel.append(offNote('自选商店 / 直购 / 额度'));
  }

  panel.append(el('div', { class: 'spmod-flash', id: 'spmod-flash' }));
  panel.append(grip); // every draw starts from an empty panel (`clear`), so the drag grip is put back last, on top
}

/** Mode switch (放入槽位 / 直购) + the shared per-round budget, both live. */
function toolbar(v, q) {
  const seg = el('div', { class: 'spmod-seg' },
    el('button', {
      class: ['spmod-segbtn', local.mode === 'slot' && 'is-on'].filter(Boolean).join(' '), type: 'button',
      title: '点卡片 → 把它放进当前槽位，再回原版商店栏买走',
      onClick: () => { local.mode = 'slot'; render(true); },
    }, '放入槽位'),
    el('button', {
      class: ['spmod-segbtn', local.mode === 'buy' && 'is-on'].filter(Boolean).join(' '), type: 'button',
      title: '点卡片 → 直接买进手牌，不占槽位、不用刷新',
      onClick: () => { local.mode = 'buy'; render(true); },
    }, '直购'),
  );

  const input = el('input', {
    class: 'spmod-limit', type: 'number', min: '0', max: '99', step: '1',
    value: String(q.limit), title: '每回合「放入槽位 + 直购」共用、且只算干员的次数上限（装备不占），0 = 不限',
    onChange: (e) => {
      const n = Math.max(0, Math.min(99, Math.trunc(Number(e.currentTarget.value) || 0)));
      local.limit = n;
      try { localStorage.setItem(LIMIT_KEY, String(n)); } catch { /* ignore */ }
      sendLimit(n);
    },
  });

  const quotaText = q.unlimited ? `本回合不限（已用 ${q.used}）` : `本回合剩 ${q.left}/${q.limit}（装备不占）`;
  return el('div', { class: 'spmod-toolbar' },
    seg,
    el('label', { class: 'spmod-limitwrap' }, el('span', null, '每回合上限'), input),
    el('span', { class: ['spmod-quota', !q.unlimited && q.left === 0 && 'is-out'].filter(Boolean).join(' ') }, quotaText),
  );
}

function flash(text, ok = false) {
  const node = panel.querySelector('.spmod-flash');
  if (!node) return;
  node.textContent = text || '';
  node.classList.toggle('is-ok', ok);
  if (flashTimer) clearTimeout(flashTimer);
  if (text) flashTimer = setTimeout(() => { node.textContent = ''; }, 4000);
}

function send(slot, id) {
  net.request(PICK, { slot, id }).then(
    () => flash('已放入商店', true),
    (e) => flash(errText(e)),
  );
}

function sendBuy(id) {
  net.request(BUY, { id }).then(
    () => flash('已直购', true),
    (e) => flash(errText(e)),
  );
}

function sendLimit(n) {
  net.request(CONFIG, { pickLimit: n }).then(
    () => flash(n > 0 ? `每回合上限已改为 ${n}` : '每回合已改为不限', true),
    (e) => flash(errText(e)),
  );
}

/**
 * Card click: fill the tab's slot, or buy straight to hand — whichever mode is on.
 *
 * 装备 does not cost a pick (the server bills 干员 only), so it is neither gated on the budget here nor refused once the
 * budget is spent. `entry.item` is set by the item picker.
 */
function cardAction(entry) {
  return () => {
    if (entry && entry.ok === false) {
      flash(`「${entry.rec.name}」是自选干员，调度中心到 Lv.${entry.need} 才会出现在商店里`);
      return;
    }
    if (!entry.item && !curQuota.unlimited && curQuota.left <= 0) {
      flash('本回合次数已用完（点上面「每回合上限」可调高；装备不占额度）');
      return;
    }
    if (local.mode === 'buy') sendBuy(entry.id);
    else send(local.tab, entry.id);
  };
}

/** What to call a chess id: a 自选 slot has no name of its own, so it shows the operator this seat slotted in it. */
function chessName(v, id) {
  const c = data.lookup('chess', id);
  if (!c) return id;
  if (c.isDiy) {
    const rec = ownDiyRecord(c, v.priv, { chess: data.get('chess'), backups: data.get('backups') });
    if (rec && rec.name) return rec.name;
  }
  return c.name || id;
}

/**
 * Everything the operator picker may show: the preset chess the server offers at this level, then this seat's own 自选
 * 编队 pieces. A 自选 slot has no body of its own — its record is composed from the player's pick (ui/gameLogic/diy.js
 * ownDiyRecord: name, art, class, the pick's skill and module) — and it carries the slot's own 调度中心 gate, so a
 * piece whose level has not come yet is listed greyed rather than hidden: the operator you chose should always be
 * findable. `entry.ok === false` means the level is still short (the server refuses it too).
 */
function chessEntries(v) {
  const diyData = { chess: data.get('chess'), backups: data.get('backups') };
  const out = [];
  for (const id of v.pick.chess) {
    const c = data.lookup('chess', id);
    if (c) out.push({ id, rec: c, diy: false, ok: true });
  }
  for (const d of Array.isArray(v.pick.diy) ? v.pick.diy : []) {
    const c0 = data.lookup('chess', d.id);
    const rec = c0 ? ownDiyRecord(c0, v.priv, diyData) : null;
    if (rec) out.push({ id: d.id, rec, diy: true, ok: d.ok !== false, need: d.level ?? rec.tier });
  }
  return out;
}

/** The owned-copies pips of a card (hidden when the player owns none of it yet). */
function pipsOf(v, entry) {
  const prog = mergeProgress(v.priv, entry.rec.chessId || entry.id, (x) => data.lookup('chess', x));
  if (!(prog.copies > 0)) return null;
  return el('span', { class: 'spmod-pips', title: `已拥有 ${prog.copies}/${prog.need}` },
    Array.from({ length: prog.need }, (_, i) => el('i', { class: i < prog.copies ? 'on' : '' })));
}

const priceOfChess = (c) => (Number.isFinite(c.price) ? c.price : 3);

/** One row per operator: name, tier, price. What you want when the list is long. */
function chessRows(v, entries) {
  const grid = el('div', { class: 'spmod-grid is-name' });
  for (const e of entries) {
    const c = e.rec;
    const price = priceOfChess(c);
    grid.append(el('button', {
      class: ['spmod-row', `spmod-row--t${c.tier}`, price > v.priv.funds && 'is-poor', !e.ok && 'is-locked'].filter(Boolean).join(' '),
      type: 'button', 'data-id': e.id,
      title: e.ok
        ? `${c.name} · ${c.tier} 阶 · ${price} 资金${e.diy ? ' · 自选编队' : ''}`
        : `${c.name} · 自选编队 · 调度中心 Lv.${e.need} 才会出现在商店里`,
      onClick: cardAction(e),
    },
      e.diy ? el('span', { class: ['spmod-diy', 'is-inline'].join(' ') }, '自选') : null,
      el('span', { class: 'spmod-name' }, c.name || e.id),
      pipsOf(v, e),
      el('i', { class: 'spmod-tier' }, String(c.tier)),
      el('span', { class: 'spmod-price' }, String(price)),
    ));
  }
  return grid;
}

/** One card per operator, with its portrait in the art's own 1:2 shape. */
function chessGrid(v, entries) {
  const assets = data.get('assets');
  const grid = el('div', { class: 'spmod-grid' });
  for (const e of entries) {
    const c = e.rec;
    const price = priceOfChess(c);
    const url = chessPortraitUrl(assets, c);
    grid.append(el('button', {
      class: ['spmod-card', `spmod-t${c.tier}`, price > v.priv.funds && 'is-poor', !e.ok && 'is-locked'].filter(Boolean).join(' '),
      type: 'button', 'data-id': e.id,
      title: e.ok
        ? `${c.name}${c.subProfessionName ? ` · ${c.subProfessionName}` : ''} · ${price} 资金${e.diy ? ' · 自选编队' : ''}`
        : `${c.name} · 自选编队 · 调度中心 Lv.${e.need} 才会出现在商店里`,
      onClick: cardAction(e),
    },
      url ? el('img', { class: 'spmod-art', src: url, alt: '', loading: 'lazy' }) : el('span', { class: 'spmod-art' }),
      e.diy ? el('span', { class: 'spmod-diy' }, '自选') : null,
      el('span', { class: 'spmod-name' }, c.name || e.id),
      el('span', { class: 'spmod-meta' },
        el('i', { class: 'spmod-tier' }, String(c.tier)),
        el('span', { class: 'spmod-price' }, String(price)),
      ),
      pipsOf(v, e),
    ));
  }
  return grid;
}

function drawChessPicker(v) {
  const entries = chessEntries(v);
  const profs = [...new Set(entries.map((e) => e.rec.profession).filter(Boolean))];

  const filters = el('div', { class: 'spmod-filters' },
    el('input', {
      class: 'spmod-search', type: 'search', placeholder: '搜索干员…', value: local.query, autocomplete: 'off',
      onInput: (e) => { local.query = e.currentTarget.value.trim(); render(true); },
    }),
    el('select', {
      class: 'spmod-prof',
      onChange: (e) => { local.prof = e.currentTarget.value; render(true); },
    },
      el('option', { value: '' }, '全部职业'),
      ...profs.map((p) => el('option', { value: p, selected: p === local.prof }, PROF_NAME[p] || p)),
    ),
  );

  const ql = local.query.toLowerCase();
  // 自选编队 pieces first, then by tier: the operators this player deliberately chose are the ones they came for
  const show = entries
    .filter((e) => !local.prof || e.rec.profession === local.prof)
    .filter((e) => !ql || String(e.rec.name || '').toLowerCase().includes(ql) || String(e.rec.appellation || '').toLowerCase().includes(ql))
    .sort((a, b) => (b.diy - a.diy) || (b.rec.tier - a.rec.tier) || ((a.rec.identifier ?? 0) - (b.rec.identifier ?? 0)));

  const body = el('div', { class: 'spmod-body' },
    filters,
    show.length
      ? (local.view === 'art' ? chessGrid(v, show) : chessRows(v, show))
      : el('p', { class: 'spmod-empty' }, '这个等级下没有可选干员。'),
  );
  panel.append(body);
}

function drawItemPicker(v) {
  const assets = data.get('assets');
  const list = [...new Set(v.pick.item)].map((id) => ({ id, rec: data.lookup('items', id) })).filter((e) => e.rec);
  list.sort((a, b) => (b.rec.tier - a.rec.tier) || String(a.rec.name || '').localeCompare(String(b.rec.name || ''), 'zh'));

  const grid = el('div', { class: ['spmod-grid', 'spmod-grid--item', local.view !== 'art' && 'is-name'].filter(Boolean).join(' ') });
  for (const { id, rec } of list) {
    const price = Number.isFinite(rec.price) ? rec.price : 2;
    const poor = Number(price) > v.priv.funds;
    if (local.view !== 'art') {
      grid.append(el('button', {
        class: ['spmod-row', `spmod-row--t${rec.tier ?? 1}`, poor && 'is-poor'].filter(Boolean).join(' '),
        type: 'button', 'data-id': id,
        title: `${rec.name} · ${price} 资金 · 不占每回合额度`,
        onClick: cardAction({ id, rec, item: true }),
      },
        el('span', { class: 'spmod-name' }, rec.name || id),
        el('i', { class: 'spmod-tier' }, String(rec.tier ?? 1)),
        el('span', { class: 'spmod-price' }, String(price)),
      ));
      continue;
    }
    const url = itemIconUrl(assets, rec);
    grid.append(el('button', {
      class: ['spmod-card', 'spmod-itemcard', poor && 'is-poor'].filter(Boolean).join(' '),
      type: 'button', 'data-id': id,
      title: `${rec.name} · ${price} 资金 · 不占每回合额度`,
      onClick: cardAction({ id, rec, item: true }),
    },
      url ? el('img', { class: 'spmod-art', src: url, alt: '', loading: 'lazy' }) : el('span', { class: 'spmod-art' }),
      el('span', { class: 'spmod-name' }, rec.name || id),
      el('span', { class: 'spmod-meta' }, el('i', { class: 'spmod-tier' }, String(rec.tier ?? 1)), el('span', { class: 'spmod-price' }, String(price))),
    ));
  }

  panel.append(el('div', { class: 'spmod-body' },
    el('div', { class: 'spmod-filters' }, el('span', { class: 'spmod-hint' }, '本档位可出现的装备')),
    grid,
  ));
}

render(true);
renderSpeed();
renderAuto();
renderSandbox();
renderUnits();
