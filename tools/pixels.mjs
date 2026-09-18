/**
 * pixels.mjs —— 唯一能证明"磨砂是透的、选中看得出来"的办法：真的截一张图，量像素。
 *
 * 为什么需要它：getComputedStyle 只能告诉你"声明写了什么"，
 * 写对了但看起来不对（例如深色主题下 0.42 的近黑底 = 一块实心黑按钮）它发现不了。
 *
 * 做法：
 *   1. tools/pixel-probe.html 把阅读器装进 iframe，按 ?theme=&bg= 摆好状态，打印要采样的坐标；
 *   2. 用 headless Chrome 截同一张页面，png 解码后量这些点到底是什么颜色；
 *   3. 断言三件事：
 *        · 按钮的底色接近它所在的面板（说明是淡的、不是实心块）；
 *        · 深色主题下按钮比面板"亮一点"（淡光），浅色主题下比面板"暗一点"（淡墨）；
 *        · 背景从"无背景"换成强渐变时，按钮的像素跟着变（说明它确实透出背后的东西）；
 *        · 分段控件里选中与未选中的像素明显不同（切换看得出状态）。
 *
 * 跑法：node tools/pixels.mjs
 * 它会自己起一个临时服务（端口 4398），跑完就关掉——不依赖、也不打扰你正在用的那个服务。
 * 想量自己的服务：READER_URL=http://127.0.0.1:4322 node tools/pixels.mjs
 * 机器上找不到 Chrome/Edge 就跳过，不算失败（WSL 里会用 Windows 侧那个）。
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = fileURLToPath(new URL('../', import.meta.url));
const WIDTH = 1400;
const HEIGHT = 900;
const TEST_PORT = Number(process.env.TEST_PORT ?? 4398);

/**
 * 服务地址：设了 READER_URL 就用它；否则自己起一个临时服务（跑完就关）。
 * 为什么要自己起：检查不该依赖"你恰好开着服务"，也不该因为端口不对就量到 Chrome 的错误页。
 */
async function startOwnServer() {
  const child = spawn(process.execPath, [join(APP, 'serve.mjs'), APP, '--port', String(TEST_PORT)], { stdio: 'ignore' });
  for (let i = 0; i < 50; i += 1) {
    try {
      const res = await fetch('http://127.0.0.1:' + TEST_PORT + '/api/info');
      if (res.ok) return { base: 'http://127.0.0.1:' + TEST_PORT, child };
    } catch { /* 还没起来 */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  child.kill();
  throw new Error('临时服务没能在端口 ' + TEST_PORT + ' 上起来（可能被占用，试试 TEST_PORT=4397）');
}

let BASE = process.env.READER_URL ?? null;
let own = null;
if (BASE === null) {
  own = await startOwnServer();
  BASE = own.base;
}

/** 找一个能用的 Chrome/Edge：先是 WSL 里的 Windows 版，再是 Linux 版。 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  const candidates = [
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome',
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

/** Windows 的 %TEMP% 换成 WSL 路径；Linux 下直接用系统临时目录。 */
function tempDir(chrome) {
  if (!chrome.startsWith('/mnt/')) return tmpdir();
  const out = spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8' });
  const win = out.stdout.trim().replace(/\r/g, '');
  if (win === '') return null;
  return { win, wsl: '/mnt/' + win[0].toLowerCase() + win.slice(2).replace(/\\/g, '/') };
}

function decodePng(buffer) {
  if (buffer.readUInt32BE(0) !== 0x89504e47) throw new Error('不是 PNG 文件');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  let bitDepth = 0;
  const parts = [];
  while (pos < buffer.length) {
    const length = buffer.readUInt32BE(pos);
    const type = buffer.toString('ascii', pos + 4, pos + 8);
    const data = buffer.subarray(pos + 8, pos + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error('不支持隔行扫描的 PNG');
    } else if (type === 'IDAT') parts.push(data);
    else if (type === 'IEND') break;
    pos += 12 + length;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (bitDepth !== 8 || channels === 0) throw new Error('只支持 8 位 RGB/RGBA 的 PNG（bit=' + bitDepth + ' type=' + colorType + '）');
  const raw = inflateSync(Buffer.concat(parts));
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  let read = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[read];
    read += 1;
    const line = raw.subarray(read, read + stride);
    read += stride;
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x += 1) {
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev === null ? 0 : prev[x];
      const c = prev === null || x < channels ? 0 : prev[x - channels];
      let value = line[x];
      if (filter === 1) value += a;
      else if (filter === 2) value += b;
      else if (filter === 3) value += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        value += pa <= pb && pa <= pc ? a : (pb <= pc ? b : c);
      }
      cur[x] = value & 0xff;
    }
  }
  return { width, height, channels, data: out };
}

function sample(image, x, y) {
  const cx = Math.max(0, Math.min(image.width - 1, x));
  const cy = Math.max(0, Math.min(image.height - 1, y));
  const at = (cy * image.width + cx) * image.channels;
  return [image.data[at], image.data[at + 1], image.data[at + 2]];
}

const lum = ([r, g, b]) => Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
const diff = (one, two) => Math.max(Math.abs(one[0] - two[0]), Math.abs(one[1] - two[1]), Math.abs(one[2] - two[2]));
const show = (rgb) => '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('');

let failures = 0;
function check(label, ok, detail) {
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + ' -> ' + detail);
}

const chrome = findChrome();
if (chrome === null) {
  console.log('没找到 Chrome / Edge，跳过像素检查（设 CHROME=... 可以指定）');
  process.exit(0);
}
const temp = tempDir(chrome);
if (temp === null || !existsSync(BASE)) { /* 服务没起时下面的 fetch 会报错，这里不额外处理 */ }

/** 跑一次 Chrome，返回 dump 出来的 DOM（用来拿坐标）。 */
function dump(url) {
  return execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1',
    '--window-size=' + WIDTH + ',' + HEIGHT, '--virtual-time-budget=12000', '--dump-dom', url,
  ], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
}

/** 跑一次 Chrome 截图，返回解码后的像素。 */
function shoot(url, file) {
  execFileSync(chrome, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1', '--hide-scrollbars',
    '--window-size=' + WIDTH + ',' + HEIGHT, '--virtual-time-budget=12000',
    '--screenshot=' + file.win, url,
  ], { stdio: 'ignore' });
  return decodePng(readFileSync(file.wsl));
}

/** 拿一次采样坐标：服务刚起来时页面可能还没跑完，重试几次再算失败。 */
function rectsOf(url) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const match = /<pre id="rects">([\s\S]*?)<\/pre>/.exec(dump(url));
    if (match !== null) {
      try { return JSON.parse(match[1]) } catch { /* 内容还没写完，再试 */ }
    }
  }
  return null;
}

console.log('像素检查：' + BASE + '（浏览器 ' + chrome + '）');
const warmQuery = process.env.PROBE_QUERY ? '&' + process.env.PROBE_QUERY : '';
rectsOf(BASE + '/tools/pixel-probe.html?theme=light&bg=none' + warmQuery);   // 预热：把页面与静态资源先拉一遍
const shots = {};
for (const theme of ['light', 'dark']) {
  for (const bg of ['none', 'aurora']) {
    const key = theme + '/' + bg;
    const extra = process.env.PROBE_QUERY ? '&' + process.env.PROBE_QUERY : '';
    const url = BASE + '/tools/pixel-probe.html?theme=' + theme + '&bg=' + bg + extra;
    const rects = rectsOf(url);
    if (rects === null) { check('量到 ' + key + ' 的采样坐标', false, '页面没跑完（重试 3 次都不行）'); continue; }
    const dir = process.env.CHROME ? tmpdir() : temp.wsl;
    const file = chrome.startsWith('/mnt/')
      ? { win: temp.win + '\\reader-pixels-' + theme + '-' + bg + '.png', wsl: join(temp.wsl, 'reader-pixels-' + theme + '-' + bg + '.png') }
      : { win: join(dir, 'reader-pixels-' + theme + '-' + bg + '.png'), wsl: join(dir, 'reader-pixels-' + theme + '-' + bg + '.png') };
    const image = shoot(url, file);
    const at = (name) => sample(image, rects[name].px, rects[name].py);
    shots[key] = {
      primary: at('primary'), refSide: at('refSide'), icon: at('icon'),
      rimTop: at('rimTop'), shadowBelow: at('shadowBelow'), edgeBottom: at('edgeBottom'),
      segOn: at('segOn'), segOff: at('segOff'), card: at('card'),
      panelSide: at('panelSide'), panelTop: at('panelTop'), refTop: at('refTop'),
    };
    // Windows 侧的临时文件在 WSL 里常常删不掉（drvfs 权限），删不掉就算了，不影响结果
    try { rmSync(file.wsl, { force: true }) } catch { /* 忽略 */ }
  }
}

for (const theme of ['light', 'dark']) {
  const none = shots[theme + '/none'];
  const aurora = shots[theme + '/aurora'];
  if (none === undefined || aurora === undefined) { console.log('== ' + theme + ' == 跳过（这一组没量到）'); continue; }
  console.log('== ' + (theme === 'dark' ? '深色主题' : '浅色主题') + ' ==');
  const delta = lum(none.primary) - lum(none.refSide);
  const rim = lum(none.rimTop) - lum(none.primary);
  const shadow = lum(none.refSide) - lum(none.shadowBelow);
  check('按钮不带底色：和它所在的面板几乎同色（背景色原样透过来）', Math.abs(delta) <= 5,
    show(none.primary) + ' vs 面板 ' + show(none.refSide) + '，亮度差 ' + delta);
  const edge = lum(none.primary) - lum(none.edgeBottom);
  check('凸感 · 玻璃有厚度（内下缘比按钮暗）', edge >= 3,
    '内下缘 ' + show(none.edgeBottom) + ' vs 按钮 ' + show(none.primary) + '，亮度差 ' + edge);
  check('凸感 · 深色主题下还有一道顶部高光', theme !== 'dark' || rim >= 2,
    '按钮内顶 ' + show(none.rimTop) + ' vs 按钮 ' + show(none.primary) + '，亮度差 ' + rim);
  check('凸感 · 下方有投影', shadow >= 1,
    '按钮外侧下方 ' + show(none.shadowBelow) + ' vs 面板 ' + show(none.refSide) + '，亮度差 ' + shadow);
  check('磨砂是透的：换背景后按钮像素跟着变（磨砂糊的就是它背后的东西）', diff(none.primary, aurora.primary) >= 8 && diff(none.refSide, aurora.refSide) >= 8,
    '按钮 ' + show(none.primary) + ' → ' + show(aurora.primary) + '（面板 ' + show(none.refSide) + ' → ' + show(aurora.refSide) + '）');
  check('切换看得出状态：选中 ≠ 未选中', diff(none.segOn, none.segOff) >= 8,
    '选中 ' + show(none.segOn) + ' vs 未选中 ' + show(none.segOff) + '，最大差 ' + diff(none.segOn, none.segOff));
  check('卡片同样不带底色', Math.abs(lum(none.card) - lum(none.panelSide)) <= 5,
    show(none.card) + ' vs 侧栏 ' + show(none.panelSide));
}

// 临时目录里的截图清掉（删不掉也不影响结果）
if (!chrome.startsWith('/mnt/')) {
  for (const theme of ['light', 'dark']) for (const bg of ['none', 'aurora']) {
    try { rmSync(join(tmpdir(), 'reader-pixels-' + theme + '-' + bg + '.png'), { force: true }) } catch { /* 忽略 */ }
  }
}

if (own !== null) own.child.kill();   // 自己起的临时服务，跑完就关

console.log('');
console.log(failures === 0 ? '像素检查全部通过' : '有 ' + failures + ' 项不通过');
process.exit(failures === 0 ? 0 : 1);
