#!/usr/bin/env node
/**
 * release.mjs —— 把分享包打成一个 zip，方便直接发人 / 挂到 GitHub Release。
 *
 * 为什么自己写 zip 而不是调用系统命令：Windows、WSL、macOS 上有没有 zip 命令全看运气
 * （本机就没有）。Node 自带 zlib，把 zip 的几十行写在代码里，就能保证"一条命令到处一样"。
 *
 * 产物：markdown-observer-v<版本>.zip，里面是 share/ 的三件套（相对路径，解压不套一层目录）：
 *   markdown-observer.html   阅读器本体，双击即用
 *   HOW-TO-OPEN.txt        给收件人看的三行说明
 *   sample.md              一篇示例，收到就能试
 *
 * 跑法：
 *   node tools/release.mjs            # 版本号取最近的 git tag（v1.0 → 1.0），没有 tag 就用 1.0
 *   node tools/release.mjs 1.2        # 指定版本号
 *   node tools/release.mjs --no-build # 不重新构建分享包，只打包现有的 share/
 */
import { deflateRawSync } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const SHARE = join(APP, 'share');

// ── zip 需要的两样底层东西：CRC32 和"DOS 时间" ─────────────────────────────

/** 标准 CRC32（zip 每个文件头里都要写）。 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** zip 用的是 1980 纪元的 DOS 时间：日期 2 字节 + 时间 2 字节。 */
function dosDateTime(date) {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (Math.floor(date.getSeconds() / 2)),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * 打包成 zip（每个文件单独 deflate，够小也够快；本地小文件不值得做流式压缩）。
 * @param {Array<{ name: string, data: Buffer, mtime: Date }>} entries 要打进包里的文件（name 用正斜杠）
 * @returns {Buffer} 完整的 zip 字节
 */
function makeZip(entries) {
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const crc = crc32(entry.data);
    const packed = deflateRawSync(entry.data, { level: 9 });
    const stamp = dosDateTime(entry.mtime);

    const local = Buffer.alloc(30 + name.length);
    local.writeUInt32LE(0x04034b50, 0);      // 本地文件头签名
    local.writeUInt16LE(20, 4);              // 需要的解压版本 2.0
    local.writeUInt16LE(0x0800, 6);          // 标志位：文件名是 UTF-8
    local.writeUInt16LE(8, 8);               // 压缩方式：deflate
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(packed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);              // 扩展字段长度
    name.copy(local, 30);
    locals.push(local, packed);

    const central = Buffer.alloc(46 + name.length);
    central.writeUInt32LE(0x02014b50, 0);    // 中央目录头签名
    central.writeUInt16LE(20, 4);            // 打包工具版本
    central.writeUInt16LE(20, 6);            // 需要的解压版本
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(packed.length, 20);
    central.writeUInt32LE(entry.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);            // 扩展字段
    central.writeUInt16LE(0, 32);            // 注释
    central.writeUInt16LE(0, 34);            // 所在分卷
    central.writeUInt16LE(0, 36);            // 内部属性
    central.writeUInt32LE((0o100644 << 16) >>> 0, 38); // 外部属性：普通文件 rw-r--r--（>>> 0 是因为 JS 的 << 会返回有符号数）
    central.writeUInt32LE(offset, 42);       // 本地文件头的偏移
    name.copy(central, 46);
    centrals.push(central);

    offset += local.length + packed.length;
  }

  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);          // 中央目录结束记录
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

// ── 主流程 ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noBuild = args.includes('--no-build');
const explicit = args.find((arg) => !arg.startsWith('-'));

/** 版本号：命令行 > 最近的 git tag > 1.0 */
function version() {
  if (explicit !== undefined) return explicit.replace(/^v/, '');
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (tag !== '') return tag.replace(/^v/, '');
  } catch { /* 还没有 tag */ }
  return '1.0';
}

if (!noBuild) {
  execFileSync(process.execPath, [join(APP, 'tools', 'build-share.mjs')], { cwd: APP, stdio: 'inherit' });
}

if (!existsSync(SHARE)) {
  console.error('没有 share/ 目录：先跑一次 node tools/build-share.mjs（或去掉 --no-build）');
  process.exit(1);
}

const names = readdirSync(SHARE).filter((name) => !name.startsWith('.')).sort();
if (names.length === 0) {
  console.error('share/ 是空的：先跑一次 node tools/build-share.mjs');
  process.exit(1);
}

const entries = names.map((name) => {
  const path = join(SHARE, name);
  return { name, data: readFileSync(path), mtime: statSync(path).mtime };
});

const tag = 'v' + version();
const target = join(APP, 'markdown-observer-' + tag + '.zip');
const zip = makeZip(entries);
writeFileSync(target, zip);

/** 跑一条 git 命令；失败或没装 git 就返回 null。 */
function git(args) {
  try {
    return execFileSync('git', args, { cwd: APP, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch { return null }
}

const dirty = git(['status', '--porcelain']);
const hasTag = (git(['tag', '--list', tag]) ?? '') !== '';
const remote = git(['remote', 'get-url', 'origin']);
const kb = (bytes) => Math.round(bytes / 1024) + ' KB';

console.log('打包完成：' + target);
console.log('  版本：' + tag + '（' + kb(zip.length) + '，压缩前 ' + kb(entries.reduce((sum, e) => sum + e.data.length, 0)) + '）');
for (const entry of entries) console.log('  包含：' + entry.name + '（' + kb(entry.data.length) + '）');

/*
  顺手把"发布还差什么"列出来：这些判断都是 git 问几句话就有答案的，
  与其写在文档里让人自己对照，不如让工具直接说清现在走到哪一步。
*/
console.log('');
console.log('发布检查（' + tag + '）');
console.log('  ' + (dirty === '' ? '✓' : '·') + ' 工作区' + (dirty === '' ? '干净' : '有 ' + String(dirty.split('\n').length) + ' 处未提交改动'));
console.log('  ' + (hasTag ? '✓' : '·') + ' 本地 tag ' + tag + (hasTag ? ' 已存在' : ' 还没有'));
console.log('  ' + (remote === null ? '·' : '✓') + ' 远程仓库 ' + (remote ?? '还没配 origin'));
console.log('  ✓ 发布包 ' + target.split('/').pop());

console.log('');
console.log('接着三步：');
console.log('  1. 提交推送     git add -A && git commit -m "..." && git push');
console.log('  2. 打 tag 推送  git tag -a ' + tag + ' -m "Markdown Observer ' + tag + '" && git push origin ' + tag);
console.log('  3. 建 Release   网页：仓库 → Releases → Draft a new release → 选 tag ' + tag);
console.log('                  → 把 ' + target.split('/').pop() + ' 拖进 Attach binaries → Publish');
console.log('                  （装了 gh 之后一条就够：gh release create ' + tag + ' "' + target + '" --title "' + tag + '" --generate-notes）');
console.log('  · 别把这个 zip 提交进仓库：它是构建产物，Release 的附件不占仓库体积。');

console.log('');
console.log('Release 说明可以直接用这段：');
console.log('----------------------------------------------------------');
console.log('Markdown Observer ' + tag);
console.log('');
console.log('在浏览器里安静读 markdown 的小工具：排版与 DeepSeek Harness 的聊天正文一致，带目录、搜索、深色模式、可换背景；只读不改、不联网、不上传。');
console.log('');
console.log('**怎么用**：下载下面的 ' + target.split('/').pop() + '，解开后双击 markdown-observer.html（推荐 Chrome / Edge）。不用装任何东西，断网也能用。');
console.log('');
console.log('**这一版**：');
console.log('- 首次发布：单文件版 + 服务模式（读整个文件夹、某一节的链接可以分享给别人）');
console.log('');
console.log('**需要什么**：Chrome / Edge（「打开文件夹」用到它们的能力；其它浏览器直接拖入单个文件即可）。');
console.log('----------------------------------------------------------');
