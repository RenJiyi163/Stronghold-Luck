// test/helpers/game-root.mjs — where the game lives, and the one way to import from it.
//
// The suites each resolved this themselves; the helpers need it too (the vendored fakes import the game's modules),
// so it lives here once. Same three sources, in the same order, as the suites: `--game <dir>`, mod.config.json, the
// default the mod ships with.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MOD_ROOT = path.resolve(HERE, '..', '..');

const gameArg = process.argv.indexOf('--game');
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path.join(MOD_ROOT, 'mod.config.json'), 'utf8')); } catch { /* no config: defaults */ }

export const GAME_ROOT = path.resolve(gameArg >= 0 ? process.argv[gameArg + 1] : cfg.gameRoot || 'D:\\Stronghold-Protocol');

/** Import a module out of the game directory by its path relative to the game root. */
export const imp = (rel) => import(pathToFileURL(path.join(GAME_ROOT, rel)).href);
