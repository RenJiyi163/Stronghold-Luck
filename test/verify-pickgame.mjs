// verify-pickgame.mjs — 验「弹框选游戏目录」这一段。不真弹框，只做静态校验。
//
//   node test/verify-pickgame.mjs
//
// 手写的 .ps1 一旦语法错，弹框会静默失败、悄悄回落到控制台提示，很难发现。所以这里拿 PowerShell 自己的
// 语法解析器把脚本过一遍，再钉住两条形状：选中路径走 $args[0] 指定的临时文件回传（不是 stdout，stdout
// 有控制台编码坑，见 pick-game.mjs 注释），写文件用 UTF-8。
//
// 真正弹框、点选、写回 mod.config.json，只能人工双击一次 start.cmd 看。

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const BOM = String.fromCharCode(0xFEFF);
const { canPick, PS_SCRIPT } = await import(new URL('../src/pick-game.mjs', import.meta.url).href);

let pass = 0;
let fail = 0;
async function check(name, fn) {
  try { await fn(); pass++; console.log(`  ✓ ${name}`); }
  catch (e) { fail++; console.log(`  ✗ ${name}\n      ${e.message.split('\n')[0]}`); }
}

console.log('\nStronghold-Luck 选目录弹框自检\n');

await check('选中路径写进 $args[0] 指定的临时文件，不从 stdout 捞', () => {
  assert.ok(PS_SCRIPT.includes('[System.IO.File]::WriteAllText($args[0]'), '没有走 $args[0] 临时文件回传');
  assert.ok(PS_SCRIPT.includes('UTF8Encoding'), '写文件没指定 UTF-8');
  assert.ok(!/Write-Output|Write-Host/.test(PS_SCRIPT), '脚本往 stdout 写了东西，会踩控制台编码坑');
});

await check('canPick() 跟着平台走', () => {
  assert.equal(canPick(), process.platform === 'win32');
});

if (process.platform !== 'win32') {
  console.log('  (非 Windows，跳过 PowerShell 语法校验)');
} else {
  await check('PowerShell 解析器认这份脚本（没有语法错）', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shluck-pscheck-'));
    try {
      const target = path.join(dir, 'pick.ps1');
      fs.writeFileSync(target, BOM + PS_SCRIPT, 'utf8');
      const t = target.replace(/'/g, "''");
      const checker = path.join(dir, 'check.ps1');
      const body =
        '$e = $null; $t = $null;'
        + `[void][System.Management.Automation.Language.Parser]::ParseFile('${t}', [ref]$t, [ref]$e);`
        + "if ($e.Count) { $e | ForEach-Object { Write-Output $_.Message } } else { Write-Output 'SYNTAX-OK' }";
      fs.writeFileSync(checker, BOM + body, 'utf8');

      const r = spawnSync('powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', checker],
        { encoding: 'utf8' });
      const out = (r.stdout || '').trim();
      assert.ok(out.includes('SYNTAX-OK'), `解析器报了问题：${out || r.stderr || r.error?.message || '(无输出)'}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
}

console.log(`\n${fail ? '✗' : '✓'} 通过 ${pass}，失败 ${fail}`);
process.exit(fail ? 1 : 0);
