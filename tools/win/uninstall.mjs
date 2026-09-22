#!/usr/bin/env node
/**
 * uninstall.mjs —— 把 install.mjs 装的东西全撤掉，一个字都不留。
 *
 * 撤什么：
 *   · 注册表：右键菜单、"打开方式"里的 Markdown Observer、ProgID、Applications 条目
 *   · 文件：%LOCALAPPDATA%\MarkdownObserver 整个目录（启动器 + 配置）
 * 不动：你的 .md 文件、你的默认程序设置（如果之前把它设成默认，Windows 会回到"没有默认"，
 *       下次双击会让你重新选一个）。
 *
 * 跑法：
 *   node tools/win/uninstall.mjs           # 卸
 *   node tools/win/uninstall.mjs --dry-run # 只打印打算删什么
 *   node tools/win/uninstall.mjs --keep-files  # 只清注册表，留下程序文件
 *
 * 删目录时会重试几次：万一还有服务在跑（它会占着那个目录），等一下通常就好了。
 * 试完还是删不掉，脚本会告诉你怎么手动收尾——不会甩一个调用栈给你。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';

const DRY = process.argv.includes('--dry-run');
const KEEP_FILES = process.argv.includes('--keep-files');
const EXE_NAME = 'MarkdownObserver.exe';
const EXTS = ['.md', '.markdown', '.mdown', '.mkd'];
const classes = 'HKCU\\Software\\Classes';

/** 跑一个 Windows 命令（失败不抛：卸载要能一路删到底）。 */
function win(command, args) {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/^\uFEFF/, '').trim();
  } catch {
    return null;
  }
}

function regDelete(key, name) {
  const args = ['delete', key, '/f'];
  if (name !== undefined) args.push('/v', name);
  if (DRY) {
    console.log('  reg delete ' + key + (name === undefined ? '' : ' /v ' + name));
    return;
  }
  win('reg.exe', args);   // 不存在就算了：卸载不该因为"本来就没有"而失败
}

/** 等一下（删目录失败要重试）。 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * 删掉整个目录，失败就重试几轮。
 * Windows 里只要还有进程把它当"当前目录"、或者句柄没放，就会 EACCES / EBUSY。
 * @returns {Promise<boolean>} 是否删干净了
 */
async function removeDir(path, label) {
  for (let round = 1; round <= 6; round += 1) {
    try {
      rmSync(path, { recursive: true, force: true });
      return true;
    } catch (error) {
      const code = error !== null && error.code !== undefined ? error.code : '?';
      const busy = code === 'EACCES' || code === 'EPERM' || code === 'EBUSY';
      if (!busy || round === 6) {
        console.log('  x could not delete (' + code + ')');
        console.log('    A service is probably still running - it needs a few seconds to a few minutes to exit. You can:');
        console.log('      1. close the reader browser tab (the service exits within seconds), then run this script again');
        console.log('      2. or wait a few minutes and run it again');
        console.log('      3. or delete this folder by hand: ' + label);
        return false;
      }
      await sleep(1000);
    }
  }
  return false;
}

console.log('Markdown Observer - uninstall');
console.log('- registry  ->');
regDelete(classes + '\\MarkdownObserver.md');
const appKey = classes + '\\Applications\\' + EXE_NAME;
regDelete(appKey);
for (const ext of EXTS) {
  regDelete(classes + '\\' + ext + '\\OpenWithProgids', 'MarkdownObserver.md');
  regDelete(classes + '\\SystemFileAssociations\\' + ext + '\\shell\\MarkdownObserver');
}

const installWin = (win('cmd.exe', ['/c', 'echo', '%LOCALAPPDATA%']) ?? '') + '\\MarkdownObserver';
const installWsl = win('wslpath', ['-u', installWin]);
console.log('- files     -> ' + installWin);
let filesGone = true;
if (KEEP_FILES) {
  console.log('  (--keep-files: keeping them)');
} else if (DRY) {
  console.log('  (dry-run)');
} else if (installWsl !== null && existsSync(installWsl)) {
  filesGone = await removeDir(installWsl, installWin);
  if (filesGone) console.log('  removed');
}

if (!DRY) {
  const script = [
    'Add-Type -Namespace Mo -Name Shell -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int a, int b, IntPtr c, IntPtr d);\';',
    '[Mo.Shell]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)',
  ].join(' ');
  win('powershell.exe', ['-NoProfile', '-Command', script]);
}

console.log('');
if (DRY) console.log('(--dry-run: nothing was changed)');
else if (filesGone) console.log('Uninstalled.');
else console.log('Registry cleaned up; program files are still there (see the notes above).');
