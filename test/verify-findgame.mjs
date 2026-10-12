// verify-findgame.mjs — 验「游戏目录怎么找」。整棵树造在系统临时目录里，不碰真游戏。
//
//   node test/verify-findgame.mjs
//
// 覆盖三件事：认目录的判据（目录里得有 server/index.js）、候选顺序（外挂旁边先于各盘根）、写回
// mod.config.json 时的转义。弹框（pick-game.mjs）不在这里验：那要真的弹出 GUI，自动化里没法点，
// 只能人工双击一次 start.cmd 看。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { GAME_DIR_NAME, isGameDir, candidateDirs, findGame, saveGameRoot } =
  await import(new URL('../src/find-game.mjs', import.meta.url).href);

const BACKSLASH_BACKSLASH = String.fromCharCode(92, 92);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

console.log('\nStronghold-Luck 游戏目录探测自检\n');

const savedEnv = process.env.STRONGHOLD_PROTOCOL;
delete process.env.STRONGHOLD_PROTOCOL;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shluck-find-'));
const makeGame = (dir) => {
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'server', 'index.js'), '// stub\n', 'utf8');
  return dir;
};

try {
  const root = path.join(tmp, 'root');
  const modDir = path.join(root, 'Stronghold-Luck');
  fs.mkdirSync(modDir, { recursive: true });
  const sibling = makeGame(path.join(root, GAME_DIR_NAME)); // 和外挂并排放的游戏

  await check('认目录：有 server/index.js 才算，别的目录不算', () => {
    assert.equal(isGameDir(sibling), true, `${sibling} 该认成游戏`);
    const plain = path.join(root, 'NotAGame');
    fs.mkdirSync(path.join(plain, 'server'), { recursive: true });
    fs.writeFileSync(path.join(plain, 'server', 'other.js'), '', 'utf8');
    assert.equal(isGameDir(plain), false, '只有别的文件时不该认成游戏');
    assert.equal(isGameDir(path.join(tmp, 'nope')), false, '不存在的目录不该认成游戏');
    assert.equal(isGameDir(''), false, '空串不该认成游戏');
  });

  await check('候选里「外挂旁边的同名目录」排在最前', () => {
    const list = candidateDirs({ modRoot: modDir });
    assert.equal(list[0], path.resolve(sibling), `第一个候选是 ${list[0]}，期望 ${sibling}`);
  });

  await check('候选去重', () => {
    const list = candidateDirs({ modRoot: modDir, cwd: root });
    assert.equal(new Set(list).size, list.length, '候选里出现了重复目录');
  });

  await check('探测命中外挂旁边的游戏', () => {
    const got = findGame({ modRoot: modDir, cwd: root });
    assert.equal(got, path.resolve(sibling), `探到的是 ${got}`);
  });

  await check('不是游戏根的候选不会被误认（阴性对照）', () => {
    const notGame = path.join(root, 'NotAGame');
    const got = findGame({ modRoot: notGame, cwd: notGame });
    assert.notEqual(got, path.resolve(notGame), '把 NotAGame 当成了游戏');
  });

  await check('环境变量 STRONGHOLD_PROTOCOL 排在最前', () => {
    const envGame = makeGame(path.join(tmp, 'env-game'));
    process.env.STRONGHOLD_PROTOCOL = envGame;
    try {
      const got = findGame({ modRoot: modDir });
      assert.equal(got, path.resolve(envGame), `探到的是 ${got}`);
    } finally {
      delete process.env.STRONGHOLD_PROTOCOL;
    }
  });

  await check('写回 mod.config.json：路径转义正确、别的字段不丢', () => {
    const cfgPath = path.join(tmp, 'mod.config.json');
    fs.writeFileSync(cfgPath, `${JSON.stringify({ port: 3001, record: false }, null, 2)}\n`, 'utf8');
    const target = 'E:\\Games\\Stronghold-Protocol';
    saveGameRoot(cfgPath, target, JSON.parse(fs.readFileSync(cfgPath, 'utf8')));

    const raw = fs.readFileSync(cfgPath, 'utf8');
    assert.ok(raw.includes(BACKSLASH_BACKSLASH), '文件里的反斜杠没被转义成双反斜杠');
    const back = JSON.parse(raw); // 单个反斜杠会在这里变成非法转义，直接抛
    assert.equal(back.gameRoot, target, `读回来的是 ${back.gameRoot}`);
    assert.equal(back.port, 3001, '原来的 port 被写没了');
    assert.equal(back.record, false, '原来的 record 被写没了');
  });

  await check('从零建配置也能读', () => {
    const cfgPath = path.join(tmp, 'fresh.json');
    saveGameRoot(cfgPath, 'D:\\Stronghold-Protocol', {});
    const back = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    assert.deepEqual(Object.keys(back), ['gameRoot'], `多写了字段：${Object.keys(back)}`);
  });
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.STRONGHOLD_PROTOCOL;
  else process.env.STRONGHOLD_PROTOCOL = savedEnv;
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
