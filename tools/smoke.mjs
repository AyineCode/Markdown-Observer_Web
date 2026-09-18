/**
 * smoke.mjs —— 用 jsdom 把阅读器完整跑一遍（不需要浏览器）。
 *
 * 它做的事：加载 index.html（含全部脚本与样式）→ 点"看一篇示例" → 逐项断言渲染结果
 * → 再验证主题切换、搜索、设置持久化、侧栏开关。
 *
 * 跑法（cwd 需要是 dsh 源码根目录，借它的 jsdom）：
 *   node ../md-reader/tools/smoke.mjs            # 静态模式
 *   node ../md-reader/tools/smoke.mjs --server   # 服务模式（会自己起 serve.mjs）
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const CHECKOUT = process.env.DSH_CHECKOUT ?? fileURLToPath(new URL('../../deepseek-harness-ayine/', import.meta.url));
const require = createRequire(CHECKOUT + 'packages/client/ui-goal/package.json');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = fileURLToPath(new URL('../', import.meta.url));
const useServer = process.argv.includes('--server');
const PORT = 4321;

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + ' -> ' + JSON.stringify(actual) + (ok ? '' : '（期望 ' + JSON.stringify(expected) + '）'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  // jsdom 未实现的浏览器 API（滚动等）不算失败，单独记下来
  if (/Not implemented/.test(error.message)) problems.push('未实现: ' + error.message.split('\n')[0]);
  else problems.push('jsdomError: ' + error.message);
});
virtualConsole.on('error', (...args) => problems.push('console.error: ' + args.map(String).join(' ')));

let server = null;
if (useServer) {
  // DOC_ROOT 可以指定"要浏览的文档目录"（默认就是阅读器自己这个目录）
  const docRoot = process.env.DOC_ROOT ?? APP;
  server = spawn(process.execPath, [join(APP, 'serve.mjs'), docRoot], { stdio: 'ignore' });
  await sleep(700);
}

const options = {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  // jsdom 没有实现 fetch：服务模式要用到它，所以注入一个用 Node fetch 实现的垫片。
  beforeParse(window) {
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input.url;
      const url = new window.URL(raw, window.location.href).toString();
      const res = await fetch(url, init);
      return {
        ok: res.ok,
        status: res.status,
        json: () => res.json(),
        text: () => res.text(),
      };
    };
  },
};
const dom = useServer
  ? await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', options)
  : await JSDOM.fromFile(join(APP, 'index.html'), options);
const { window } = dom;
const document = window.document;

await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else window.addEventListener('load', resolve);
});
await sleep(150);

console.log(useServer ? '== 服务模式 ==' : '== 静态模式（file://） ==');
console.log('1) 依赖是否都加载了');
check('marked', typeof window.marked, 'object');
check('hljs', typeof window.hljs, 'object');
check('DOMPurify', typeof window.DOMPurify.sanitize, 'function');
check('katex', typeof window.katex, 'object');
check('示例文档已内嵌', typeof window.__SAMPLE_MD__, 'string');
check('初始是空状态', document.body.dataset.reading, 'false');

console.log('2) 渲染示例文档');
document.getElementById('btn-sample').click();
await sleep(250);
const content = document.getElementById('content');
check('进入阅读状态', document.body.dataset.reading, 'true');
check('标题栏显示文档名', document.getElementById('doc-title').textContent, '示例文档.md');
check('有一级标题', content.querySelectorAll('h1').length >= 1, true);
check('代码块外壳数量', content.querySelectorAll('.md-code-block').length, 5);
check('语法高亮生效', content.querySelectorAll('.md-code-block .hljs').length, 4);
check('复制按钮数量', content.querySelectorAll('.copyButton').length, 5);
check('表格滚动容器', content.querySelectorAll('.tableScroll').length, 1);
check('任务列表条目', content.querySelectorAll('li.task-list-item').length, 3);
check('任务列表容器', content.querySelectorAll('ul.contains-task-list').length, 1);
check('复选框被禁用', content.querySelectorAll('input[type=checkbox][disabled]').length, 3);
check('行内公式渲染出来了', content.querySelectorAll('.katex').length >= 4, true);
check('独立公式块', content.querySelectorAll('.katex-display').length, 1);
check('脚注区块', content.querySelectorAll('section.footnotes').length, 1);
check('脚注条目', content.querySelectorAll('.footnotes li').length, 1);
check('脚注反向标记', content.querySelectorAll('.footnotes li').length > 0 && content.textContent.includes('↩'), true);
check('图片被标成可点', content.querySelectorAll('img.image.clickable').length, 1);
check('外链新窗口打开', content.querySelector('a[target=_blank]') !== null, true);
check('危险标签被清掉', content.innerHTML.includes('<script'), false);

console.log('3) 目录与进度');
check('目录条目数 > 5', document.querySelectorAll('#toc .toc-row').length > 5, true);
check('目录第一项是文档标题', document.querySelector('#toc .toc-row .name').textContent, 'Markdown 阅读器 · 示例文档');
check('标题都拿到了 id', content.querySelectorAll('h1[id], h2[id]').length > 0, true);

console.log('4) 主题切换');
document.querySelector('[data-theme="dark"]').click();
await sleep(60);
check('深色：body 属性', document.body.hasAttribute('data-ds-dark-theme'), true);
check('深色：color-scheme', document.documentElement.style.colorScheme, 'dark');
document.querySelector('[data-theme="light"]').click();
await sleep(60);
check('浅色：body 属性移除', document.body.hasAttribute('data-ds-dark-theme'), false);

console.log('5) 文内搜索');
const searchInput = document.getElementById('search-input');
document.getElementById('btn-search').click();
check('搜索条打开', document.getElementById('searchbar').hidden, false);
searchInput.value = 'dsh';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(250);
const hitCount = content.querySelectorAll('mark.hit').length;
check('命中已高亮', hitCount > 0, true);
check('计数显示', document.getElementById('search-count').textContent, '1/' + hitCount);
check('当前命中标记', content.querySelectorAll('mark.hit.current').length, 1);
document.getElementById('search-next').click();
await sleep(60);
check('跳到下一处后仍是 1 个 current', content.querySelectorAll('mark.hit.current').length, 1);
document.getElementById('search-close').click();
await sleep(60);
check('关闭后高亮清空', content.querySelectorAll('mark.hit').length, 0);
check('关闭后文本没被切碎（仍是 1 个标题）', content.querySelectorAll('h1').length, 1);

console.log('6) 设置与版式');
const scale = document.getElementById('r-scale');
scale.value = '1.2';
scale.dispatchEvent(new window.Event('input', { bubbles: true }));
check('字号变量已写入', document.documentElement.style.getPropertyValue('--read-scale'), '1.2');
check('数值标签同步', document.getElementById('v-scale').textContent, '120%');
document.getElementById('sw-serif').click();
check('衬线开关生效', document.documentElement.style.getPropertyValue('--reader-font').includes('serif'), true);
document.getElementById('btn-sidebar').click();
check('侧栏收起', document.body.dataset.sidebar, 'closed');
document.getElementById('btn-sidebar').click();
check('侧栏展开', document.body.dataset.sidebar, 'open');
// 注意：jsdom（和部分浏览器）在 file:// 下会禁用 localStorage；应用代码本身做了兜底，
// 所以这里"取不到"不算失败，只在服务模式下断言真的写进去了。
let saved = null;
let storageAvailable = true;
try {
  saved = window.localStorage.getItem('md-reader:settings:v1');
} catch {
  storageAvailable = false;
}
if (!storageAvailable) console.log('  --   本地存储在 file:// 下不可用（应用已兜底，不记为失败）');
else check('设置已持久化', saved !== null && saved.includes('"scale":1.2'), true);

if (useServer) {
  console.log('7) 服务模式');
  check('文件列表已渲染', document.querySelectorAll('#file-list .row').length > 0, true);
  check('根目录名已显示', document.getElementById('root-name').textContent.startsWith('/ '), true);
  const first = document.querySelector('#file-list .row');
  first.click();
  await sleep(300);
  check('点文件后进入阅读', document.body.dataset.reading, 'true');
  check('hash 跟着变', window.location.hash.length > 1, true);
}

console.log('');
if (problems.length > 0) {
  console.log('运行期问题（' + problems.length + '）：');
  for (const item of problems.slice(0, 8)) console.log('  - ' + item);
}
console.log(failures === 0 ? '全部通过' : '有 ' + failures + ' 项失败');
if (server !== null) server.kill();
process.exit(failures === 0 ? 0 : 1);
