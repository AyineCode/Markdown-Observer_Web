/*
  在**真浏览器**里量编辑器外壳的排版，必要时还能截图。

  为什么需要它：jsdom 没有排版引擎（量不出"滚动条贴不贴边""谁压住谁"），
  而编辑器那边的窗口比浏览器窄得多，很多问题只在那个尺寸下才出现。
  这个工具把组装好的 webview 页面放到 760x900 的窗口里跑一遍，
  页面里注入一段测量脚本，把关键元素的真实几何与计算样式写进 DOM，
  再用 headless Chrome 的 --dump-dom 取回来。

  用法：
    node tools/vscode/build.mjs          # 先组装（改过源码就要重跑）
    node tools/vscode/audit.mjs          # 量一遍（顺便模拟 VSCode 注入的引用块背景）
    node tools/vscode/audit.mjs --shot   # 再截一张图（Windows 的 %TEMP% 下，路径会打印出来）
*/
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const APP = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MEDIA = join(APP, 'build', 'vscode', 'pkg', 'media');
const WIDTH = 760;
const HEIGHT = 900;

/** 找一个能用的 Chrome/Edge（WSL 里通常用 Windows 那份）。 */
function findChrome() {
  if (process.env.CHROME) return process.env.CHROME;
  return [
    '/mnt/c/Program Files/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    '/mnt/c/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/chromium',
    '/usr/bin/google-chrome',
  ].find((path) => existsSync(path)) ?? null;
}

const chrome = findChrome();
if (chrome === null) {
  console.error('没找到 Chrome/Edge：设 CHROME=<路径> 再跑');
  process.exit(1);
}
if (!existsSync(join(MEDIA, 'index.html'))) {
  console.error('还没有组装好的插件包：先跑 node tools/vscode/build.mjs');
  process.exit(1);
}

const paragraph = '这是一段用来把页面撑长的正文，目的是让滚动条真的出现。'.repeat(30);
const document_ = [
  '# 一级标题', '', paragraph, '',
  '> 引用块：这一行用来检查有没有被注入背景色。', '',
  paragraph, '', '## 二级标题', '', paragraph, '',
  '### 三级标题', '', paragraph,
].join('\n');

const probe = `<script>
(function () {
  var DOC = ${JSON.stringify(document_)};
  window.acquireVsCodeApi = function () {
    return { getState: function () {}, setState: function () {}, postMessage: function (m) {
      if (m.type === 'call' && m.kind === 'read') {
        window.postMessage({ type: 'result', id: m.id, ok: true, data: { text: DOC, name: 'audit.md', size: DOC.length } }, '*');
      } else if (m.type === 'call') {
        window.postMessage({ type: 'result', id: m.id, ok: true, data: {} }, '*');
      }
    } };
  };
  window.__audit = function () {
    var out = [];
    var de = document.documentElement;
    function style(sel, prop) { var el = document.querySelector(sel); return el ? getComputedStyle(el)[prop] : '(missing)' }
    var stage = document.querySelector('.stage');
    var sr = stage.getBoundingClientRect();
    out.push('data-shell=' + document.body.dataset.shell + '  viewport=' + de.clientWidth + 'x' + de.clientHeight);
    var sbr = document.querySelector('#sidebar').getBoundingClientRect();
    out.push('侧栏宽度=' + style('#sidebar', 'width') + '（应为 208px）  栅格=' + style('.app', 'gridTemplateColumns'));
    out.push('侧栏左边=' + Math.round(sbr.left) + '（应为 0，说明宿主注入的 body 盒子被压住了）  body margin=' + style('body', 'margin') + ' padding=' + style('body', 'padding'));
    out.push('滚动：html=' + getComputedStyle(de).overflowY + ' body=' + getComputedStyle(document.body).overflowY + ' stage=' + getComputedStyle(stage).overflowY);
    out.push('内容高度：html=' + de.scrollHeight + ' body=' + document.body.scrollHeight + ' stage=' + stage.scrollHeight + '（只有 stage 该有滚动）');
    out.push('stage 右边=' + Math.round(sr.right) + ' 视口右边=' + de.clientWidth + ' 间距=' + (de.clientWidth - Math.round(sr.right)) + '（应为 0）  外侧滚动条=' + (window.innerWidth - de.clientWidth));
    out.push('引用块背景=' + style('.markdown blockquote', 'backgroundColor') + '（应为透明，且能压住 VSCode 注入）');
    out.push('引用块左边框=' + style('.markdown blockquote', 'borderLeftWidth') + '（应为 2px，说明我们的样式在生效）');
    var box = document.createElement('pre');
    box.id = 'audit';
    box.textContent = out.join('\\n');
    document.body.appendChild(box);
  };
})();
</script>`;

// 故意在最后注入一条"VSCode 风格的引用块背景"，而且带 !important——最严苛的模拟
/*
  对照组：模拟宿主后注入的默认样式。
    · body 上的 margin/padding —— 会把内容盒子整体内缩（"两边都有缝"的典型成因）
    · 引用块背景 —— 用 !important，属于最严苛的情况
  这两条都放在最后注入（最坏顺序），我们的外壳样式必须能压住它们。
*/
const mimic = '<style>'
  + 'body { margin: 8px; padding: 0 20px; }'
  + 'blockquote { background-color: rgb(255, 0, 0) !important; }'
  + '</style>';

const html = readFileSync(join(MEDIA, 'index.html'), 'utf8')
  .replace(/<body(\s|>)/, '<body data-vscode-file="' + encodeURIComponent(JSON.stringify('/notes/audit.md'))
    + '" data-vscode-settings="' + encodeURIComponent(JSON.stringify({ scale: 1, width: 748, theme: 'light', sidebar: true })) + '"$1')
  .replace('</head>', mimic + '\n</head>')
  .replace('<script src="js/preview-bridge.js"></script>', probe + '\n<script src="js/preview-bridge.js"></script>')
  .replace('</body>', '<script>setTimeout(function () { window.__audit() }, 1800)</script>\n</body>');

const auditPath = join(MEDIA, 'audit.html');
writeFileSync(auditPath, html, 'utf8');
const url = 'file://wsl.localhost/Ubuntu' + auditPath;

const run = (args) => spawnSync(chrome, ['--headless=new', '--disable-gpu', '--no-first-run', '--force-device-scale-factor=1',
  '--window-size=' + WIDTH + ',' + HEIGHT, '--virtual-time-budget=9000', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

const dom = run(['--dump-dom', url]).stdout ?? '';
const match = /<pre id="audit">([\s\S]*?)<\/pre>/.exec(dom);
if (match === null) {
  console.error('没量到：页面可能没渲染出来（检查 build/vscode/pkg/media 是否完整）');
  process.exit(1);
}
console.log(match[1].split('\n').map((line) => '  ' + line).join('\n'));

if (process.argv.includes('--shot')) {
  const temp = spawnSync('/mnt/c/Windows/System32/cmd.exe', ['/c', 'echo %TEMP%'], { encoding: 'utf8' }).stdout.trim().replace(/\r/g, '');
  const shot = temp + '\\markdown-observer-audit.png';
  run(['--screenshot=' + shot, url]);
  const wslPath = shot.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (m, d) => '/mnt/' + d.toLowerCase());
  console.log('  截图：' + wslPath);
}
