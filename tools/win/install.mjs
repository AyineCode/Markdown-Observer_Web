#!/usr/bin/env node
/**
 * install.mjs —— 把"用 Markdown Observer 打开 .md"装进 Windows。
 *
 * 装什么（三样，都在当前用户下，**不需要管理员**）：
 *   1. 启动器   %LOCALAPPDATA%\MarkdownObserver\MarkdownObserver.exe
 *   2. 它的配置 %LOCALAPPDATA%\MarkdownObserver\config.txt
 *   3. 注册表   HKCU\Software\Classes 下的一小组键：
 *        · 右键菜单："用 Markdown Observer 阅读"
 *        · "打开方式"列表里出现 Markdown Observer（ProgID + OpenWithProgids + Applications）
 *      不动你现在的 .md 默认程序——要不要把它设成默认，你自己在"打开方式"里选一次。
 *
 * 跑法（在 WSL 里跑；Windows 上暂时不行，因为启动器要调 wsl.exe）：
 *   node tools/win/install.mjs              # 装
 *   node tools/win/install.mjs --dry-run    # 只打印打算做什么，一个字都不改
 *   node tools/win/uninstall.mjs            # 卸
 *
 * 这个"模式"只服务于"阅读器源码放在 WSL 里"的那台开发机。
 * 要发给别人的那份会用另一个模式（自带 node、不依赖 WSL），见 tools/win/README.md。
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));
const DRY = process.argv.includes('--dry-run');
const EXE_NAME = 'MarkdownObserver.exe';
/** 服务端口。**必须固定**：浏览器的设置/背景图/阅读位置都按"源"（含端口）存，端口一变全丢。
 *  这也是"双击第二篇"能被复用的前提——服务自己认得出"端口上那个是我自己"。 */
const PORT = 47821;
/** 认作 markdown 的扩展名：和 serve.mjs、app.js 保持一致。.txt 不抢。 */
const EXTS = ['.md', '.markdown', '.mdown', '.mkd'];
/** 右键菜单里显示的那句话。 */
const VERB_LABEL = '用 Markdown Observer 阅读';

if (process.platform === 'win32') {
  console.error('This installer must run inside WSL (it calls wsl.exe). For a Windows-native install use the portable package instead.');
  process.exit(1);
}

/** 跑一个 Windows 命令，返回去掉 BOM 与换行的 stdout。 */
function win(command, args) {
  const out = execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return out.replace(/^\uFEFF/, '').trim();
}

/** 取一个 Windows 环境变量（%LOCALAPPDATA% 之类）。 */
function winEnv(name) {
  return win('cmd.exe', ['/c', 'echo', '%' + name + '%']);
}

/** WSL 路径 → Windows 路径（\\wsl.localhost\Ubuntu\home\...）。 */
function toWindowsPath(path) {
  return win('wslpath', ['-w', path]);
}

/**
 * 在 OpenWithProgids 下声明一条：告诉 Windows"这类文件我（也）能打开"。
 * 正统写法是 REG_NONE 空值；个别系统上 reg.exe 会给 REG_NONE 配空数据时报错，那就退回空 REG_SZ——
 * 两种写法 Windows 都认。
 */
function regDeclareOpenWith(key, name) {
  try {
    regAdd(key, name, 'REG_NONE', '');
  } catch {
    regAdd(key, name, 'REG_SZ', '');
  }
}

/** 写一条注册表值。 */
function regAdd(key, name, type, data) {
  const args = ['add', key, '/f'];
  if (name === null) args.push('/ve');
  else args.push('/v', name);
  args.push('/t', type, '/d', data);
  if (DRY) {
    console.log('  reg add ' + key + (name === null ? '' : ' /v ' + name) + ' /t ' + type + ' /d ' + JSON.stringify(data));
    return;
  }
  win('reg.exe', args);
}

// ── 0. 先看清楚要装到哪儿 ────────────────────────────────────────────────
const localAppData = winEnv('LOCALAPPDATA');            // C:\Users\xxx\AppData\Local
const installWin = localAppData + '\\MarkdownObserver';
const installWsl = win('wslpath', ['-u', installWin]);  // /mnt/c/Users/xxx/AppData/Local/MarkdownObserver
const distro = process.env.WSL_DISTRO_NAME ?? win('wsl.exe', ['-l', '-q']).split(/\r?\n/)[0];
const user = userInfo().username;
const runner = join(HERE, 'run-server.sh');

console.log('Markdown Observer - install "Open with" (Windows)');
console.log('  install dir : ' + installWin);
console.log('  WSL         : ' + distro + ' / ' + user);
console.log('  reader repo : ' + REPO);
console.log('');

// ── 1. 启动器 ────────────────────────────────────────────────────────────
const exeSource = join(HERE, EXE_NAME);
if (!existsSync(exeSource)) {
  console.log('- launcher not built yet - building it once');
  if (!DRY) execFileSync(process.execPath, [join(HERE, 'build-launcher.mjs')], { stdio: 'inherit' });
}
/*
  先让"正在跑的那个旧版本"退干净再覆盖：托盘进程会占着 exe 文件，
  不先停掉的话复制会失败（而且这种失败报出来不一定看得懂）。
*/
if (!DRY && existsSync(join(installWsl, EXE_NAME))) {
  console.log('- stopping the running tray/service first');
  try {
    execFileSync(join(installWsl, EXE_NAME), ['--quit'], { stdio: 'ignore', timeout: 15000 });
  } catch {
    // 没在跑、或者停不掉：下面还有一招
  }
  await new Promise((resolve) => setTimeout(resolve, 1500));
  // 还赖着就强杀：老版本的托盘不认新版的控制口，留着它会挡住新托盘（也挡住这次复制）
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Get-Process MarkdownObserver -ErrorAction SilentlyContinue | Stop-Process -Force'], { stdio: 'ignore' });
  } catch {
    // 没有进程可杀也是正常的
  }
  // 服务还活着？多半是旧版本不认 /api/quit。它一直在跑的话，新代码不会生效——得说一声。
  let serviceAlive = false;
  try {
    const probe = await fetch('http://127.0.0.1:' + PORT + '/api/info', { signal: AbortSignal.timeout(1500) });
    serviceAlive = probe.ok;
  } catch {
    serviceAlive = false;
  }
  if (serviceAlive) {
    console.log('! a service is still running on port ' + PORT + ' (an older build may not know /api/quit).');
    console.log('  It keeps serving the OLD code until it exits. To stop it for sure:');
    console.log('    wsl.exe -d ' + distro + ' -u ' + user + ' -e /bin/bash ' + join(HERE, 'stop-servers.sh'));
    console.log('');
  }
}

if (!DRY) {
  mkdirSync(installWsl, { recursive: true });
  copyFileSync(exeSource, join(installWsl, EXE_NAME));
}
console.log('- launcher  -> ' + installWin + '\\' + EXE_NAME);

// ── 2. 配置：告诉启动器"双击之后该干什么" ────────────────────────────────
//    args 用 | 分隔，{file} 会被换成（转换过路径的）md 文件。
//    --quiet：无人值守，不往控制台打字；--open：起好服务自己开浏览器。
//  端口必须**固定**：浏览器的设置、背景图、阅读位置都是按"源"（含端口）存的，
//  端口一变，用户看到的就是"我的设置全丢了"。抢端口的问题由 serve.mjs 自己解决——
//  端口上已经跑着我们自己的服务时，它会把这篇交给那个服务然后退出（不会打架）。
//  也不传 --idle：这是常驻的"总管后台"，本来就该一直待着。
const args = [
  '-d', distro,
  '-u', user,
  '-e', '/bin/bash', runner,
  '--file', '{file}',
  '--port', String(PORT),
  '--quiet',
  '--open',
];
const config = [
  '# Markdown Observer launcher config (generated by tools/win/install.mjs)',
  '# command: program that starts the service; args: its arguments (|-separated, {file} = the double-clicked file)',
  '# pathmap: wsl = convert C:\\x to /mnt/c/x; native = pass through to a Windows program',
  '# port   : service port; must match --port in args (the launcher probes it)',
  '# tray   : show the notification-area icon (on / off)',
  'command = wsl.exe',
  'pathmap = wsl',
  'port = ' + PORT,
  'tray = on',
  'args = ' + args.join('|'),
  '',
].join('\r\n');
if (DRY) {
  console.log('- config    -> config.txt would be:');
  for (const line of config.split('\r\n')) if (line.length > 0) console.log('    ' + line);
} else {
  writeFileSync(join(installWsl, 'config.txt'), config, 'utf8');
}
console.log('- config    -> config.txt (on double-click: wsl.exe -> run-server.sh --file {file} --port ' + PORT + ' --open)');

// ── 3. 注册表 ────────────────────────────────────────────────────────────
const exeWin = installWin + '\\' + EXE_NAME;
const command = '"' + exeWin + '" "%1"';
const classes = 'HKCU\\Software\\Classes';
const progId = 'MarkdownObserver.md';

console.log('- registry  ->');
// 3a. ProgID：这类文件叫什么、用什么图标、怎么打开
regAdd(classes + '\\' + progId, null, 'REG_SZ', 'Markdown 文档');
regAdd(classes + '\\' + progId + '\\DefaultIcon', null, 'REG_SZ', exeWin + ',0');
regAdd(classes + '\\' + progId + '\\shell\\open\\command', null, 'REG_SZ', command);
// 3b. 让它在"打开方式"里出现（每个扩展名都要声明一次）
for (const ext of EXTS) {
  regDeclareOpenWith(classes + '\\' + ext + '\\OpenWithProgids', progId);
}
// 3c. 右键菜单项（挂在 SystemFileAssociations 上，跟默认程序无关，永远都在）
for (const ext of EXTS) {
  const verb = classes + '\\SystemFileAssociations\\' + ext + '\\shell\\MarkdownObserver';
  regAdd(verb, null, 'REG_SZ', VERB_LABEL);
  regAdd(verb, 'Icon', 'REG_SZ', exeWin + ',0');
  regAdd(verb + '\\command', null, 'REG_SZ', command);
}
// 3d. 让它作为"一个应用"被 Windows 认识（默认应用设置页、任务栏跳转都看这个）
const appKey = classes + '\\Applications\\' + EXE_NAME;
regAdd(appKey + '\\shell\\open\\command', null, 'REG_SZ', command);
regAdd(appKey, 'FriendlyAppName', 'REG_SZ', 'Markdown Observer');
for (const ext of EXTS) {
  regAdd(appKey + '\\SupportedTypes', ext, 'REG_SZ', '');
}

// 3e. 登记到"设置 → 应用"里，好让不跑命令行的人也能卸载
const uninstallKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\MarkdownObserver';
console.log('- uninstall entry -> will show up in Settings > Apps');
regAdd(uninstallKey, 'DisplayName', 'REG_SZ', 'Markdown Observer');
regAdd(uninstallKey, 'DisplayIcon', 'REG_SZ', exeWin + ',0');
regAdd(uninstallKey, 'InstallLocation', 'REG_SZ', installWin);
regAdd(uninstallKey, 'UninstallString', 'REG_SZ', '"' + exeWin + '" --uninstall');
regAdd(uninstallKey, 'NoModify', 'REG_DWORD', '1');
regAdd(uninstallKey, 'NoRepair', 'REG_DWORD', '1');

// ── 4. 告诉 Explorer "关联变了"，省得重启资源管理器 ──────────────────────
if (!DRY) {
  const script = [
    'Add-Type -Namespace Mo -Name Shell -MemberDefinition \'[DllImport("shell32.dll")] public static extern void SHChangeNotify(int a, int b, IntPtr c, IntPtr d);\';',
    '[Mo.Shell]::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero)',
  ].join(' ');
  try {
    win('powershell.exe', ['-NoProfile', '-Command', script]);
  } catch {
    console.log('  (could not notify Explorer - restarting it works too)');
  }
}

console.log('');
console.log(DRY ? '(--dry-run: nothing was changed)' : 'Done.');
console.log('Next: right-click any .md -> "Open with Markdown Observer".');
console.log('To make it the default: right-click -> Open with -> Choose another app -> Markdown Observer -> Always.');
console.log('To uninstall: node tools/win/uninstall.mjs');
