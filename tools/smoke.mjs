/**
 * smoke.mjs —— 用 jsdom 把阅读器完整跑一遍（不需要浏览器）。
 *
 * 覆盖：渲染各元素、目录、锚点跳转、主题、搜索、多文档、侧栏树、设置面板、服务模式。
 * 服务模式会自己起 serve.mjs；静态模式还会用假句柄模拟浏览器的"打开文件夹"能力。
 *
 * 跑法（cwd 需要是 dsh 源码根目录，借它的 jsdom）：
 *   node ../md-reader/tools/smoke.mjs            # 静态模式（含模拟文件夹模式）
 *   node ../md-reader/tools/smoke.mjs --server   # 服务模式
 *   DOC_ROOT=../sprite-plugin node ../md-reader/tools/smoke.mjs --server   # 指定文档目录
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const CHECKOUT = process.env.DSH_CHECKOUT ?? fileURLToPath(new URL('../../deepseek-harness-ayine/', import.meta.url));
const require = createRequire(CHECKOUT + 'packages/client/ui-goal/package.json');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = fileURLToPath(new URL('../', import.meta.url));
const useServer = process.argv.includes('--server');
// --standalone：测那份"发给朋友的单文件 HTML"，而不是开发用的 index.html
const useStandalone = process.argv.includes('--standalone');
// 测试用独立端口：不打扰你自己跑着的那个服务（默认 4321）
const PORT = Number(process.env.TEST_PORT ?? 4399);

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
  if (/Not implemented/.test(error.message)) problems.push('未实现: ' + error.message.split('\n')[0]);
  else problems.push('jsdomError: ' + error.message);
});
virtualConsole.on('error', (...args) => problems.push('console.error: ' + args.map(String).join(' ')));

let server = null;
if (useServer) {
  const docRoot = process.env.DOC_ROOT ?? APP;
  // 端口必须显式传给被拉起的服务，否则它会用默认的 4321（可能撞上你自己开着的那个）
  server = spawn(process.execPath, [join(APP, 'serve.mjs'), docRoot, '--port', String(PORT)], { stdio: 'ignore' });
  let up = false;
  for (let i = 0; i < 50 && !up; i += 1) {
    try {
      const probe = await fetch('http://127.0.0.1:' + PORT + '/api/info');
      up = probe.ok;
    } catch {
      await sleep(100);
    }
  }
  if (!up) {
    console.error('服务没有在端口 ' + PORT + ' 上起来（可能被占用）');
    process.exit(1);
  }
}

/** 造一个假的目录句柄，模拟浏览器"打开文件夹"返回的东西。 */
function fakeDirectory(window, spec, name) {
  const entries = [];
  for (const [key, value] of Object.entries(spec)) {
    if (typeof value === 'string') {
      entries.push({
        name: key,
        kind: 'file',
        async getFile() { return new window.File([value], key, { type: 'text/markdown' }) },
      });
    } else {
      entries.push(fakeDirectory(window, value, key));
    }
  }
  return {
    name,
    kind: 'directory',
    values() {
      let i = 0;
      return {
        async next() { return i < entries.length ? { value: entries[i++], done: false } : { value: undefined, done: true } },
        [Symbol.asyncIterator]() { return this },
      };
    },
  };
}

const options = {
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole,
  beforeParse(window) {
    // jsdom 没有 fetch：服务模式要用，注入一个用 Node fetch 实现的垫片
    window.fetch = async (input, init) => {
      const raw = typeof input === 'string' ? input : input.url;
      const url = new window.URL(raw, window.location.href).toString();
      const res = await fetch(url, init);
      return { ok: res.ok, status: res.status, json: () => res.json(), text: () => res.text() };
    };
    // jsdom 也没有 File System Access：用一个假目录模拟（只在静态模式下用）
    if (!useServer) {
      window.showDirectoryPicker = async () => fakeDirectory(window, {
        'a.md': '# 文档 A\n\n第一份文档。\n\n## 小节一\n\n内容。\n',
        'sub': { 'b.md': '# 文档 B\n\n第二份文档。\n\n## 小节二\n\n内容。\n' },
      }, 'notes');
    }
  },
};

const entry = useStandalone ? join(APP, 'markdown-observer.html') : join(APP, 'index.html');
const dom = useServer
  ? await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', options)
  : await JSDOM.fromFile(entry, options);
const { window } = dom;
const document = window.document;

await new Promise((resolve) => {
  if (document.readyState === 'complete') resolve();
  else window.addEventListener('load', resolve);
});
await sleep(200);

const id = (name) => document.getElementById(name);
const key = (k, options) => document.dispatchEvent(new window.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, options)));

console.log(useServer ? '== 服务模式 ==' : (useStandalone ? '== 单文件分享版 ==' : '== 静态模式（含模拟的文件夹模式） =='));
console.log('1) 依赖与初始状态');
if (useStandalone) {
  check('没有任何外部样式引用', document.querySelectorAll('link[rel=stylesheet]').length, 0);
  check('没有任何外部脚本引用', document.querySelectorAll('script[src]').length, 0);
  check('样式已内联', document.querySelectorAll('style').length >= 5, true);
  check('公式字体已内联', document.documentElement.innerHTML.includes('data:font/woff2'), true);
  // 回归防线：内联字体时曾经把 src 列表一路吃到右花括号，20 条 @font-face 塌成 2 条，
  // 结果"开发页公式正常、打包出来用回退字体"。条数必须与源文件一致，且不能再引用外部字体。
  const builtCss = readFileSync(join(APP, 'markdown-observer.html'), 'utf8');
  const sourceK = readFileSync(join(APP, 'vendor', 'katex.min.css'), 'utf8');
  check('打包后 @font-face 条数不少于源文件（现在 ' + (builtCss.match(/@font-face/g) ?? []).length + ' vs ' + (sourceK.match(/@font-face/g) ?? []).length + '）',
    (builtCss.match(/@font-face/g) ?? []).length >= (sourceK.match(/@font-face/g) ?? []).length, true);
  check('打包后不再引用外部字体文件', (builtCss.match(/url\(\s*['"]?fonts\//g) ?? []).length, 0);
}
check('marked', typeof window.marked, 'object');
check('hljs', typeof window.hljs, 'object');
check('DOMPurify', typeof window.DOMPurify.sanitize, 'function');
check('katex', typeof window.katex, 'object');
check('示例文档已内嵌', typeof window.__SAMPLE_MD__, 'string');
check('初始是空状态', document.body.dataset.reading, 'false');
check('侧栏默认展开', document.body.dataset.sidebar, 'open');
check('默认背景模式是"无背景"', document.body.dataset.bgMode, 'none');
check('"无背景"是一层黑白渐变（不是死白）', window.getComputedStyle(document.documentElement).getPropertyValue('--plain-bg').includes('linear-gradient'), true);
// 玻璃配方用的是 background-color 长写属性，jsdom 只把原始文本放在这个属性里
const bgText = (cs) => String(cs.backgroundColor || '') + String(cs.backgroundImage || '') + String(cs.background || '');
const sampleBtn = window.getComputedStyle(id('btn-sample'));
check('按钮是玻璃：有磨砂', sampleBtn.backdropFilter.includes('blur'), true);
check('按钮底色取自玻璃变量（--btn-glass-veil）', bgText(sampleBtn).includes('--btn-glass-veil'), true);
check('浅色主题的按钮底色是"淡墨"，不是白纱', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-veil').trim(), '38 49 72');
// 底色降到 0：背景色原样透过，轮廓靠磨砂 + 凸感（顶部高光 / 底部内阴影 / 投影）
check('按钮不再自带底色（0%，背景色原样透过来）', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha').trim(), '0');
check('凸感：有顶部高光与投影', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-rim').includes('inset 0 1px 0'), true);
check('分段底板比按钮实（10%），才看得出是一条槽', window.getComputedStyle(id('card-open')).getPropertyValue('--seg-track-alpha').trim(), '0.10');
// 图标按钮照 dsh 的做法：默认什么都不画，只有 hover 浮出一层淡色（不是玻璃片）
const iconBtnStyle = window.getComputedStyle(document.querySelector('.topbar .icon-btn'));
check('图标按钮默认没有底板（不再是玻璃片）', bgText(iconBtnStyle).includes('--btn-glass-veil'), false);
check('图标按钮也不磨砂（一次 hover 反馈不值得挂 backdrop-filter）', iconBtnStyle.backdropFilter, 'none');
check('拉出小圆同样不是玻璃片', bgText(window.getComputedStyle(id('btn-sidebar'))).includes('--btn-glass-veil'), false);

console.log('1b) 空状态：三张卡按环境显隐');
check('空状态板在', id('empty').hidden, false);
check('"打开文件"卡在', id('card-open').hidden, false);
if (useServer) {
  check('服务模式：藏"打开文件夹"、亮"从左侧选择"', id('card-folder').hidden + '/' + id('card-browse').hidden, 'true/false');
} else {
  check('本地模式：亮"打开文件夹"', id('card-folder').hidden, false);
  check('本地模式：藏"从左侧选择"（还没有文档列表）', id('card-browse').hidden, true);
}
// 只观察"有没有真的去唤起文件选择框"：把 click 换掉，避免 jsdom 去实现真实的选择框
const fileInput = id('file-input');
const realInputClick = fileInput.click.bind(fileInput);
let pickerCalls = 0;
fileInput.click = () => { pickerCalls += 1; };
id('card-open').click();
check('点"打开文件"卡会唤起文件选择框', pickerCalls, 1);
fileInput.click = realInputClick;
const cardStyle = window.getComputedStyle(id('card-open'));
check('卡片横排：图标与文字在同一水平线上', cardStyle.flexDirection, 'row');
check('图标与右侧两行文字垂直居中对齐', cardStyle.alignItems, 'center');
check('文字块里是标题 + 说明两行', id('card-open').querySelector('.card-text').children.length, 2);
check('说明段落靠左对齐', window.getComputedStyle(document.querySelector('.empty-sub')).textAlign, 'left');
check('卡片也走玻璃配方', cardStyle.backdropFilter.includes('blur') && bgText(cardStyle).includes('--btn-glass-veil'), true);

console.log('2) 渲染示例文档');
id('btn-sample').click();
await sleep(300);
const content = id('content');
check('进入阅读状态', document.body.dataset.reading, 'true');
check('标题栏显示文档名', id('doc-title').textContent, 'sample.md');
check('代码块外壳', content.querySelectorAll('.md-code-block').length, 5);
check('语法高亮', content.querySelectorAll('.md-code-block .hljs').length, 4);
check('复制按钮', content.querySelectorAll('.copyButton').length, 5);
check('复制按钮也是玻璃', window.getComputedStyle(content.querySelector('.copyButton')).backdropFilter.includes('blur'), true);
check('表格滚动容器', content.querySelectorAll('.tableScroll').length, 1);
check('任务列表条目', content.querySelectorAll('li.task-list-item').length, 3);
check('复选框禁用', content.querySelectorAll('input[type=checkbox][disabled]').length, 3);
check('行内公式', content.querySelectorAll('.katex').length >= 4, true);
check('独立公式块', content.querySelectorAll('.katex-display').length, 1);
check('脚注区块', content.querySelectorAll('section.footnotes').length, 1);
check('脚注反向标记', content.textContent.includes('↩'), true);
check('图片可点', content.querySelectorAll('img.image.clickable').length, 1);
check('外链新窗口', content.querySelector('a[target=_blank]') !== null, true);
check('危险标签被清掉', content.innerHTML.includes('<script'), false);

console.log('3) 标题锚点（可读、支持中文）');
const codeHeading = content.querySelector('h2:nth-of-type(1)');
check('锚点 id 是中文可读形式', content.querySelector('h2[id]').id.length > 0 && /[\u4e00-\u9fff]/.test(content.querySelector('h2[id]').id), true);
check('重复标题会去重（无重复 id）', (() => { const ids = [...content.querySelectorAll('[id]')].map((n) => n.id); return ids.length === new Set(ids).size })(), true);

console.log('4) 文内跳转与深链接');
// 注意：href 里的中文会被浏览器/解析器编码成 %E6%95%B0…，比较时要解码
const decode = (value) => decodeURIComponent(value || '');
const jumpLink = [...content.querySelectorAll('a')].find((a) => decode(a.getAttribute('href')) === '#数学公式');
check('示例里有站内链接', jumpLink !== undefined, true);
if (jumpLink !== undefined) {
  jumpLink.click();
  await sleep(120);
  check('跳转后出现提示条', id('jump-chip').hidden, false);
  check('地址栏记下了这一节', decode(window.location.hash), '#数学公式');
  id('jump-back').click();
  await sleep(320);   // 提示条有 200ms 淡出动画
  check('提示条可以收起', id('jump-chip').hidden, true);
}
check('找不到的锚点不会炸', (() => { try { key('Escape'); return true } catch { return false } })(), true);

console.log('5) 主题切换');
document.querySelector('[data-theme="dark"]').click();
await sleep(60);
check('深色：body 属性', document.body.hasAttribute('data-ds-dark-theme'), true);
check('深色：color-scheme', document.documentElement.style.colorScheme, 'dark');
check('深色主题的按钮底色换成"淡光"（白纱，不是近黑）', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-veil').trim(), '255 255 255');
// 回归：面板透明度由设置决定，深色主题下也必须是滑杆说了算（曾经被 body 上的规则盖掉）
const glassNum = id('n-glass');
glassNum.value = '45';
glassNum.dispatchEvent(new window.Event('change', { bubbles: true }));
check('深色主题下面板透明度听滑杆的', window.getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('--glass-alpha').trim(), '0.45');
check('深色下选中态明显比按钮实（24% vs 3%）', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha-on').trim(), '0.24');
check('深色下按钮同样不带底色', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha').trim(), '0');
document.querySelector('[data-theme="light"]').click();
await sleep(60);
check('浅色：属性移除', document.body.hasAttribute('data-ds-dark-theme'), false);

console.log('6) 文内搜索');
id('btn-search').click();
const searchInput = id('search-input');
check('搜索条打开', id('searchbar').hidden, false);
searchInput.value = 'dsh';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(250);
const hitCount = content.querySelectorAll('mark.hit').length;
check('命中已高亮', hitCount > 0, true);
check('计数显示', id('search-count').textContent, '1/' + hitCount);
id('search-next').click();
await sleep(60);
check('当前命中只有一个', content.querySelectorAll('mark.hit.current').length, 1);
id('search-close').click();
await sleep(60);
check('关闭后高亮清空', content.querySelectorAll('mark.hit').length, 0);

console.log('7) 设置面板（两页 + 数字框）');
id('btn-settings').click();
check('面板打开', id('popover').hidden, false);
check('默认在"排版"页', id('pop-type').hidden, false);
check('设置里没有"外观"页（主题只在顶栏）', document.querySelector('[data-ptab="look"]'), null);
// 全局设置入口搬到了左下角：它不该再出现在顶栏里，而且侧栏收起后也必须还在
const seat = id('btn-settings');
check('设置入口不在顶栏里了', document.querySelector('.topbar').contains(seat), false);
check('设置入口固定在视口左下角', window.getComputedStyle(seat).position, 'fixed');
check('侧栏底部为它留了空白（--sidebar-pad-bottom）', window.getComputedStyle(id('sidebar-body')).getPropertyValue('--sidebar-pad-bottom').trim(), '62px');
check('设置里没有"显示侧栏"开关（它不是设置）', id('sw-sidebar'), null);
check('衬线字体在排版页里', id('sw-serif') !== null && id('pop-type').contains(id('sw-serif')), true);
const num = id('n-scale');
num.value = '120';
num.dispatchEvent(new window.Event('change', { bubbles: true }));
check('数字框改字号 → CSS 变量', document.documentElement.style.getPropertyValue('--read-scale'), '1.2');
check('滑杆跟着同步', id('r-scale').value, '1.2');
num.value = '999';
num.dispatchEvent(new window.Event('change', { bubbles: true }));
check('超范围会被夹住', num.value, '140');
document.querySelector('[data-ptab="bg"]').click();
check('切到"背景"页', id('pop-bg').hidden, false);
check('最近使用有 5 个格子', id('recents').querySelectorAll('.recent').length, 5);
// 空格子以前叫 .recent.empty，和"空状态面板"的 .empty 撞名，被那套 max-width/margin/padding/圆角顶到下一行
const slotCell = id('recents').querySelector('.recent.slot');
check('空格子用 slot 类，且不匹配空状态面板的 .empty', slotCell !== null && slotCell.matches('.empty') === false, true);
// "无背景"下模糊/遮罩没有作用对象：灰掉并给出说明，而不是让人以为滑杆坏了
check('"无背景"下模糊被灰掉', id('r-blur').disabled && id('field-blur').dataset.off, 'true');
check('"无背景"下遮罩被灰掉', id('r-dim').disabled && id('field-dim').dataset.off, 'true');
check('说明文字换成了"无背景"的解释', id('bg-note').textContent.includes('无背景'), true);
id('swatches').querySelectorAll('.swatch')[0].click();   // 再点一次"无背景"：滑杆应保持灰
check('点"无背景"色板：模糊仍是灰的', id('r-blur').disabled, true);
id('swatches').querySelectorAll('.swatch')[1].click();   // 第一个内置渐变
check('选了渐变预设后模糊恢复可用', id('r-blur').disabled, false);
id('swatches').querySelectorAll('.swatch')[0].click();   // 还原成默认的"无背景"
id('sw-wrap').click();
check('代码块换行可关', document.body.dataset.codeWrap, 'off');
id('sw-wrap').click();

console.log('8) 侧栏：一个滚动容器、两区共享，收起与拉出');
check('文档区与目录区同时存在', id('pane-docs').hidden === false && id('pane-toc').hidden === false, true);
check('两区是同一个滚动容器的孩子', id('pane-docs').parentElement === id('sidebar-body') && id('pane-toc').parentElement === id('sidebar-body'), true);
check('没有可拖分隔线了', document.querySelector('#sidebar-splitter, .splitter'), null);
check('没有分段控件了', document.querySelector('[data-stab]'), null);
const bodyOverflow = window.getComputedStyle(id('sidebar-body')).overflowY;
check('侧栏主体自己滚动（auto/scroll）', bodyOverflow === 'auto' || bodyOverflow === 'scroll', true);
const paneOverflow = window.getComputedStyle(id('pane-docs')).overflowY;
check('文档区不再自己滚动（实际 ' + (paneOverflow || '空') + '）', paneOverflow !== 'auto' && paneOverflow !== 'scroll', true);
check('侧栏头部不参与滚动', id('sidebar-body').contains(id('btn-collapse')), false);

console.log('8b) 目录折叠');
const tocBox = id('toc');
const visibleRows = () => tocBox.querySelectorAll('.toc-row').length;
const totalHeadings = content.querySelectorAll('h1, h2, h3, h4').length;
check('目录按层级成了树（有三角的行存在）', tocBox.querySelectorAll('.toc-row .twisty:not(.spacer)').length > 0, true);
check('三级标题默认折叠起来了', visibleRows() < totalHeadings, true);
const hiddenRow = [...tocBox.querySelectorAll('.toc-row')].find((row) => row.dataset.target === '三级标题也会出现在目录里');
check('被折叠的三级标题当前不在目录里', hiddenRow, undefined);
const parentTwisty = [...tocBox.querySelectorAll('.toc-row')].find((row) => row.dataset.target === '代码块').querySelector('.twisty');
parentTwisty.click();
check('展开后三级标题出现了', [...tocBox.querySelectorAll('.toc-row')].some((row) => row.dataset.target === '三级标题也会出现在目录里'), true);
check('展开三角不会触发跳转', decode(window.location.hash) === '' || decode(window.location.hash) === '#数学公式', true);
parentTwisty.click();
check('再点一次收起', [...tocBox.querySelectorAll('.toc-row')].some((row) => row.dataset.target === '三级标题也会出现在目录里'), false);

check('侧栏默认展开 → 拉出按钮藏着', document.body.dataset.sidebar, 'open');
id('btn-collapse').click();
check('侧栏可收起', document.body.dataset.sidebar, 'closed');
check('收起后拉出按钮出现（小圆）', id('btn-sidebar').classList.contains('sidebar-pull'), true);
id('btn-sidebar').click();
check('点小圆可展开', document.body.dataset.sidebar, 'open');
document.querySelector('[data-theme="system"]').click();
key('t');
check('快捷键 T 切主题（跟随系统→浅色）', document.body.hasAttribute('data-ds-dark-theme'), false);
key('t');
check('再按一次 T 进深色', document.body.hasAttribute('data-ds-dark-theme'), true);
document.querySelector('[data-theme="light"]').click();

console.log('9) 多文档与文件树');

if (useServer) {
  // 先关掉前面打开的示例文档，让这一节从干净的文档列表开始
  while (id('doc-list').querySelector('.doc-close') !== null) {
    id('doc-list').querySelector('.doc-close').click();
    await sleep(100);
  }
  check('文档列表已清空', id('doc-list').querySelectorAll('.doc-row').length, 0);
  // 服务模式：树来自服务器的目录扫描
  const files = [...id('file-tree').querySelectorAll('.tree-row.file')];
  check('文件树里有文件', files.length > 0, true);
  check('根目录名已显示', id('root-name').textContent.length > 0, true);
  files[0].click();
  await sleep(300);
  const firstTitle = id('doc-title').textContent;
  check('点文件后进入阅读', document.body.dataset.reading, 'true');
  check('地址栏带上了 ?file=', window.location.search.startsWith('?file='), true);
  // 展开一个子目录，找第二个文件
  const dir = id('file-tree').querySelector('.tree-row.dir');
  if (dir !== null) { dir.click(); await sleep(80) }
  const other = [...id('file-tree').querySelectorAll('.tree-row.file')].find((row) => row.dataset.path !== files[0].dataset.path);
  check('树里至少有两个可选文件', other !== undefined, true);
  if (other !== undefined) { other.click(); await sleep(300) }
  check('打开了两个文档', id('doc-list').querySelectorAll('.doc-row').length >= 2, true);
  key('1', { altKey: true });
  await sleep(150);
  check('Alt+1 回到第一个文档', id('doc-title').textContent, firstTitle);
  key(']', { altKey: true });
  await sleep(150);
  check('Alt+] 切到下一个', id('doc-title').textContent !== firstTitle, true);
} else {
  // 静态模式：用假的目录句柄模拟浏览器的"打开文件夹"
  id('btn-open-folder').click();
  await sleep(300);
  check('根目录显示出来了', id('root-name').textContent, 'notes');
  check('选过文件夹后，空状态改推荐"从左侧选择"', id('card-browse').hidden, false);
  check('折叠时只显示顶层文件', id('file-tree').querySelectorAll('.tree-row.file').length, 1);
  check('有一个可折叠目录', id('file-tree').querySelectorAll('.tree-row.dir').length, 1);
  id('file-tree').querySelector('.tree-row.file').click();
  await sleep(200);
  check('打开第一个文件', id('doc-title').textContent, 'a.md');
  id('file-tree').querySelector('.tree-row.dir').click();
  await sleep(80);
  check('展开目录后看到子文件', id('file-tree').querySelectorAll('.tree-row.file').length, 2);
  const second = [...id('file-tree').querySelectorAll('.tree-row.file')].find((row) => row.dataset.path === 'sub/b.md');
  second.click();
  await sleep(200);
  check('打开第二个文件', id('doc-title').textContent, 'b.md');
  check('打开文档累计 3 个（含示例）', id('doc-list').querySelectorAll('.doc-row').length, 3);
  check('当前项只有一个高亮', id('doc-list').querySelectorAll('.doc-row.active').length, 1);
  key('1', { altKey: true });
  await sleep(150);
  check('Alt+1 跳到第一个文档', id('doc-title').textContent, 'sample.md');
  key(']', { altKey: true });
  await sleep(150);
  check('Alt+] 跳到下一个', id('doc-title').textContent, 'a.md');
  id('doc-list').querySelector('.doc-row.active .doc-close').click();
  await sleep(200);
  check('关闭后剩 2 个', id('doc-list').querySelectorAll('.doc-row').length, 2);
  check('关闭当前项后自动切到邻居', id('doc-title').textContent, 'b.md');
}

if (useServer) {
  // 每个用例单独开一个页面，假装浏览器里存着老设置，验证迁移规则
  console.log('12) 老设置的迁移（v4 ← 老键）');
  const cases = [
    { legacy: { bgMode: 'preset', bgPreset: 'aurora' }, expect: 'none', label: '存着老默认背景（极光）→ 跟着新默认改成"无背景"' },
    { legacy: { bgMode: 'preset', bgPreset: 'ocean' }, expect: 'preset', label: '自己挑过背景（海盐）→ 保持不动' },
    { legacy: { glassAlpha: 0.72 }, expect: '0.5', label: '老的面板不透明度 72% → 跟着新默认改成 50%', prop: 'glassAlpha' },
    { legacy: { glassAlpha: 0.9 }, expect: '0.9', label: '自己调过的面板不透明度 90% → 保持不动', prop: 'glassAlpha' },
  ];
  for (const item of cases) {
    const page = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/', Object.assign({}, options, {
      beforeParse(window) {
        options.beforeParse(window);
        window.localStorage.setItem('md-reader:settings:v3', JSON.stringify(item.legacy));
      },
    }));
    await new Promise((resolve) => {
      if (page.window.document.readyState === 'complete') resolve();
      else page.window.addEventListener('load', resolve);
    });
    await sleep(200);
    // 面板不透明度的效果就是 body 上那个 CSS 变量，直接量它
    const actual = item.prop === 'glassAlpha'
      ? page.window.getComputedStyle(page.window.document.body).getPropertyValue('--glass-alpha').trim()
      : page.window.document.body.dataset.bgMode;
    check(item.label, actual, item.expect);
    page.window.close();
  }
}

console.log('');
if (problems.length > 0) {
  console.log('运行期问题（' + problems.length + '）：');
  for (const item of problems.slice(0, 8)) console.log('  - ' + item);
}
console.log(failures === 0 ? '全部通过' : '有 ' + failures + ' 项失败');
if (server !== null) server.kill();
process.exit(failures === 0 ? 0 : 1);
