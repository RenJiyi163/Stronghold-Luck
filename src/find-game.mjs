// find-game.mjs — 找到 Stronghold-Protocol 装在哪。
//
// 发布之后游戏目录不再是 D:\Stronghold-Protocol，所以启动器不能写死一个盘。这里按「先近后远」列一串
// 常见位置，逐个拿 server/index.js 去认，认到就用。认不到交给 pick-game.mjs 弹框让用户点。
//
// 判据只有一个：目录里有 server/index.js。全都走 existsSync，不读目录内容，所以扫六个盘根也就几十次
// 系统调用，命中即停。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const GAME_DIR_NAME = 'Stronghold-Protocol';

/** 这个目录是不是游戏根。 */
export function isGameDir(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'server', 'index.js'));
  } catch {
    return false;
  }
}

function subdirNames(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return [];
  }
}

const DRIVE_LETTERS = 'CDEFGH';
const COMMON_SUBDIRS = ['', 'Games', 'SteamLibrary\\steamapps\\common', 'Program Files'];
const HOME_SUBDIRS = ['Desktop', 'Downloads', 'Documents', '桌面', '下载', '文档'];

/** 候选目录，已去重，靠前的更可能命中。 */
export function candidateDirs({ modRoot, cwd = process.cwd() } = {}) {
  const out = [];
  const push = (dir) => {
    if (!dir) return;
    const norm = path.resolve(dir);
    if (!out.includes(norm)) out.push(norm);
  };

  // 0. 环境变量：跑批处理或自检时最省事的覆盖点
  push(process.env.STRONGHOLD_PROTOCOL);

  // 1. 外挂旁边。解压出来经常是「外挂和游戏放在同一个文件夹里」
  const parent = modRoot ? path.dirname(modRoot) : null;
  if (parent) {
    push(path.join(parent, GAME_DIR_NAME));
    const selfName = modRoot ? path.basename(modRoot) : '';
    for (const name of subdirNames(parent)) {
      if (name === selfName) continue;
      if (name.toLowerCase().includes('stronghold')) push(path.join(parent, name));
    }
  }

  // 2. 当前目录
  push(cwd);
  push(path.join(cwd, GAME_DIR_NAME));

  // 3. 各盘根与几个常见子目录
  for (const letter of DRIVE_LETTERS) {
    const root = `${letter}:\\`;
    if (!fs.existsSync(root)) continue;
    for (const sub of COMMON_SUBDIRS) push(path.join(root, sub, GAME_DIR_NAME));
  }

  // 4. 用户目录
  const home = os.homedir();
  if (home) for (const sub of HOME_SUBDIRS) push(path.join(home, sub, GAME_DIR_NAME));

  return out;
}

/** 找到第一个真的是游戏的候选，找不到返回 null。 */
export function findGame(opts = {}) {
  for (const dir of candidateDirs(opts)) {
    if (isGameDir(dir)) return dir;
  }
  return null;
}

/** 把 gameRoot 写回 mod.config.json。写的是外挂目录里的文件，不动游戏。 */
export function saveGameRoot(configPath, gameRoot, cfg = {}) {
  const next = { ...cfg, gameRoot };
  fs.writeFileSync(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
}
