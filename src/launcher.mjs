#!/usr/bin/env node
// launcher.mjs — Stronghold-Luck: run Stronghold-Protocol with a pick-your-own shop, out of tree.
//
//   node src/launcher.mjs [--port 3000] [--host 127.0.0.1] [--no-open] [--game <dir>] [--vanilla]
//
// The game is started on its own loopback port (it serves everything: / , /data, /shared, /sim, /ws). A front HTTP
// server sits on the configured port and does exactly two things to the traffic:
//   * `/mod/*`            → served from this repo (the panel's own js/css)
//   * `/` and /index.html → the game's HTML with one <script> + one <link> appended
// Everything else — every data file, every image, every WebSocket upgrade — is passed straight through, untouched.
// The game folder is never written to. Run `npm start` in the game folder instead to get the vanilla game back.

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { findGame, saveGameRoot } from './find-game.mjs';
import { canPick, canPrompt, pickGameDir, promptGameDir } from './pick-game.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const MOD_ROOT = path.resolve(HERE, '..');
const MOD_PUBLIC = path.join(MOD_ROOT, 'public');
const CONFIG_PATH = path.join(MOD_ROOT, 'mod.config.json');

const log = {
  info: (...a) => console.log('[luck]', ...a),
  warn: (...a) => console.warn('[luck]', ...a),
  error: (...a) => console.error('[luck]', ...a),
  debug: () => {},
};

// ---- options ------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--no-open') out.open = false;
    else if (a === '--open') out.open = true;
    else if (a === '--vanilla') out.vanilla = true;
    else if (a === '--no-patch') out.noPatch = true;
    else if (a === '--no-log') out.record = false;
    else if (a === '--log') out.record = true;
    else if (a === '--log-dir') out.logDir = argv[++i];
    else if (a === '--port') out.port = Number(argv[++i]);
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--game') out.gameRoot = argv[++i];
    else if (a === '--no-pick') out.noPick = true;
    else if (a === '--speed') out.speed = Number(argv[++i]);
    else if (a === '--help' || a === '-h') out.help = true;
    else log.warn(`ignoring unknown argument ${a}`);
  }
  return out;
}

function loadConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') log.warn(`mod.config.json unreadable (${e.message}); using defaults`);
    return {};
  }
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  console.log(`Stronghold-Luck — 自选商店启动器

  node src/launcher.mjs [options]

  --port <n>      监听端口（默认 3000 或 mod.config.json 的 port）
  --host <addr>   监听地址（默认 127.0.0.1，只允许本机访问）
  --game <dir>    游戏目录（默认 mod.config.json 的 gameRoot，再不行自动探测）
  --no-pick       找不到游戏目录时不弹选择框，直接报错（给脚本用）
  --no-open       不自动打开浏览器
  --vanilla       页面也不注入自选面板，等于原版游戏（排查用）
  --no-patch      页面注入面板但不打服务端补丁：用来确认补丁失效时面板会自己隐藏
  --no-log        不记录你在对局里的操作（默认记到 logs/*.jsonl）
  --log-dir <dir> 换一个记录目录（默认 <mod>/logs）
  --speed <n>     开局倍速（默认 mod.config.json 的 combatSpeed，2 = 游戏原速）
`);
  process.exit(0);
}

const cfg = loadConfig();
const port = Number.isInteger(args.port) && args.port >= 0 ? args.port : (Number.isInteger(cfg.port) ? cfg.port : 3000);
const host = args.host || cfg.host || '127.0.0.1';
const openBrowser = args.open === false ? false : cfg.openBrowser !== false;

// ---- game folder --------------------------------------------------------------------------------------

/** 「这是不是游戏根」的唯一判据。 */
const looksLikeGame = (dir) => !!dir && fs.existsSync(path.join(dir, 'server', 'index.js'));

/**
 * 命令行 → mod.config.json → 自动探测 → 弹框选。找不到返回 null。
 * `--game` 明确给了但不对，就地报错退出：用户已经说了在哪，不该替他猜。
 */
async function resolveGameRoot() {
  if (args.gameRoot) {
    const dir = path.resolve(args.gameRoot);
    if (!looksLikeGame(dir)) {
      log.error(`--game 指向的目录里没有 server/index.js：${dir}`);
      process.exit(1);
    }
    return dir;
  }

  if (cfg.gameRoot) {
    const dir = path.resolve(cfg.gameRoot);
    if (looksLikeGame(dir)) return dir;
    log.warn(`mod.config.json 里的 gameRoot 不对（${cfg.gameRoot}），继续找`);
  }

  const found = findGame({ modRoot: MOD_ROOT });
  if (found) {
    log.info(`自动找到游戏目录：${found}`);
    return found;
  }

  // 猜不到就问一句。Windows 上是文件夹选择框，macOS / Linux 上没有那个对话框，改成在终端里问。
  // stdout 不是终端时（自检、被别的脚本调用）都不问，免得挂住不返回。
  if (canPrompt() && !args.noPick && !canPick()) {
    log.info('没找到游戏目录，直接输入一个。也可以改用 --game <目录>。');
    const typed = await promptGameDir();
    if (typed && looksLikeGame(typed)) {
      const dir = path.resolve(typed);
      try {
        saveGameRoot(CONFIG_PATH, dir, cfg);
        log.info(`已记住游戏目录：${dir}`);
      } catch (e) {
        log.warn(`游戏目录记住了，但没能写回 mod.config.json：${e.message}`);
      }
      return dir;
    }
    if (typed) log.warn(`那个目录里没有 server/index.js：${typed}`);
  }

  if (canPick() && !args.noPick && process.stdout.isTTY) {
    log.info('没找到游戏目录，弹一个选择框。也可以改用 --game <目录>，或把游戏文件夹拖到 start.cmd 上。');
    const picked = pickGameDir();
    if (picked && looksLikeGame(picked)) {
      try {
        saveGameRoot(CONFIG_PATH, picked, cfg);
        log.info(`已记住游戏目录：${picked}`);
      } catch (e) {
        log.warn(`游戏目录记住了，但没能写回 mod.config.json：${e.message}`);
      }
      return path.resolve(picked);
    }
    if (picked) log.warn(`选的目录里没有 server/index.js：${picked}`);
  }

  log.error('没找到 Stronghold-Protocol 游戏目录。三种给法：');
  log.error(process.platform === 'win32'
    ? '  1) 把游戏文件夹拖到 start.cmd 上'
    : '  1) 把外挂和游戏放成并排的同级目录（游戏目录名里带 stronghold 即可自动找到）');
  log.error('  2) 把 mod.config.json 的 gameRoot 改成你的游戏目录');
  log.error('  3) node src/launcher.mjs --game <目录>');
  return null;
}

// 这份外挂是照哪个游戏版本写的。上游改了锚点，面板会自己隐藏（README「游戏更新了怎么办」）。
// 先把版本号比一遍，用户就不用对着一个不亮的面板猜。
const EXPECTED_GAME_VERSION = '0.3.3';

function checkGameVersion(gameRoot) {
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(gameRoot, 'package.json'), 'utf8')).version || null;
  } catch { /* 读不到就跳过 */ }
  if (!version) {
    log.warn(`游戏的 package.json 读不到，没法确认版本（这份外挂是照 ${EXPECTED_GAME_VERSION} 写的）。`);
    return;
  }
  if (version !== EXPECTED_GAME_VERSION) {
    log.warn(`注意：这份外挂是照 Stronghold-Protocol ${EXPECTED_GAME_VERSION} 写的，你这份是 ${version}。`);
    log.warn('  上游改动锚点时面板会整块不出现（启动日志里找 anchors not found）。');
  }
}

const gameRoot = await resolveGameRoot();
if (!gameRoot) process.exit(1);
checkGameVersion(gameRoot);

// ---- mod assets --------------------------------------------------------------------------------------

const MOD_FILES = new Map([
  ['/mod/overlay.js', ['overlay.js', 'text/javascript; charset=utf-8']],
  ['/mod/overlay.css', ['overlay.css', 'text/css; charset=utf-8']],
  // shared by the panel AND the server patch (the sandbox's unit overrides): one implementation, two importers
  ['/mod/unit-rules.js', ['unit-rules.js', 'text/javascript; charset=utf-8']],
  // the same arrangement for the 自选位 overrides (盟约 / 特质 / 数值)
  ['/mod/slot-rules.js', ['slot-rules.js', 'text/javascript; charset=utf-8']],
  // and for the 自动买卖 target catalogue (which class each card is decides when the loop may buy it)
  ['/mod/auto-rules.js', ['auto-rules.js', 'text/javascript; charset=utf-8']],
]);

const INJECT = '<link rel="stylesheet" href="/mod/overlay.css">\n<script type="module" src="/mod/overlay.js"></script>\n';

/** Append the mod's tag to the game's HTML (before </body> when there is one). */
function injectHtml(html) {
  const at = html.lastIndexOf('</body>');
  return at >= 0 ? `${html.slice(0, at)}${INJECT}${html.slice(at)}` : html + INJECT;
}

const isRewritePath = (p) => p === '/' || p === '/index.html';

// ---- boot --------------------------------------------------------------------------------------------

const { installServerPatch } = await import(pathToFileURL(path.join(HERE, 'server-patch.mjs')).href);

const pickLimit = Number.isInteger(cfg.pickLimitPerRound) && cfg.pickLimitPerRound >= 0 ? cfg.pickLimitPerRound : 3;
const combatSpeed = Number.isInteger(args.speed) ? args.speed
  : Number.isInteger(cfg.combatSpeed) ? cfg.combatSpeed : 2;
const record = args.record === false ? false : cfg.record !== false;
let logFile = null;

if (args.vanilla || args.noPatch) {
  log.info(args.vanilla ? '--vanilla：页面不注入自选面板' : '--no-patch：注入页面但不打服务端补丁（面板会自动隐藏）');
} else {
  try {
    const status = await installServerPatch(gameRoot, log, { pickLimit, record, logDir: args.logDir, combatSpeed });
    logFile = status.logFile;
  } catch (e) {
    log.error('注入失败（照常启动原版游戏）：', e);
  }
}

const { startServer } = await import(pathToFileURL(path.join(gameRoot, 'server', 'index.js')).href);

let inner;
try {
  inner = await startServer({ port: 0, host: '127.0.0.1', quiet: true, log: { info: () => {}, warn: () => {}, error: (...a) => log.error('[game]', ...a), debug: () => {} } });
} catch (e) {
  log.error('游戏服务器启动失败：', e);
  process.exit(1);
}
const innerPort = inner.port;

// ---- front server ------------------------------------------------------------------------------------

function serveMod(rawPath, res, method) {
  const hit = MOD_FILES.get(rawPath);
  if (!hit) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('not found'); return; }
  const [file, type] = hit;
  const body = fs.readFileSync(path.join(MOD_PUBLIC, file));
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': body.length, 'Cache-Control': 'no-store' });
  res.end(method === 'HEAD' ? undefined : body);
}

function proxyHttp(req, res) {
  const rawPath = (req.url || '/').split('?')[0];
  if (rawPath.startsWith('/mod/')) return serveMod(rawPath, res, req.method);

  const rewrite = isRewritePath(rawPath);
  const headers = { ...req.headers };
  if (rewrite) {
    // no conditional requests / compression for the one response we edit: we need plain, complete utf-8
    delete headers['accept-encoding'];
    delete headers['if-none-match'];
    delete headers['if-modified-since'];
  }

  const up = http.request({ host: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers }, (upRes) => {
    if (!rewrite) {
      res.writeHead(upRes.statusCode, upRes.headers);
      upRes.pipe(res);
      return;
    }
    const chunks = [];
    upRes.on('data', (c) => chunks.push(c));
    upRes.on('end', () => {
      const body = injectHtml(Buffer.concat(chunks).toString('utf8'));
      const h = { ...upRes.headers };
      for (const k of ['content-length', 'content-encoding', 'etag', 'last-modified', 'transfer-encoding']) delete h[k];
      h['content-type'] = 'text/html; charset=utf-8';
      h['cache-control'] = 'no-store';
      h['content-length'] = Buffer.byteLength(body);
      try { res.writeHead(upRes.statusCode, h); res.end(body); } catch { /* client gone */ }
    });
  });
  up.on('error', (e) => {
    log.warn('代理请求失败', rawPath, e?.message || e);
    try { res.writeHead(502, { 'Content-Type': 'text/plain; charset=utf-8' }); res.end('bad gateway'); } catch { /* ignore */ }
  });
  req.pipe(up);
}

/** Forward a WebSocket upgrade verbatim (the game's socket lives on the inner port). */
function proxyUpgrade(req, socket, head) {
  socket.on('error', () => socket.destroy());
  const up = http.request({ host: '127.0.0.1', port: innerPort, path: req.url, method: req.method, headers: req.headers });
  up.on('upgrade', (upRes, upSocket, upHead) => {
    upSocket.on('error', () => socket.destroy());
    const lines = [`HTTP/1.1 ${upRes.statusCode} ${upRes.statusMessage}`];
    for (let i = 0; i < upRes.rawHeaders.length; i += 2) lines.push(`${upRes.rawHeaders[i]}: ${upRes.rawHeaders[i + 1]}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    socket.pipe(upSocket);
    upSocket.pipe(socket);
  });
  up.on('error', () => socket.destroy());
  if (head?.length) up.write(head);
  up.end();
}

const server = http.createServer((req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  proxyHttp(req, res);
});
server.on('upgrade', proxyUpgrade);
server.on('clientError', (e, socket) => { try { socket.destroy(); } catch { /* ignore */ } });

await new Promise((resolve, reject) => {
  server.once('error', reject);
  server.listen(port, host, resolve);
}).catch((e) => {
  if (e?.code === 'EADDRINUSE') {
    log.error(`端口 ${port} 已被占用。换一个：node src/launcher.mjs --port 3001`);
    log.error('（如果游戏本来就在这个端口上跑着，先把它关掉。）');
  } else {
    log.error('监听失败：', e);
  }
  process.exit(1);
});

const shown = host === '0.0.0.0' || host === '::' ? 'localhost' : host;
const url = `http://${shown}:${port}`;
console.log('');
console.log('  卫戍协议 · 自选商店（Stronghold-Luck）');
console.log(`  打开：   ${url}`);
console.log(`  游戏目录：${gameRoot}（未改动）`);
console.log(`  每回合自选+直购：${pickLimit > 0 ? `${pickLimit} 次（面板里可改）` : '不限（面板里可改）'}`);
console.log(`  开局倍速：${combatSpeed}×（面板里可改，2 = 原速）`);
if (logFile) console.log(`  操作记录：${logFile}`);
console.log('  停止：   Ctrl+C');
console.log('');

if (openBrowser) openInBrowser(url);

function openInBrowser(u) {
  try {
    if (process.platform === 'win32') spawn('cmd', ['/c', 'start', '', u], { detached: true, stdio: 'ignore' }).unref();
    else if (process.platform === 'darwin') spawn('open', [u], { detached: true, stdio: 'ignore' }).unref();
    else spawn('xdg-open', [u], { detached: true, stdio: 'ignore' }).unref();
  } catch (e) {
    log.warn('打开浏览器失败，手动访问上面的地址即可', e?.message || e);
  }
}

let stopping = false;
async function stop(signal) {
  if (stopping) { process.exit(1); }
  stopping = true;
  console.log(`\n[${signal}] 关闭中…`);
  setTimeout(() => process.exit(0), 3000).unref();
  try { server.close(); } catch { /* ignore */ }
  try { await inner.close(); } catch { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));
