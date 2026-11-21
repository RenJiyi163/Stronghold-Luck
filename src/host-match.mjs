// host-match.mjs — the Match class a version match host should construct.
//
// 0.4.0's lobby default is 规程·序列Ⅰ. That match, and every other official version except 第二期下半, does not run
// in the launcher process. The game forks server/match/host/entry.js and that process imports Match.js itself, so
// the prototypes installServerPatch wrapped in the parent are a different module table. The launcher passes this
// file as startServer({ matchHost: { matchModule } }). entry.js imports it only after setData, then subclasses
// the Match it exports. Patching here wraps the same prototypes that subclass uses.
//
// The game directory and the starting knobs arrive in the environment. A non-sandbox host inherits it. A sandbox
// host (SP_PLUGIN_SCRIPTS=sandbox) replaces the environment and only allows reads inside the game tree, so this
// file, which lives outside that tree, cannot load there.

import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const gameRoot = process.env.SP_LUCK_GAME;
const here = path.dirname(fileURLToPath(import.meta.url));

const log = {
  info: (...a) => console.error('[luck-host]', ...a),
  warn: (...a) => console.error('[luck-host]', ...a),
  error: (...a) => console.error('[luck-host]', ...a),
  debug: () => {},
};

if (gameRoot) {
  try {
    const { installServerPatch } = await import(pathToFileURL(path.join(here, 'server-patch.mjs')).href);
    const pickLimit = Number(process.env.SP_LUCK_PICK_LIMIT);
    const combatSpeed = Number(process.env.SP_LUCK_SPEED);
    const status = await installServerPatch(gameRoot, log, {
      pickLimit: Number.isInteger(pickLimit) ? pickLimit : undefined,
      combatSpeed: Number.isInteger(combatSpeed) ? combatSpeed : undefined,
      record: process.env.SP_LUCK_RECORD !== '0',
      ...(process.env.SP_LUCK_LOG_DIR ? { logDir: process.env.SP_LUCK_LOG_DIR } : {}),
    });
    if (!status.ok) log.warn(`anchors not found (the mod is partially inert): ${(status.missing || []).join(', ')}`);
  } catch (e) {
    log.error('注入失败（这个对局进程照原版跑）：', e);
  }
} else {
  log.error('SP_LUCK_GAME 没有设置，这个对局进程没有打上外挂。');
}

const matchMod = await import(pathToFileURL(path.join(gameRoot || '.', 'server', 'match', 'Match.js')).href);
export const Match = matchMod.Match;
