/*
  一次性打出所有产物。

  三条设计目标（按使用者的要求）：
    · **可插拔**：产物就是下面 STEPS 那张表，加一行多一个产物、删一行少一个，
      不需要动流程代码；
    · **一步崩了不影响后面**：每个步骤都是独立子进程，失败只记下来，接着跑下一个；
    · **fail loud**：最后统一汇总——谁成功谁失败、失败的最后几行输出是什么，
      有任何一个失败就以非 0 退出（CI 和"我到底打全了没有"都靠这个）。

  用法：
    node tools/build-all.mjs                     # 全部
    node tools/build-all.mjs --only vscode zip   # 只打指定的几个
    node tools/build-all.mjs --skip windows-arm64
    node tools/build-all.mjs --with-tests        # 打完再跑一遍自测
    node tools/build-all.mjs --list              # 看看有哪些步骤

  （npm run build 等价于 node tools/build-all.mjs）
*/
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { versionTag } from './version.mjs';

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const BUILD = join(APP, 'build');
/** ARM64 那份 node 放在 build/ 下（不进库；下次复用，不用重复下载）。 */
const ARM64_DIR = join(BUILD, 'tools', 'node-arm64');
const ARM64_NODE = join(ARM64_DIR, 'node.exe');
/** 和 x64 那份保持同一个版本：两端行为一致，排查问题少一个变量。 */
const NODE_VERSION = '24.21.0';

/** 缺 ARM64 的 node 就取一份官方的 —— 这一步失败只影响 windows-arm64。 */
async function ensureArm64Node() {
  if (existsSync(ARM64_NODE)) return;
  const url = 'https://nodejs.org/dist/v' + NODE_VERSION + '/node-v' + NODE_VERSION + '-win-arm64.zip';
  const zip = join(ARM64_DIR, 'node-arm64.zip');
  mkdirSync(ARM64_DIR, { recursive: true });
  console.log('  （本机还没有 ARM64 的 node，从 nodejs.org 取一份，约 32 MB）');
  let res;
  try {
    res = await fetch(url);
  } catch (error) {
    throw new Error('连不上 nodejs.org（' + error.message + '）。可以自己下载 ' + url
      + '，解出 node.exe 之后用 --node <路径> 重新打包，或先跳过这一步：--skip windows-arm64');
  }
  if (!res.ok) throw new Error('下载 ARM64 node 失败：HTTP ' + res.status + '（' + url + '）');
  writeFileSync(zip, Buffer.from(await res.arrayBuffer()));
  // 解压：Windows 用系统自带的 PowerShell，其它平台用 python3；都不额外装东西
  if (process.platform === 'win32') {
    execFileSync('powershell.exe', ['-NoProfile', '-Command',
      'Expand-Archive -Force -LiteralPath "' + zip + '" -DestinationPath "' + ARM64_DIR + '"'], { stdio: 'ignore' });
  } else {
    execFileSync('python3', ['-c',
      'import sys, zipfile; zipfile.ZipFile(sys.argv[1]).extractall(sys.argv[2])', zip, ARM64_DIR], { stdio: 'ignore' });
  }
  // 官方包里 node.exe 在子目录里，挪到固定位置
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name === 'node.exe') found.push(path);
    }
  };
  walk(ARM64_DIR);
  const source = found.find((path) => path !== ARM64_NODE);
  if (source === undefined) throw new Error('解压后没找到 node.exe');
  copyFileSync(source, ARM64_NODE);
  rmSync(zip, { force: true });
}

/** 自测（默认不跑，加 --with-tests 才跑；任何一套失败都算这一步失败）。 */
const testSteps = ['', '--server', '--single', '--standalone'].map((mode) => ({
  name: 'test' + (mode === '' ? '-default' : mode.replace('--', '-')),
  title: '自测 node tools/smoke.mjs ' + mode,
  run: [process.execPath, ['tools/smoke.mjs', ...(mode === '' ? [] : [mode])]],
  offByDefault: true,   // 平时不跑；--with-tests 或 --only test-xxx 才跑
}));
testSteps.push({ name: 'test-vscode', title: '自测 node tools/vscode/smoke.mjs', run: [process.execPath, ['tools/vscode/smoke.mjs']], offByDefault: true });

/*
  ── 产物清单 ────────────────────────────────────────────────────────────
  加一个产物 = 往数组里加一项：
    name   命令行里 --only/--skip 用的名字
    title  人看的说明
    run    [命令, 参数数组]，或者 (ctx) => [命令, 参数数组]
    prepare  可选，(ctx) => Promise，跑 run 之前的前置（失败即这一步失败）
*/
const STEPS = [
  { name: 'sample', title: '内置示例 sample.md → js/sample.js', run: [process.execPath, ['tools/build-sample.mjs']] },
  { name: 'html', title: '单文件 HTML（发给朋友那种）', run: [process.execPath, ['tools/build-standalone.mjs']] },
  { name: 'share', title: '分享包 build/share/', run: [process.execPath, ['tools/build-share.mjs']] },
  // share 上一步刚打过，这里别再打一次
  { name: 'zip', title: '发布 zip（含说明与示例）', run: [process.execPath, ['tools/release.mjs', '--no-build']] },
  { name: 'windows-x64', title: 'Windows 安装包（x64）', run: [process.execPath, ['tools/win/make-package.mjs']] },
  {
    name: 'windows-arm64',
    title: 'Windows 安装包（ARM64）',
    prepare: ensureArm64Node,
    run: () => [process.execPath, ['tools/win/make-package.mjs', '--node', ARM64_NODE]],
  },
  { name: 'vscode', title: 'VS Code 插件（.vsix）', run: [process.execPath, ['tools/vscode/build.mjs', '--package']] },
  ...testSteps,
];

// ── 参数 ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? [] : args.slice(at + 1).filter((arg) => !arg.startsWith('--'));
};
const only = valueOf('--only');
const skip = valueOf('--skip');

if (args.includes('--list')) {
  for (const step of STEPS) console.log('  ' + step.name.padEnd(15) + step.title);
  process.exit(0);
}

const withTests = args.includes('--with-tests');
const chosen = STEPS.filter((step) => {
  if (skip.includes(step.name)) return false;
  if (only.length > 0) return only.includes(step.name);      // 点名就跑（自测也能点名）
  return !(step.offByDefault === true && !withTests);         // 没点名时，自测要 --with-tests
});
if (chosen.length === 0) {
  console.error('没有要跑的步骤（检查 --only/--skip 的名字，用 --list 看）');
  process.exit(1);
}
console.log('构建 ' + versionTag() + '：' + chosen.length + ' 个步骤');
console.log('');

// ── 跑 ──────────────────────────────────────────────────────────────────
const results = [];
for (const step of chosen) {
  const label = step.name.padEnd(15);
  process.stdout.write('  ▶ ' + label + step.title + ' … ');
  const started = Date.now();
  try {
    if (typeof step.prepare === 'function') await step.prepare({});
    const command = typeof step.run === 'function' ? step.run({}) : step.run;
    /*
      刻意**不传 cwd**：从 WSL 里把工作目录设成仓库路径时，Windows 那边看到的是
      \\wsl.localhost\... （UNC），而 cmd.exe 拒绝把 UNC 当当前目录，
      打包脚本里那几个 cmd.exe 调用就会 spawn 失败——而手工在终端里跑却没事，
      极难排查。让子进程继承调用者的工作目录即可，所有步骤用的都是仓库绝对路径。
    */
    execFileSync(command[0], command[1], { stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });
    const seconds = (Date.now() - started) / 1000;
    results.push({ step, status: 'ok', seconds });
    console.log('ok（' + seconds.toFixed(1) + 's）');
  } catch (error) {
    const seconds = (Date.now() - started) / 1000;
    results.push({ step, status: 'failed', seconds, error });
    console.log('失败（' + seconds.toFixed(1) + 's，继续跑后面的）');
  }
}

// ── 汇总（fail loud）───────────────────────────────────────────────────
console.log('');
console.log('结果：');
for (const item of results) {
  const mark = item.status === 'ok' ? '✓' : '✗';
  console.log('  ' + mark + ' ' + item.step.name.padEnd(15) + item.step.title + '  ' + item.seconds.toFixed(1) + 's');
}
const failed = results.filter((item) => item.status === 'failed');
if (failed.length > 0) {
  console.log('');
  console.log('有 ' + failed.length + ' 个步骤失败（其余步骤不受影响，已照常完成）：');
  for (const item of failed) {
    console.log('');
    console.log('  ✗ ' + item.step.name + ' —— ' + item.step.title);
    /*
      报错要打到点子上：命令失败时原因通常在输出的**最后**，而"压根没跑起来"这类
      错误（spawn 失败）原因在**最前**。所以两头都打，别只留一边。
    */
    const output = String(item.error.stdout ?? '') + String(item.error.stderr ?? '') + String(item.error.message ?? '');
    const lines = output.split('\n').map((line) => line.trim()).filter((line) => line !== '');
    const head = lines.slice(0, 6);
    const tail = lines.length > 10 ? lines.slice(-4) : [];
    for (const line of head) console.log('      ' + line.slice(0, 160));
    if (tail.length > 0) {
      console.log('      …（中间省略 ' + (lines.length - head.length - tail.length) + ' 行）');
      for (const line of tail) console.log('      ' + line.slice(0, 160));
    }
  }
  process.exit(1);
}
console.log('');
console.log('全部完成，产物都在 build/ 下。');
