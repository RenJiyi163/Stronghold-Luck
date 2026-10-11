// auto-rules.js — the 自动买卖 target catalogue, shared by the panel AND the server patch (one implementation, two
// importers, the same arrangement as unit-rules.js / slot-rules.js).
//
// One entry per card whose <获得时> / <售出时> pays out on a repeat buy (derived from data/garrisons.json). The class
// decides WHEN the loop may buy it:
//
//   'now'      收益就在当期兑现 —— 掉盟约之币（装备掉的钱）、给免费刷新、白嫖干员、购买价 1。随时可买。
//   'deferred' 收益落到**下个休整期**（能天使 / 新约能天使 <获得时>、泥岩 / 格雷伊 <售出时>）。**刷新免费时不买**
//              ——这时循环本身不花钱，拖到下期的资金没有意义；刷新要花钱时才抓，用它顶掉刷新开销。
//   'item'     掉的是道具（不融冰 / 定制品 / 迅捷作战粮 / 变形同构体）。循环的「回收」那一步认的是盟约之币，
//              这些道具收不了，正常情况下不倒它们，所以默认不勾。
//
// 另外每张卡还带一个 `economy`（经济牌），那是**收费刷**那一套的闸门（作者 2026-10-11：「收费时既然决定自动倒转了，
// 那肯定是只抓经济牌」）。免费刷时滚商店不花钱，抓什么都行；收费刷时每一滚都在掏钱，只有能把这笔钱挣回来的牌才值得抓。
// 经济牌三类：直接把钱赚回来（诗怀雅掉币、下期四张给钱）、把一滚的钱省下来（普罗旺斯 / 德克萨斯给免费刷新）、
// 买卖本身不亏还能跑次数（至简买价 1）。**焰尾落的是干员、不是钱**，按这条规矩收费刷时就不抓它；道具四张同理。
//
// 不在表里的：**进入休整期时**触发的（歌蕾蒂娅 / 佩佩 / 缄默德克萨斯）。它们一张卖一张买不会触发，不属于这个循环。

/** `now` / `deferred` / `item`，中文名给面板用。 */
export const AUTO_CLASS_LABEL = Object.freeze({ now: '当期', deferred: '下期', item: '道具' });

/** 面板上分组前那一行说明：为什么这一类是这个待遇。 */
export const AUTO_CLASS_HINT = Object.freeze({
  now: '当期兑现：随时可倒',
  deferred: '下期兑现：刷新要花钱时才倒（刷新免费时自动跳过）',
  item: '掉的是道具，循环收不了：默认不倒',
});

/**
 * id → 名字 / 类别 / 一句话说明。类别与 `economy` 一起决定服务端的购买闸门（见文件头），面板按同一份分类分组渲染。
 * `note` 是玩家在勾选框后面看到的那半行字，`garrison` 记下这条判据出自哪一条驻守，便于回查。
 */
export const AUTO_CARDS = Object.freeze([
  { id: 'chess_char_3_03_a', name: '诗怀雅', cls: 'now', economy: true, note: '获得时掉盟约之币', garrison: 'garrison_133_a' },
  { id: 'chess_char_1_07_a', name: '普罗旺斯', cls: 'now', economy: true, note: '获得时给 1 次免费刷新', garrison: 'garrison_113_a' },
  { id: 'chess_char_1_08_a', name: '德克萨斯', cls: 'now', economy: true, note: '售出时给 1 次免费刷新', garrison: 'garrison_120_a' },
  { id: 'chess_char_4_19_a', name: '焰尾', cls: 'now', economy: false, note: '获得时白嫖 1 个干员', garrison: 'garrison_149_a' },
  { id: 'chess_char_3_13_a', name: '至简', cls: 'now', economy: true, note: '购买价为 1', garrison: 'garrison_13_a' },
  { id: 'chess_char_3_01_a', name: '能天使', cls: 'deferred', economy: true, note: '获得时，下期 +1 资金', garrison: 'garrison_26_a' },
  { id: 'chess_char_6_13_a', name: '新约能天使', cls: 'deferred', economy: true, note: '获得时，下期 +2 资金', garrison: 'garrison_32_a' },
  { id: 'chess_char_4_18_a', name: '泥岩', cls: 'deferred', economy: true, note: '售出时，下期 +2 资金', garrison: 'garrison_21_a' },
  { id: 'chess_char_1_14_a', name: '格雷伊', cls: 'deferred', economy: true, note: '售出时，下期 +1 资金', garrison: 'garrison_67_a' },
  { id: 'chess_char_3_20_a', name: '耶拉', cls: 'item', economy: false, note: '获得时掉不融冰', garrison: 'garrison_92_a' },
  { id: 'chess_char_2_10_a', name: '洛洛', cls: 'item', economy: false, note: '获得时掉定制品', garrison: 'garrison_91_a' },
  { id: 'chess_char_4_24_a', name: '卡涅利安', cls: 'item', economy: false, note: '获得时掉迅捷作战粮', garrison: 'garrison_49_a' },
  { id: 'chess_char_6_11_a', name: '缪尔赛思', cls: 'item', economy: false, note: '获得时掉变形同构体', garrison: 'garrison_76_a' },
]);

/** id → entry, for the server (which looks the class up itself and never trusts the client's word for it). */
export const AUTO_CARD_BY_ID = Object.freeze(Object.fromEntries(AUTO_CARDS.map((c) => [c.id, c])));

/** 默认勾上的：当期 + 下期。道具类留空，要倒它们得自己勾。 */
export const AUTO_DEFAULT_IDS = Object.freeze(AUTO_CARDS.filter((c) => c.cls !== 'item').map((c) => c.id));

/** The class of `id`, or null when it is not in the catalogue (the server refuses those outright). */
export const autoClassOf = (id) => AUTO_CARD_BY_ID[id]?.cls || null;

/**
 * May the loop buy `id` right now?
 *
 * `refreshFree` is whether the loop is in its free-rolling regime — 奇迹 at or past 100 layers, or a free-refresh
 * credit already in hand (the exact test is the server's `isRefreshFree`). The two regimes differ in what they take:
 *
 *   免费刷  滚商店不花钱，所以勾了就抓；只有 `deferred` 例外 —— 它的钱落到下个休整期，免费刷时没意义。
 *   收费刷  每一滚都在掏钱，所以只抓经济牌（`economy`）：焰尾那种落干员不落钱的、以及掉道具的，都跳过。
 *
 * 收费刷还有一条路由在服务端（`autoLoop` 里的 `roundTripNet`）：**这一进一出不亏的牌也抓**——远见 −1 之后原价两块的
 * 变一块、卖掉还一块，那就跟至简一样白转一圈。所以这张表只给「这张牌是不是直接给钱」定档，最终抓不抓要看当时的价。
 */
export const autoCardAllowedNow = (id, refreshFree) => {
  const c = AUTO_CARD_BY_ID[id];
  if (!c) return false;
  return refreshFree ? c.cls !== 'deferred' : c.economy;
};
