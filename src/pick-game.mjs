// pick-game.mjs — 猜不到游戏装在哪时，弹一个 Windows 文件夹选择框让用户点。
//
// 两个绕不开的坑：
//   * FolderBrowserDialog 要求 STA 线程，所以 powershell.exe 必须带 -STA。
//   * 选中的路径不能从 stdout 捞回来。控制台输出按系统代码页编码（中文机上是 936），Node 按 UTF-8
//     解，中文用户名或中文目录名会烂掉。所以让 PowerShell 把路径写进一个 UTF-8 临时文件，Node 再读文件。
//
// 非 Windows、没装 PowerShell、或用户取消，都返回 null，由调用方回退到「手改配置 / 拖到 start.cmd」。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 脚本带 BOM 写盘：PowerShell 5.1 只对带 BOM 的 .ps1 按 UTF-8 解，否则里面的中文提示会乱码。
// 导出是为了自检能拿它做语法校验（见 test/verify-pickgame.mjs）。
export const PS_SCRIPT = `$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dlg = New-Object System.Windows.Forms.FolderBrowserDialog
$dlg.Description = '请选中 Stronghold-Protocol 游戏文件夹（里面要有 server 这个文件夹）'
$dlg.ShowNewFolderButton = $false
if ($dlg.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText($args[0], $dlg.SelectedPath, (New-Object System.Text.UTF8Encoding($false)))
}
`;

export function canPick() {
  return process.platform === 'win32';
}

/** 弹框选一个目录。返回绝对路径；用户取消或环境不允许时返回 null。 */
export function pickGameDir({ timeoutMs = 600000 } = {}) {
  if (!canPick()) return null;

  let dir;
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shluck-pick-'));
  } catch {
    return null;
  }
  const outFile = path.join(dir, 'game.txt');
  const psFile = path.join(dir, 'pick.ps1');
  try {
    fs.writeFileSync(psFile, '\uFEFF' + PS_SCRIPT, 'utf8');
  } catch {
    return null;
  }

  const r = spawnSync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', psFile, outFile],
    { stdio: 'ignore', timeout: timeoutMs, windowsHide: true },
  );
  if (r.error) return null;

  try {
    const picked = fs.readFileSync(outFile, 'utf8').trim();
    return picked || null;
  } catch {
    return null; // 取消或超时：文件没写出来
  }
}
