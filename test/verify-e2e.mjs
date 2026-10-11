// verify-e2e.mjs — boots the real launcher (front server + game server + patch) and drives one solo match over the
// WebSocket, exactly as the browser would: /  gets the injected panel, /mod/* is served by us, everything else is the
// game, and `g.modPick` comes back OK with the shop slot filled.
//
//   node test/verify-e2e.mjs [--port 3199]

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const cfg = JSON.parse(await fs.promises.readFile(path.join(MOD_ROOT, 'mod.config.json'), 'utf8').catch(() => '{}'));
const gameRoot = path.resolve(cfg.gameRoot || 'D:\\Stronghold-Protocol');
const portArg = process.argv.indexOf('--port');
const port = portArg >= 0 ? Number(process.argv[portArg + 1]) : 3199;

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    fail++;
    console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`);
  }
}

const LOG_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'luck-e2e-'));
const child = spawn(process.execPath, [path.join(MOD_ROOT, 'src', 'launcher.mjs'), '--no-open', '--port', String(port), '--log-dir', LOG_DIR], {
  cwd: MOD_ROOT,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let childOut = '';
child.stdout.on('data', (d) => { childOut += d; });
child.stderr.on('data', (d) => { childOut += d; });

const base = `http://127.0.0.1:${port}`;
const cleanup = () => { try { child.kill(); } catch { /* ignore */ } };
process.on('exit', cleanup);

async function waitUp(timeoutMs = 20000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      const r = await fetch(`${base}/healthz`);
      if (r.ok) return;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`启动器没起来；输出：\n${childOut}`);
}

console.log(`\nStronghold-Luck 端到端自检 — ${base}\n`);

try {
  await waitUp();

  console.log('[HTTP]');
  await check('首页被注入面板脚本', async () => {
    const html = await (await fetch(`${base}/`)).text();
    assert.ok(html.includes('/mod/overlay.js'), '缺少 overlay.js 标签');
    assert.ok(html.includes('/mod/overlay.css'), '缺少 overlay.css 标签');
    assert.ok(html.includes('</body>'), 'HTML 结构不对劲');
  });
  await check('/mod/overlay.js 由我们提供', async () => {
    const r = await fetch(`${base}/mod/overlay.js`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type')?.includes('javascript'));
    const t = await r.text();
    assert.ok(t.includes('g.modPick'));
    assert.ok(t.includes('modPickable'));
    assert.ok(t.includes('g.modSpeed'));
  });
  await check('/mod/overlay.css 由我们提供', async () => {
    const r = await fetch(`${base}/mod/overlay.css`);
    assert.equal(r.status, 200);
    assert.ok(r.headers.get('content-type')?.includes('css'));
  });
  await check('游戏自己的静态资源透传', async () => {
    const chess = await (await fetch(`${base}/data/chess.json`)).json();
    assert.ok(Object.keys(chess).length > 100);
    const proto = await (await fetch(`${base}/shared/protocol.js`)).text();
    assert.ok(proto.includes('validateC2S'));
    const idx = await fetch(`${base}/`);
    assert.equal(idx.status, 200);
    const js = await fetch(`${base}/js/store.js`);
    assert.equal(js.status, 200);
  });
  await check('/mod/ 之外没有目录穿越', async () => {
    const r = await fetch(`${base}/mod/../mod.config.json`);
    assert.ok(r.status === 404 || r.status === 400, `期望 404，得到 ${r.status}`);
  });

  console.log('\n[一局真实对局（走 WebSocket 隧道）]');
  const { TestClient } = await import(pathToFileURL(path.join(gameRoot, 'test', 'helpers', 'wsClient.js')).href);
  const c = await TestClient.connect(`ws://127.0.0.1:${port}/ws`, { timeout: 8000 });
  await c.hello('LuckTest');
  await c.request({ t: 'room.create', mode: 'solo', difficulty: 'FUNNY' });
  await c.waitFor('room.state');

  const start = await c.request({ t: 'room.start' });
  assert.equal(start.t, 'ok', `room.start: ${JSON.stringify(start)}`);

  let pub = await c.waitFor('m.public', (m) => m.phase === 'INFO_CHECK', 8000);
  assert.equal(pub.modeId, 'mode_single_funny');
  await c.request({ t: 'g.infoReady' });

  // 策略轮选（单人无时限）：挑一个本局可用的策略
  const draft = await c.waitFor('m.public', (m) => m.phase === 'BAND_DRAFT', 8000).catch(() => null);
  if (draft) {
    const pick = c.request({ t: 'g.band', bandId: 'band_bldsk' });
    const r = await pick;
    assert.equal(r.t, 'ok', `g.band: ${JSON.stringify(r)}`);
  }

  const prep = await c.waitFor('m.public', (m) => m.phase === 'PREP', 10000);
  assert.ok(prep);

  const priv = await c.waitFor('m.private', (m) => m.shop?.modPickable && m.shop.slots?.length > 0, 5000);
  const pickable = priv.shop.modPickable;

  await check('privateView 下发可选列表', () => {
    assert.ok(Array.isArray(pickable.chess) && pickable.chess.length > 0, `chess=${JSON.stringify(pickable).slice(0, 120)}`);
    assert.ok(Number.isInteger(pickable.chessSlots) && pickable.chessSlots >= 1, `chessSlots=${pickable.chessSlots}`);
    assert.ok(Number.isInteger(pickable.itemSlots), `itemSlots=${pickable.itemSlots}`);
  });

  const want = pickable.chess[pickable.chess.length - 1];
  await check('g.modPick 走完整链路成功', async () => {
    const r = await c.request({ t: 'g.modPick', slot: 0, id: want });
    assert.equal(r.t, 'ok', JSON.stringify(r));
  });
  await check('服务端推送的商店 0 号槽变成所选干员', async () => {
    const after = await c.waitFor('m.private', (m) => m.shop?.slots?.[0]?.id === want, 5000);
    assert.equal(after.shop.slots[0].kind, 'chess');
    assert.equal(after.shop.slots[0].sold, false);
  });
  await check('再买走它（原版 g.buy 路径）', async () => {
    const r = await c.request({ t: 'g.buy', slot: 0 });
    assert.equal(r.t, 'ok', JSON.stringify(r));
  });
  await check('畸形负载被 net 层拦下', async () => {
    const r = await c.request({ t: 'g.modPick', slot: 'zero', id: want });
    assert.equal(r.t, 'error');
  });

  console.log('\n[直购与每回合额度]');
  let ids = [];
  await check('g.modConfig 把上限设为 2', async () => {
    const r = await c.request({ t: 'g.modConfig', pickLimit: 2 });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    const priv = await c.waitFor('m.private', (m) => m.shop?.modPickable?.quota?.limit === 2, 3000);
    assert.equal(priv.shop.modPickable.quota.limit, 2);
    ids = priv.shop.modPickable.chess;
    assert.ok(ids.length > 0, '有可选项');
  });
  await check('再自选一次，额度用满（本次刚好第 2 次）', async () => {
    const r = await c.request({ t: 'g.modPick', slot: 1, id: ids[0] });
    assert.equal(r.t, 'ok', JSON.stringify(r));
  });
  await check('额度用尽：自选被拒，detail 说明原因', async () => {
    const r = await c.request({ t: 'g.modPick', slot: 2, id: ids[0] });
    assert.equal(r.t, 'error', JSON.stringify(r));
    assert.ok(String(r.detail || '').includes('次数'), JSON.stringify(r));
  });
  await check('额度用尽：直购也被拒', async () => {
    const r = await c.request({ t: 'g.modBuy', id: ids[0] });
    assert.equal(r.t, 'error', JSON.stringify(r));
  });
  await check('改回不限（0）后恢复', async () => {
    const r = await c.request({ t: 'g.modConfig', pickLimit: 0 });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    const priv = await c.waitFor('m.private', (m) => m.shop?.modPickable?.quota?.limit === 0, 3000);
    assert.equal(priv.shop.modPickable.quota.limit, 0);
  });

  console.log('\n[倍速]');
  await check('开局是原速 2×（config 默认），privateView 带 modSpeed', () => {
    assert.equal(priv.modSpeed, 2, `modSpeed=${priv.modSpeed}`);
  });
  await check('g.modSpeed 走完整链路：服务端把它写进 privateView', async () => {
    const r = await c.request({ t: 'g.modSpeed', n: 8 });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    const after = await c.waitFor('m.private', (m) => m.modSpeed === 8, 3000);
    assert.equal(after.modSpeed, 8);
  });
  await check('越界倍速被拒（1–16 之外）', async () => {
    const r = await c.request({ t: 'g.modSpeed', n: 64 });
    assert.equal(r.t, 'error', JSON.stringify(r));
  });
  await check('改回 4×', async () => {
    const r = await c.request({ t: 'g.modSpeed', n: 4 });
    assert.equal(r.t, 'ok', JSON.stringify(r));
    const after = await c.waitFor('m.private', (m) => m.modSpeed === 4, 3000);
    assert.equal(after.modSpeed, 4);
  });

  console.log('\n[自动买卖]');
await check('g.modAuto 走完整链路：服务端把结果写进 privateView', async () => {
  const r = await c.request({ t: 'g.modAuto', on: true, cardIds: ['chess_char_3_13_a', 'chess_char_3_03_a'], cycles: 5, equipCoins: true, idCard: false });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const after = await c.waitFor('m.private', (m) => m.modAuto && m.modAuto.cardIds?.length === 2, 3000);
  assert.ok(Number.isFinite(after.modAuto.done), JSON.stringify(after.modAuto));
  assert.equal(after.modAuto.cycles, 5);
});
await check('停表：on:false 只记录，不动手', async () => {
  const r = await c.request({ t: 'g.modAuto', on: false, cardIds: ['chess_char_3_13_a'], cycles: 5, equipCoins: true, idCard: false });
  assert.equal(r.t, 'ok', JSON.stringify(r));
  const after = await c.waitFor('m.private', (m) => m.modAuto && m.modAuto.on === false, 3000);
  assert.equal(after.modAuto.on, false);
});
await check('参数不合法被拒（cycles 越界 / cardIds 空 / 目录外的卡）', async () => {
  const bad = { t: 'g.modAuto', on: true, cardIds: ['chess_char_3_13_a'], cycles: 5, equipCoins: true, idCard: false };
  assert.equal((await c.request({ ...bad, cycles: 0 })).t, 'error');
  assert.equal((await c.request({ ...bad, cardIds: [] })).t, 'error');
  assert.equal((await c.request({ ...bad, equipCoins: 1 })).t, 'error');
  // a well-formed id the catalogue does not know: every target filters out, so there is nothing to drive
  assert.equal((await c.request({ ...bad, cardIds: ['chess_char_1_01_a'] })).t, 'error');
});

console.log('\n[记录]');
  await check('日志文件里事件种类齐全（start/round/prep/act）', () => {
    const f = path.join(LOG_DIR, fs.readdirSync(LOG_DIR).find((x) => x.endsWith('.jsonl')));
    const kinds = new Set(fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l).k));
    for (const k of ['start', 'round', 'prep', 'act']) assert.ok(kinds.has(k), `缺 ${k}：${[...kinds].join(',')}`);
  });

  await c.close();
  console.log(`\n结果：${pass} 通过，${fail} 失败\n`);
} catch (e) {
  fail++;
  console.log(`\n✗ 致命错误：${e.message}\n${childOut.slice(-2000)}\n`);
} finally {
  cleanup();
}
process.exit(fail ? 1 : 0);
