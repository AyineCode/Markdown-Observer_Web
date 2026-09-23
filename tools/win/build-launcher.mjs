#!/usr/bin/env node
/**
 * build-launcher.mjs —— 编译 Windows 侧的小启动器（tools/win/MarkdownObserver.exe）。
 *
 * 用什么编译：Windows 自带的 .NET Framework 编译器 csc.exe
 *   （C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe）。
 *   装 .NET SDK / Visual Studio 都不用——Win10、Win11 天生就有它。
 *   代价是它只认 C# 5，所以 launcher.cs 里没有字符串插值、?. 这些新语法。
 *
 * 跑法（WSL 里跑，或 Windows 里跑都行）：
 *   node tools/win/build-launcher.mjs
 *   node tools/win/build-launcher.mjs --check     # 只报告编译器在哪，不编译
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = join(HERE, 'launcher.cs');
const OUTPUT = join(HERE, 'MarkdownObserver.exe');
const isWindows = process.platform === 'win32';

/**
 * 取 Windows 目录，并翻译成当前这边看得懂的路径。
 * WSL 里是 /mnt/c/Windows，Windows 里就是 C:\Windows——所以两边都问一次 %WINDIR%。
 */
function windowsDir() {
  try {
    const raw = execFileSync('cmd.exe', ['/c', 'echo', '%WINDIR%'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (isWindows) return raw;
    return execFileSync('wslpath', ['-u', raw], { encoding: 'utf8' }).trim();
  } catch {
    return isWindows ? 'C:\\Windows' : '/mnt/c/Windows';
  }
}

/** 找一个能用的 csc.exe。 */
function findCsc() {
  const root = windowsDir();
  for (const flavor of ['Framework64', 'Framework']) {
    const path = join(root, 'Microsoft.NET', flavor, 'v4.0.30319', 'csc.exe');
    if (existsSync(path)) return path;
  }
  return null;
}

/**
 * 把路径翻译成"Windows 侧看得懂"的写法。
 * WSL 里 csc.exe 是 Windows 程序，喂给它的必须是 \\wsl.localhost\... 或 C:\...
 */
function toWindowsPath(path) {
  if (isWindows) return path;
  return execFileSync('wslpath', ['-w', path], { encoding: 'utf8' }).trim();
}

const csc = findCsc();
if (csc === null) {
  console.error('csc.exe not found (the C# compiler bundled with .NET Framework).');
  console.error('Windows 10/11 normally has it at: C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe');
  process.exit(1);
}
console.log('compiler: ' + csc);

if (process.argv.includes('--check')) {
  console.log('check only, not building.');
  process.exit(0);
}

// 输出先放临时目录：Windows 程序往 WSL 的 UNC 路径写文件不一定被允许，失败再退回来。
const staging = join(process.env.TEMP ?? '/tmp', 'MarkdownObserver.exe');
/*
  图标：工具条、任务管理器、资源管理器里显示的就是它。
  想换图标有两种办法（README 里也写了）：
    · 改 tools/win/make-icon.mjs 里的配色/笔画，跑 node tools/win/make-icon.mjs 重新生成；
    · 或者拿你自己的 .ico 覆盖 tools/win/markdown-observer.ico（多尺寸的 .ico 最好）。
  也可以临时指定别的文件：node build-launcher.mjs --icon <路径.ico>
*/
const iconFlag = process.argv.indexOf('--icon');
const iconPath = iconFlag >= 0 && process.argv[iconFlag + 1] !== undefined
  ? resolve(process.argv[iconFlag + 1])
  : join(HERE, 'markdown-observer.ico');
const args = [
  '/nologo',
  '/target:winexe',        // winexe = 双击时不弹控制台窗口
  '/optimize+',
  '/platform:anycpu',
  '/out:' + toWindowsPath(OUTPUT),
  '/r:System.Windows.Forms.dll',
  toWindowsPath(SOURCE),
];
if (existsSync(iconPath)) {
  args.push('/win32icon:' + toWindowsPath(iconPath));
  /*
    再作为程序内资源编一份：窗口图标（托盘菜单、卸载进度窗）从资源里读，
    比 ExtractAssociatedIcon 可靠——后者要靠外壳去读路径，从 \\wsl.localhost\... 上会失败。
    csc 的 /resource: 不认 UNC，所以先用 cmd 搬到 Windows 本地临时目录。
  */
  try {
    const winTemp = execFileSync('cmd.exe', ['/c', 'echo', '%TEMP%'], { encoding: 'utf8' }).replace(/\r?\n/g, '').trim();
    const iconLocal = winTemp + '\\markdown-observer-icon.ico';
    execFileSync('cmd.exe', ['/c', 'copy', '/y', toWindowsPath(iconPath), iconLocal], { stdio: 'ignore' });
    args.push('/resource:' + iconLocal + ',AppIcon');
  } catch (error) {
    console.warn('icon resource skipped: ' + error.message);
  }
  console.log('icon: ' + iconPath);
} else {
  console.log('icon: (none, using the default .NET icon) - run make-icon.mjs to create one');
}

let built = false;
try {
  const out = execFileSync(csc, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (out.trim().length > 0) console.log(out.trim());
  built = true;
} catch (error) {
  const message = String(error.stdout ?? '') + String(error.stderr ?? '');
  if (!message.includes('CS') && !message.includes('error')) throw error;
  // CS0016 = 写不进输出文件：多半是托盘还在跑、占着 exe（这个坑刚踩过）
  if (message.includes('CS0016')) {
    console.error('build failed: the .exe is locked (a running tray holds it).');
    console.error('Stop it first, then build again:');
    console.error('  MarkdownObserver.exe --quit');
    console.error('  powershell -Command "Get-Process MarkdownObserver | Stop-Process -Force"');
    console.error('');
  } else {
    console.error('build failed:');
  }
  console.error(message.trim());
  process.exit(1);
}

if (!built || !existsSync(OUTPUT)) {
  console.error('the compiler reported no error but did not produce ' + OUTPUT);
  process.exit(1);
}
const size = statSync(OUTPUT).size;
console.log('built: ' + OUTPUT + ' (' + Math.round(size / 1024) + ' KB)');
