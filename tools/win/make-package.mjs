/*
  make-package.mjs —— 做一个"双击就能装"的安装程序（无需任何前置：Node 运行时一起打包）。

  产物：dist/Markdown Observer 安装程序.exe

  它是怎么拼出来的（自解压的老办法，简单又可靠）：
      安装程序.exe = [用 csc 编出来的 setup.exe][前压缩后的文件包][8 字节长度][8 字节魔数]
    安装程序运行时读自己的尾巴 → 解开 → 落到安装目录 → 调用 tools/win/install.mjs 做注册表和配置。
  这样做的好处：安装逻辑只有一份（install.mjs / uninstall.mjs），GUI 只是个壳。

  用法：node tools/win/make-package.mjs [--node <node.exe 路径>]
*/
import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { deflateRawSync } from 'node:zlib';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// 版本号的唯一来源（git tag，见文件里的说明）
import { readVersion, versionTag } from '../version.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const APP = dirname(dirname(HERE));        // 仓库根目录（= 安装后那个目录的样子）
const DIST = join(APP, 'dist');
// 版本号的唯一来源（见 tools/version.mjs：读 git tag）
const version = readVersion();

// ── 要打进包里的东西（相对仓库根目录）──────────────────────────────────
const FILES = [
  'index.html',
  'serve.mjs',
  'js/app.js',
  'styles/base.css', 'styles/controls.css', 'styles/design-platform.css',
  'styles/gradient-shadow-text.css', 'styles/highlight-dsh.css', 'styles/markdown.css',
  'styles/reader.css', 'styles/scrollbar.css', 'styles/shiki.css', 'styles/tuning.css',
  'tools/win/MarkdownObserver.exe',
  'tools/win/install.mjs', 'tools/win/uninstall.mjs', 'tools/win/status.mjs', 'tools/win/make-icon.py',
  'tools/win/markdown-observer.ico',
  // 文档也带上：装完的目录里有一份说明，朋友点开就能看（也是"关于这个软件"的入口）
  'README.md',
  'DEVELOPING.md',
  'sample.md',
];
// vendor/ 里是第三方库（marked / katex / DOMPurify / highlight 之类），整个目录都要
function walk(dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(relative(APP, full).split('\\').join('/'));
  }
  return out;
}
for (const extra of ['vendor', 'js/lib']) if (existsSync(join(APP, extra))) FILES.push(...walk(join(APP, extra)));

// ── Node 运行时：默认借用这台机器上装的那个（同一个版本，不用联网下载）──
/** 读一个 Windows 可执行文件的架构（就是 PE 头里那个 Machine 字段）。 */
function peArch(file) {
  const data = readFileSync(file);
  if (data.length < 0x40 || data.toString('ascii', 0, 2) !== 'MZ') return null;
  const peOffset = data.readUInt32LE(0x3c);
  if (data.toString('ascii', peOffset, peOffset + 4) !== 'PE\0\0') return null;
  const machine = data.readUInt16LE(peOffset + 4);
  if (machine === 0x8664) return 'x64';
  if (machine === 0xaa64) return 'arm64';
  if (machine === 0x14c) return 'x86';
  return 'unknown(0x' + machine.toString(16) + ')';
}

const archArg = process.argv.includes('--arch') ? process.argv[process.argv.indexOf('--arch') + 1] : null;
const nodeArg = process.argv.indexOf('--node');
const nodePath = nodeArg >= 0 && process.argv[nodeArg + 1] !== undefined
  ? process.argv[nodeArg + 1]
  : '/mnt/c/Program Files/nodejs/node.exe';
if (!existsSync(nodePath)) {
  console.error('找不到 node.exe：' + nodePath);
  console.error('用 --node <路径> 指定一个（Windows 上装了 Node 就有）。');
  process.exit(1);
}
const nodeArch = peArch(nodePath);
/*
  架构核对。默认跟着 node.exe 走，也可以用 --arch 显式指定；
  两者对不上就直接拒绝打包——"arm64 版里装了个 x64 的 node"这种错，
  在开发机上完全看不出来，等到别人的 ARM 电脑上才炸，那时候排查成本极高。
*/
const arch = archArg ?? nodeArch;
if (archArg !== null && nodeArch !== archArg) {
  console.error('✗ node.exe 是 ' + nodeArch + ' 的，和 --arch ' + archArg + ' 对不上，拒绝打包');
  process.exit(1);
}
console.log('node runtime: ' + nodePath);
console.log('  ' + (statSync(nodePath).size / 1024 / 1024).toFixed(0) + ' MB, ' + nodeArch + ' → 本次打包标记为 ' + arch);

// 中间产物放 Windows 的临时目录：Windows 程序往 WSL 的 UNC 路径写文件不一定被允许
const winTemp = execFileSync('cmd.exe', ['/c', 'echo', '%TEMP%'], { encoding: 'utf8' }).replace(/\r?\n/g, '').trim();
const winTempSlash = execFileSync('wslpath', ['-u', winTemp], { encoding: 'utf8' }).trim();
const stagingWin = winTemp + '\\markdown-observer-setup.exe';
const stagingWsl = winTempSlash + '/markdown-observer-setup.exe';

// ── 打文件包：一个"行式索引 + 内容"的整体，压缩后贴到 setup.exe 后面 ────
const parts = [];
const index = [];
let offset = 0;
for (const rel of FILES) {
  const full = join(APP, rel);
  if (!existsSync(full)) { console.warn('  跳过（不存在）：' + rel); continue; }
  const data = readFileSync(full);
  index.push(rel + '\t' + data.length + '\t' + offset);
  parts.push(data);
  offset += data.length;
}
const nodeSize = statSync(nodePath).size;
index.push('node.exe\t' + nodeSize + '\t' + offset);
parts.push(readFileSync(nodePath));
offset += nodeSize;
/*
  版本号（唯一来源：tools/version.mjs → git tag）。
  安装程序靠它判断"装过没有、是更新、修复还是降级"；"设置 → 应用"里显示的也是它。
*/
const versionData = Buffer.from(version + '\n', 'utf8');
index.push('version.txt\t' + versionData.length + '\t' + offset);
parts.push(versionData);
offset += versionData.length;

// ── 编 setup.exe ────────────────────────────────────────────────────────
/*
  图标除了 /win32icon（文件图标）之外，还要作为**程序内资源**编一份：
  窗口图标不能靠 ExtractAssociatedIcon 去问外壳——从 \\wsl.localhost\... 这种共享路径上
  它会直接失败，窗口就只剩系统默认的空白图标（这个坑踩过）。
  csc 的 /resource: 不认 UNC，所以先用 cmd 把 ico 搬到 Windows 本地临时目录。
*/
const stampLocal = winTemp + '\\md-observer-version.txt';
const stampTmp = join(HERE, '.version.tmp');
writeFileSync(stampTmp, version + '\n');
try {
  execFileSync('cmd.exe', ['/c', 'copy', '/y', toWindowsPath(stampTmp), stampLocal], { stdio: 'ignore' });
} finally {
  rmSync(stampTmp, { force: true });
}
const iconLocal = winTemp + '\\md-observer-icon.ico';
execFileSync('cmd.exe', ['/c', 'copy', '/y', toWindowsPath(join(HERE, 'markdown-observer.ico')), iconLocal], { stdio: 'ignore' });
const csc = findCsc();
console.log('compiler: ' + csc);
execFileSync(csc, [
  '/nologo', '/target:winexe', '/optimize+', '/platform:anycpu',
  '/out:' + stagingWin,
  '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
  '/win32icon:' + toWindowsPath(join(HERE, 'markdown-observer.ico')),
  '/resource:' + iconLocal + ',AppIcon',
  '/resource:' + stampLocal + ',AppVersion',
  toWindowsPath(join(HERE, 'setup.cs')),
], { stdio: 'inherit', cwd: winTempSlash });

const header = Buffer.from(index.join('\n'), 'utf8');
const headerLength = Buffer.alloc(4);
headerLength.writeUInt32LE(header.length, 0);
// 注意：.NET 的 DeflateStream 认的是「裸 deflate」，所以这里必须用 deflateRawSync
const packed = deflateRawSync(Buffer.concat([headerLength, header, ...parts]), { level: 9 });

// ── 收尾：把包贴到 setup.exe 后面 ───────────────────────────────────────
const base = readFileSync(stagingWsl);
const lengthField = Buffer.alloc(8);
lengthField.writeUInt32LE(packed.length, 0);
const magic = Buffer.from('MDOBSET1', 'ascii');   // 正好 8 字节，和 setup.cs 对得上
mkdirSync(DIST, { recursive: true });
// 名字里带版本和架构；x64 保持原来的样子（大家习惯了这个），别的架构加后缀
const outputName = 'Markdown-Observer-Installer-v' + version + (arch === 'x64' ? '' : '-' + arch) + '.exe';
const output = join(DIST, outputName);
writeFileSync(output, Buffer.concat([base, packed, lengthField, magic]));
chmodSync(output, 0o755);

console.log('');
/*
  自检：包里有没有"构建机的痕迹"。
  安装包必须自包含——目标电脑上什么都不用装。真正会破坏这一点的是
  **代码里写死的绝对路径**（C:\Users\某人\... 或 /home/某人/...）：
  文档里出现无所谓（那只是例子），代码里出现就是 bug。这里只扫代码文件。
*/
const CODE_EXT = /\.(mjs|js|html|css)$/i;
const NEEDLES = ['C:\\Users\\', '/home/', '/mnt/c/'];
const leaks = [];
for (const rel of FILES) {
  if (!CODE_EXT.test(rel)) continue;
  const text = readFileSync(join(APP, rel), 'utf8');
  for (const needle of NEEDLES) {
    const at = text.indexOf(needle);
    if (at < 0) continue;
    // 注释里的示例路径不算数（文档/注释里举例子很正常）
    const lineStart = text.lastIndexOf('\n', at) + 1;
    const lineEnd = text.indexOf('\n', at) === -1 ? text.length : text.indexOf('\n', at);
    const line = text.slice(lineStart, lineEnd).trim();
    if (line.startsWith('//') || line.startsWith('*') || line.startsWith('/*') || line.startsWith('#')) continue;
    // 行尾注释里的例子也不算（比如 const x = f();   // C:\Users\xxx\...）
    const commentAt = text.slice(lineStart, lineEnd).indexOf('//');
    if (commentAt >= 0 && at - lineStart > commentAt) continue;
    leaks.push(rel + ' 里有 ' + needle + '：…' + text.slice(Math.max(0, at - 24), at + 36).replace(/\s+/g, ' ') + '…');
  }
}
if (leaks.length > 0) {
  console.warn('  ⚠ 包里的代码写死了本机路径（换台电脑可能就坏）：');
  for (const line of leaks.slice(0, 8)) console.warn('      ' + line);
} else {
  console.log('  self-check: 代码里没有构建机路径，目标机零依赖');
}
console.log('  node runtime: ' + execFileSync(nodePath, ['--version'], { encoding: 'utf8' }).trim() + '（装到目标机后不需要任何外部依赖）');
console.log('');
console.log('done -> ' + output);
console.log('  payload : ' + (offset / 1024 / 1024).toFixed(1) + ' MB -> packed ' + (packed.length / 1024 / 1024).toFixed(1) + ' MB');
console.log('  installer: ' + (statSync(output).size / 1024 / 1024).toFixed(1) + ' MB, version ' + versionTag() + ', ' + arch);

function toWindowsPath(p) {
  const match = /^\/mnt\/([a-z])\/(.*)$/.exec(p);
  if (match) return match[1].toUpperCase() + ':\\' + match[2].replace(/\//g, '\\');
  // 仓库在 WSL 里：转成 \\wsl.localhost\Ubuntu\home\... 编译器才认
  const distro = process.env.WSL_DISTRO_NAME ?? 'Ubuntu';
  return '\\\\wsl.localhost\\' + distro + '\\' + p.replace(/^\//, '').replace(/\//g, '\\');
}

function findCsc() {
  const candidates = [
    '/mnt/c/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',
    '/mnt/c/Windows/Microsoft.NET/Framework/v4.0.30319/csc.exe',
  ];
  for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  console.error('找不到 csc.exe（.NET Framework 自带的 C# 编译器）');
  process.exit(1);
}
