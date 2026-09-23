/**
 * smoke.mjs —— 用 jsdom 把阅读器完整跑一遍（不需要浏览器）。
 *
 * 覆盖：渲染各元素、目录、锚点跳转、主题、搜索、多文档、侧栏树、设置面板、服务模式。
 * 服务模式会自己起 serve.mjs；静态模式还会用假句柄模拟浏览器的"打开文件夹"能力。
 *
 * 跑法（cwd 需要是 dsh 源码根目录，借它的 jsdom）：
 *   node ../md-reader/tools/smoke.mjs            # 静态模式（含模拟文件夹模式）
 *   node ../md-reader/tools/smoke.mjs --server   # 服务模式
 *   node ../md-reader/tools/smoke.mjs --single   # 单文件模式（serve.mjs --file，Windows"打开方式"用的那个）
 *   DOC_ROOT=../sprite-plugin node ../md-reader/tools/smoke.mjs --server   # 指定文档目录
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { get as httpGet } from 'node:http';
import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const CHECKOUT = process.env.DSH_CHECKOUT ?? fileURLToPath(new URL('../../deepseek-harness-ayine/', import.meta.url));
const require = createRequire(CHECKOUT + 'packages/client/ui-goal/package.json');
const { JSDOM, VirtualConsole } = require('jsdom');

const APP = fileURLToPath(new URL('../', import.meta.url));
const useServer = process.argv.includes('--server');
// --single：单文件模式（serve.mjs --file）。它和 --server 共用"从 HTTP 加载页面"这条路，
// 但页面应该是"直接打开那一篇、左侧不列文件"的样子，所以只跑它自己的那一组检查。
const useSingle = process.argv.includes('--single');
/** 页面从本地服务加载（服务模式 / 单文件模式都算）。 */
const fromServer = useServer || useSingle;
// --standalone：测那份"发给朋友的单文件 HTML"，而不是开发用的 index.html
const useStandalone = process.argv.includes('--standalone');
// 测试用独立端口：不打扰你自己跑着的那个服务（默认 4321）
const PORT = Number(process.env.TEST_PORT ?? 4399);

let failures = 0;
function check(label, actual, expected) {
  const ok = actual === expected;
  if (!ok) failures += 1;
  console.log((ok ? '  ok   ' : '  FAIL ') + label + ' -> ' + JSON.stringify(actual) + (ok ? '' : ' (expected ' + JSON.stringify(expected) + '）'));
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const problems = [];
const virtualConsole = new VirtualConsole();
virtualConsole.on('jsdomError', (error) => {
  if (/Not implemented/.test(error.message)) problems.push('not implemented: ' + error.message.split('\n')[0]);
  else problems.push('jsdomError: ' + error.message);
});
virtualConsole.on('error', (...args) => problems.push('console.error: ' + args.map(String).join(' ')));

let server = null;
if (fromServer) {
  // 先确认端口上没人在跑：serve.mjs 现在会"接到已经在跑的服务上"，
  // 万一上一次测试没清干净，这里会悄悄连到旧服务，报出一堆莫名其妙的失败。
  try {
    const stale = await fetch('http://127.0.0.1:' + PORT + '/api/info');
    if (stale.ok) {
      console.error('port ' + PORT + ' already has a service running (probably left over from a previous run).');
      console.error('clear it first: pkill -f serve.mjs');
      process.exit(1);
    }
  } catch {
    // 没人应答 = 端口是干净的
  }
  const docRoot = process.env.DOC_ROOT ?? APP;
  // 端口必须显式传给被拉起的服务，否则它会用默认的 4321（可能撞上你自己开着的那个）
  // --prefs：把偏好写到临时文件，别动用户自己那份；每次开跑前清掉，免得上次留下的设置影响这次
  const prefs = join(tmpdir(), 'md-reader-smoke-prefs.json');
  rmSync(prefs, { force: true });
  // --no-browser 很重要：测试里会调 /api/open，没人连着时它会真去开浏览器，
  // 那是给用户用的行为，自测里不该在你桌面上弹标签页。
  const args = useSingle
    ? [join(APP, 'serve.mjs'), '--file', join(APP, 'sample.md'), '--port', String(PORT), '--prefs', prefs, '--no-browser']
    : [join(APP, 'serve.mjs'), docRoot, '--port', String(PORT), '--prefs', prefs, '--no-browser'];
  server = spawn(process.execPath, args, { stdio: 'ignore' });
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
    console.error('service did not come up on port ' + PORT + ' (maybe the port is taken)');
    process.exit(1);
  }
}

/**
 * 模拟浏览器"选了一个文件夹"：造一批带 webkitRelativePath 的 File，
 * 直接喂给 #folder-input（应用现在靠 <input webkitdirectory>，不再用 File System Access）。
 * @param {object} window jsdom 的 window
 * @param {Record<string, string>} spec 形如 { 'a.md': '正文', 'sub/b.md': '正文' }（相对选中的文件夹）
 * @param {string} root 选中的文件夹名
 */
function fakeFolderFiles(window, spec, root) {
  return Object.entries(spec).map(([rel, text]) => {
    const file = new window.File([text], rel.split('/').pop(), { type: 'text/markdown' });
    Object.defineProperty(file, 'webkitRelativePath', { value: root + '/' + rel });
    return file;
  });
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
    /*
      jsdom 没有 EventSource。给一个最小替身（只实现我们用到的部分），
      这样"服务端推送 → 页面换一篇"这条链路也能在自测里跑到。
      测试里用 window.__sse.emit({...}) 假装服务端推了一条消息。
    */
    function FakeEventSource(url) {
      this.url = url;
      this.handlers = {};
      window.__sse = this;
    }
    FakeEventSource.prototype.addEventListener = function (type, fn) {
      (this.handlers[type] = this.handlers[type] || []).push(fn);
    };
    FakeEventSource.prototype.emit = function (payload) {
      for (const fn of this.handlers.message || []) fn({ data: JSON.stringify(payload) });
    };
    FakeEventSource.prototype.close = function () {};
    window.EventSource = FakeEventSource;

    // jsdom 里没有"选文件夹"这回事：静态模式下把假文件列表挂在 window 上，测试里再喂给 #folder-input
    if (!useServer) {
      window.__FAKE_FOLDER__ = fakeFolderFiles(window, {
        'a.md': '# Doc A\n\nFirst document.\n\n## Section one\n\nBody.\n',
        'sub/b.md': '# Doc B\n\nSecond document.\n\n## Section two\n\nBody.\n',
      }, 'notes');
    }
  },
};

// 单文件 HTML 的名字里带版本号（见 tools/version.mjs），所以按前缀找最新的那个
const standaloneName = useStandalone
  ? readdirSync(join(APP, 'build', 'standalone')).filter((name) => /^markdown-observer(-v[\w.-]+)?\.html$/.test(name))
      .sort((a, b) => statSync(join(APP, 'build', 'standalone', b)).mtimeMs - statSync(join(APP, 'build', 'standalone', a)).mtimeMs)[0]
  : null;
if (useStandalone && standaloneName === undefined) {
  console.error('没有找到构建好的单文件 HTML：先跑 node tools/build-standalone.mjs');
  process.exit(1);
}
const entry = useStandalone ? join(APP, 'build', 'standalone', standaloneName) : join(APP, 'index.html');
const dom = fromServer
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

console.log(useServer ? '== server mode ==' : (useSingle ? '== single-file mode (serve.mjs --file) ==' : (useStandalone ? '== standalone share build ==' : '== static mode (with simulated folder mode) ==')));

if (useSingle) {
  // 这个模式的全部意义：双击一篇 md，页面直接就是那一篇，左侧干干净净。
  console.log('1) opens the file it was started with');
  check('libraries still load', typeof window.marked, 'object');
  check('the file from the command line opens by itself', id('doc-title').textContent, 'sample.md');
  check('entered reading state', document.body.dataset.reading, 'true');
  check('body rendered (not an empty shell)', id('content').querySelectorAll('h1, h2, p').length > 0, true);
  check('outline has entries', id('toc').querySelectorAll('.row').length > 0, true);
  check('exactly one open document', id('doc-list').querySelectorAll('.doc-row').length, 1);
  console.log('2) no file list on the left');
  check('file tree is empty', id('file-tree').querySelectorAll('.row').length, 0);
  check('folder row has no name yet', id('root-name').textContent, '');
  check('Workspace label is there', document.querySelectorAll('.pane-docs .section-label').length >= 1, true);
  check('folder row has no name yet', id('root-name').textContent, '');
  check('the row is visible', id('root-line').hidden, false);
  // 作者样式里的 display 会盖掉浏览器对 [hidden] 的默认处理，这里量一下"真的没被藏"（这个坑踩过）
  check('the row is not display:none', window.getComputedStyle(id('root-line')).display !== 'none', true);

  check('empty state does not suggest the left list', id('card-browse').hidden, true);
  check('empty state keeps the Open-file card', id('card-open').hidden, false);
  console.log('3) server API');
  const singleInfo = await (await fetch('http://127.0.0.1:' + PORT + '/api/info')).json();
  check('shape is single-file', singleInfo.shape, 'file');
  check('info.file points at the startup file (absolute)', singleInfo.file.endsWith('/sample.md'), true);
  check('its folder is in the allow-list', singleInfo.roots.length >= 1 && singleInfo.roots[0].endsWith('/md-reader'), true);
  const singleTree = await (await fetch('http://127.0.0.1:' + PORT + '/api/tree')).json();
  check('tree is empty', singleTree.files.length, 0);
  // 白名单是服务唯一的围栏，值得一条断言守着
  const outside = await fetch('http://127.0.0.1:' + PORT + '/api/file?path=' + encodeURIComponent('/etc/passwd'));
  check('paths outside the allow-list are blocked', outside.status, 400);
  // Host 头校验只能用原始 socket 测：fetch 不允许手写 Host（它属于被禁止的头）
  const rawStatus = await new Promise((resolve) => {
    const socket = connect(PORT, '127.0.0.1', () => {
      socket.write('GET /api/info HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n');
    });
    let text = '';
    socket.on('data', (chunk) => { text += chunk });
    socket.on('end', () => resolve(Number((/^HTTP\/1\.1 (\d+)/.exec(text) ?? [])[1] ?? 0)));
    socket.on('error', () => resolve(0));
  });
  check('a wrong Host header is blocked (DNS rebinding)', rawStatus, 403);
  console.log('4) resident and reuse');
  // 用一条真的 HTTP 长连接冒充"开着的阅读器页面"：服务端据此决定复用页面还是新开标签
  const live = httpGet({ host: '127.0.0.1', port: PORT, path: '/api/events' }, (res) => { res.on('data', () => {}) });
  await sleep(250);
  const opened = await (await fetch('http://127.0.0.1:' + PORT + '/api/open?path=' + encodeURIComponent(singleInfo.file))).json();
  check('the open API accepts the file', opened.ok, true);
  check('with a page connected the server reuses it', opened.mode, 'reuse');
  live.destroy();
  // 断开的察觉是异步的，给它几秒钟（真实使用里"关掉页面"和"再双击"之间隔得远得多）
  let alone = null;
  for (let i = 0; i < 12; i += 1) {
    await sleep(300);
    alone = await (await fetch('http://127.0.0.1:' + PORT + '/api/open?path=' + encodeURIComponent(singleInfo.file))).json();
    if (alone.mode === 'tab') break;
  }
  check('with nobody connected the server opens a new tab', alone.mode, 'tab');
  console.log('5) server pushes a file -> the page follows');
  check('event stream connected', window.__sse !== undefined && window.__sse.url.endsWith('api/events'), true);
  const other = singleInfo.roots[0] + '/DEVELOPING.md';
  window.__sse.emit({ type: 'open', doc: { path: other, name: 'DEVELOPING.md' } });
  await sleep(400);
  check('switched to the pushed file', id('doc-title').textContent, 'DEVELOPING.md');
  check('two documents in the sidebar list now', id('doc-list').querySelectorAll('.doc-row').length, 2);
  // 工作区是"每个页面自己的事"：没有 ?root= 的页面不该凭空长出一棵别人的树
  // 文档里的相对 .md 链接必须在阅读器里打开：
  // 以前没接住 → 浏览器去请求那个文件 → "点一下下载了个文件"，而且页面被导航走、长连接断掉，
  // 服务端从此以为没人在看，之后每次打开都新开标签页（设置怎么调都没用）。
  console.log('5a) a relative .md link opens inside the reader');
  const link = [...id('doc').querySelectorAll('.markdown a')].find((a) => (a.getAttribute('href') || '').endsWith('.md'));
  check('the sample has a relative .md link', link !== undefined, true);
  if (link !== undefined) {
    const before = id('doc-title').textContent;
    link.click();
    await sleep(400);
    check('clicking it switched the document in place', id('doc-title').textContent !== before, true);
    check('and the address bar follows it', window.location.search.includes('file='), true);
  }
  // 设置面板里那条说明文字的实际间距（用户反馈"和上面那行之间空了一大块"）
  const noteStyle = window.getComputedStyle(window.document.querySelector('#pop-act .pop-note'));
  // 说明文字和上面那行控件之间不该有大空档（曾经是 margin 12 + padding 12 = 24px，太松）
  check('the note sits right under the switch', noteStyle.marginTop, '12px');
  check('and adds no extra padding of its own', parseFloat(noteStyle.paddingTop), 0);
  console.log('5b) a page without ?root= has no workspace of its own');
  check('no tree on a single-file page', id('file-tree').querySelectorAll('.row').length, 0);
  check('the folder row stays empty', id('root-name').textContent, '');
  // 作者样式里的 display 会盖掉浏览器对 [hidden] 的处理（踩过两次：文件夹那一行、文件树）。
  // 全页面扫一遍：凡是带 hidden 的元素，计算样式里都不许被显示出来。
  const stuckHidden = [...document.querySelectorAll('[hidden]')].filter((node) => window.getComputedStyle(node).display !== 'none');
  check('every [hidden] element is really hidden', stuckHidden.map((node) => node.id || node.className).join(','), '');
  // 为了"让浏览器肯开一个新标签"而在地址里加的 ?n=时间戳，用完就该抹掉（留着难看、分享出去更莫名其妙）
  console.log('5c) the ?n= marker is cleaned out of the address bar');
  const cleanPage = await JSDOM.fromURL('http://127.0.0.1:' + PORT + '/?blank=1&n=12345', options);
  await new Promise((resolve) => {
    if (cleanPage.window.document.readyState === 'complete') resolve();
    else cleanPage.window.addEventListener('load', resolve);
  });
  await sleep(300);
  check('the n= marker is gone', cleanPage.window.location.search.includes('n='), false);
  check('blank=1 is kept', cleanPage.window.location.search.includes('blank=1'), true);
  check('a blank page opens no document', cleanPage.window.document.querySelectorAll('#doc-list .doc-row').length, 0);
  cleanPage.window.close();
  console.log('6) settings: the Behavior tab');
  check('the Behavior tab appears (server mode only)', id('tab-act').hidden, false);
  check('Advanced inside Behavior is collapsed by default', id('advanced-body').hidden, true);
  check('the skip list was read from the server', id('skip-dirs').value.includes('node_modules'), true);
  id('btn-advanced').click();
  check('clicking Expand opens it', id('advanced-body').hidden, false);
  id('sw-opentab').click();
  await sleep(400);
  const pref = await (await fetch('http://127.0.0.1:' + PORT + '/api/pref')).json();
  check('the switch saved to the server', pref.openMode, 'tab');
  // 开机自启由托盘管：测试环境里没有托盘，这一项应该整行收起来（而不是给一个按了没反应的开关）
  await sleep(250);
  check('the auto-start row is hidden when the tray is not running', id('row-autostart').hidden, true);
  const opened2 = await (await fetch('http://127.0.0.1:' + PORT + '/api/open?path=' + encodeURIComponent(other))).json();
  check('after switching to new-tab a new tab opens even with a page connected', opened2.mode, 'tab');
  console.log('7) a second workspace (what the tray menu opens)');
  const keep = await (await fetch('http://127.0.0.1:' + PORT + '/api/root?keep=1&path=' + encodeURIComponent(singleInfo.roots[0] + '/tools'))).json();
  check('keep=1 allows a folder without switching', keep.ok, true);
  const wsTree = await (await fetch('http://127.0.0.1:' + PORT + '/api/tree?root=' + encodeURIComponent(keep.root))).json();
  check('the new workspace gets its own tree', wsTree.root.endsWith('/tools'), true);
  const infoAfter = await (await fetch('http://127.0.0.1:' + PORT + '/api/info')).json();
  check('the root of the other workspace was not switched', infoAfter.shape, 'file');
  const denied = await fetch('http://127.0.0.1:' + PORT + '/api/tree?root=' + encodeURIComponent('/etc'));
  check('a folder that was never allowed is refused', denied.status, 400);
  // 托盘菜单的"退出"和 status.mjs --stop 都靠这个接口。放最后测：它会真的把服务关掉。
  console.log('7) the quit API (used by the tray menu and status --stop)');
  const quit = await (await fetch('http://127.0.0.1:' + PORT + '/api/quit')).json();
  check('the quit API answers ok', quit.ok, true);
  let gone = false;
  for (let i = 0; i < 20 && !gone; i += 1) { await sleep(300); gone = server.exitCode !== null; }
  check('the service is gone after /api/quit', gone, true);
  server = null;
  finish();
}

// 版本号只有一个来源（git tag），VERSION 文件是它的生成物——这里核对一次，防止两边漂移
console.log('0) version consistency');
{
  let versionOk = true;
  let versionText = '';
  try {
    versionText = execFileSync(process.execPath, [join(APP, 'tools', 'version.mjs'), '--check'], { encoding: 'utf8' });
  } catch (error) {
    versionOk = false;
    versionText = String(error.stdout ?? '') + String(error.stderr ?? '');
  }
  check('the VERSION file matches the git tag', versionOk, true);
  if (!versionOk) console.log('      ' + versionText.trim());
}
console.log('1) libraries and initial state');
if (useStandalone) {
  check('no external stylesheet links', document.querySelectorAll('link[rel=stylesheet]').length, 0);
  check('no external script links', document.querySelectorAll('script[src]').length, 0);
  check('styles are inlined', document.querySelectorAll('style').length >= 5, true);
  check('math fonts are inlined', document.documentElement.innerHTML.includes('data:font/woff2'), true);
  // 回归防线：内联字体时曾经把 src 列表一路吃到右花括号，20 条 @font-face 塌成 2 条，
  // 结果"开发页公式正常、打包出来用回退字体"。条数必须与源文件一致，且不能再引用外部字体。
  const builtCss = readFileSync(entry, 'utf8');
  const sourceK = readFileSync(join(APP, 'vendor', 'katex.min.css'), 'utf8');
  check('built file has at least as many @font-face rules as the source (now ' + (builtCss.match(/@font-face/g) ?? []).length + ' vs ' + (sourceK.match(/@font-face/g) ?? []).length + '）',
    (builtCss.match(/@font-face/g) ?? []).length >= (sourceK.match(/@font-face/g) ?? []).length, true);
  check('built file no longer references external fonts', (builtCss.match(/url\(\s*['"]?fonts\//g) ?? []).length, 0);
}
check('marked', typeof window.marked, 'object');
check('hljs', typeof window.hljs, 'object');
check('DOMPurify', typeof window.DOMPurify.sanitize, 'function');
check('katex', typeof window.katex, 'object');
check('the sample document is embedded', typeof window.__SAMPLE_MD__, 'string');
check('starts in the empty state', document.body.dataset.reading, 'false');
check('sidebar starts open', document.body.dataset.sidebar, 'open');
check('default background mode is plain', document.body.dataset.bgMode, 'none');
check('plain mode is a subtle gradient, not flat white', window.getComputedStyle(document.documentElement).getPropertyValue('--plain-bg').includes('linear-gradient'), true);
// 玻璃配方用的是 background-color 长写属性，jsdom 只把原始文本放在这个属性里
const bgText = (cs) => String(cs.backgroundColor || '') + String(cs.backgroundImage || '') + String(cs.background || '');
const sampleBtn = window.getComputedStyle(id('btn-sample'));
check('buttons are glass: frosted blur', sampleBtn.backdropFilter.includes('blur'), true);
check('button fill comes from the glass variable', bgText(sampleBtn).includes('--btn-glass-veil'), true);
check('light-theme button fill is ink, not white', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-veil').trim(), '38 49 72');
// 底色降到 0：背景色原样透过，轮廓靠磨砂 + 凸感（顶部高光 / 底部内阴影 / 投影）
check('buttons carry no fill of their own', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha').trim(), '0');
check('raised look: top highlight and shadow', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-rim').includes('inset 0 1px 0'), true);
check('the segmented track is more opaque than buttons (10%)', window.getComputedStyle(id('card-open')).getPropertyValue('--seg-track-alpha').trim(), '0.10');
// 图标按钮照 dsh 的做法：默认什么都不画，只有 hover 浮出一层淡色（不是玻璃片）
const iconBtnStyle = window.getComputedStyle(document.querySelector('.topbar .icon-btn'));
check('icon buttons have no plate by default', bgText(iconBtnStyle).includes('--btn-glass-veil'), false);
check('icon buttons are not frosted either', iconBtnStyle.backdropFilter, 'none');
check('the pull-out circle is not a glass plate either', bgText(window.getComputedStyle(id('btn-sidebar'))).includes('--btn-glass-veil'), false);

console.log('1b) empty state: cards show or hide per environment');
check('the empty panel is present', id('empty').hidden, false);
check('the Open-file card is present', id('card-open').hidden, false);
if (useServer) {
  check('server mode: hides Open-folder, shows Pick-on-the-left', id('card-folder').hidden + '/' + id('card-browse').hidden, 'true/false');
} else {
  check('local mode: shows Open-folder', id('card-folder').hidden, false);
  check('local mode: hides Pick-on-the-left (no list yet)', id('card-browse').hidden, true);
}
// 只观察"有没有真的去唤起文件选择框"：把 click 换掉，避免 jsdom 去实现真实的选择框
const fileInput = id('file-input');
const realInputClick = fileInput.click.bind(fileInput);
let pickerCalls = 0;
fileInput.click = () => { pickerCalls += 1; };
id('card-open').click();
// 服务模式下会先问一句托盘（它弹的是我们自己的窗口），问不到才回落到浏览器这个——所以要等一下
await sleep(250);
check('clicking the Open-file card opens the picker', pickerCalls, 1);
fileInput.click = realInputClick;
const cardStyle = window.getComputedStyle(id('card-open'));
check('cards are in a row: icon and text share a line', cardStyle.flexDirection, 'row');
check('the icon is centered against the two text lines', cardStyle.alignItems, 'center');
check('the text block has a title and a note line', id('card-open').querySelector('.card-text').children.length, 2);
// 文字要在"自己那块空间"里居中：卡片左边还有图标，按整个按钮居中会偏
check('card text is centered in its own block', window.getComputedStyle(id('card-open').querySelector('.card-text')).textAlign, 'center');
// "大仓库请用服务模式"是卡片下面单独一行小灰字，不是卡片里的第三行
const emptyNote = document.querySelector('.empty-note');
check('the big-repo note sits outside the cards', emptyNote !== null && emptyNote.textContent.includes('服务模式'), true);
check('it comes after the card row', emptyNote !== null && emptyNote.previousElementSibling === id('empty').querySelector('.empty-cards'), true);
check('the note is left-aligned', window.getComputedStyle(document.querySelector('.empty-sub')).textAlign, 'left');
check('cards use the glass recipe too', cardStyle.backdropFilter.includes('blur') && bgText(cardStyle).includes('--btn-glass-veil'), true);

console.log('2) rendering the sample document');
id('btn-sample').click();
await sleep(300);
const content = id('content');
check('entered reading state', document.body.dataset.reading, 'true');
check('the title bar shows the document name', id('doc-title').textContent, 'sample.md');
check('code block shell', content.querySelectorAll('.md-code-block').length, 5);
check('syntax highlighting', content.querySelectorAll('.md-code-block .hljs').length, 4);
check('copy button', content.querySelectorAll('.copyButton').length, 5);
check('copy button也是玻璃', window.getComputedStyle(content.querySelector('.copyButton')).backdropFilter.includes('blur'), true);
check('table scroll container', content.querySelectorAll('.tableScroll').length, 1);
check('task list item', content.querySelectorAll('li.task-list-item').length, 3);
check('checkboxes are disabled', content.querySelectorAll('input[type=checkbox][disabled]').length, 3);
check('inline math', content.querySelectorAll('.katex').length >= 4, true);
check('display math block', content.querySelectorAll('.katex-display').length, 1);
check('footnote section', content.querySelectorAll('section.footnotes').length, 1);
check('footnote back-reference', content.textContent.includes('↩'), true);
check('images are clickable', content.querySelectorAll('img.image.clickable').length, 1);
check('external links open in a new window', content.querySelector('a[target=_blank]') !== null, true);
check('dangerous tags are stripped', content.innerHTML.includes('<script'), false);

console.log('3) heading anchors (readable, CJK friendly)');
const codeHeading = content.querySelector('h2:nth-of-type(1)');
check('the anchor id is the readable CJK form', content.querySelector('h2[id]').id.length > 0 && /[\u4e00-\u9fff]/.test(content.querySelector('h2[id]').id), true);
check('duplicate headings get unique ids', (() => { const ids = [...content.querySelectorAll('[id]')].map((n) => n.id); return ids.length === new Set(ids).size })(), true);

console.log('4) in-page jumps and deep links');
// 注意：href 里的中文会被浏览器/解析器编码成 %E6%95%B0…，比较时要解码
const decode = (value) => decodeURIComponent(value || '');
const jumpLink = [...content.querySelectorAll('a')].find((a) => decode(a.getAttribute('href')) === '#数学公式');
check('the sample has an in-page link', jumpLink !== undefined, true);
if (jumpLink !== undefined) {
  jumpLink.click();
  await sleep(120);
  check('a chip appears after jumping', id('jump-chip').hidden, false);
  check('the URL records the section', decode(window.location.hash), '#数学公式');
  id('jump-back').click();
  await sleep(320);   // 提示条有 200ms 淡出动画
  check('the chip can be dismissed', id('jump-chip').hidden, true);
}
check('a missing anchor does not throw', (() => { try { key('Escape'); return true } catch { return false } })(), true);

console.log('5) theme switching');
document.querySelector('[data-theme="dark"]').click();
await sleep(60);
check('dark: body attribute', document.body.hasAttribute('data-ds-dark-theme'), true);
check('dark: color-scheme', document.documentElement.style.colorScheme, 'dark');
check('dark-theme button fill becomes a light veil', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-veil').trim(), '255 255 255');
// 回归：面板透明度由设置决定，深色主题下也必须是滑杆说了算（曾经被 body 上的规则盖掉）
const glassNum = id('n-glass');
glassNum.value = '45';
glassNum.dispatchEvent(new window.Event('change', { bubbles: true }));
check('panel opacity follows the slider in dark theme', window.getComputedStyle(document.querySelector('.sidebar')).getPropertyValue('--glass-alpha').trim(), '0.45');
check('the selected state is clearly more opaque than buttons (24% vs 3%)', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha-on').trim(), '0.24');
check('buttons carry no fill in dark theme either', window.getComputedStyle(id('card-open')).getPropertyValue('--btn-glass-alpha').trim(), '0');
document.querySelector('[data-theme="light"]').click();
await sleep(60);
check('light: attribute removed', document.body.hasAttribute('data-ds-dark-theme'), false);

console.log('6) in-document search');
id('btn-search').click();
const searchInput = id('search-input');
check('the search bar opens', id('searchbar').hidden, false);
searchInput.value = 'dsh';
searchInput.dispatchEvent(new window.Event('input', { bubbles: true }));
await sleep(250);
const hitCount = content.querySelectorAll('mark.hit').length;
check('hits are highlighted', hitCount > 0, true);
check('the counter is shown', id('search-count').textContent, '1/' + hitCount);
id('search-next').click();
await sleep(60);
check('exactly one current hit', content.querySelectorAll('mark.hit.current').length, 1);
id('search-close').click();
await sleep(60);
check('highlight cleared after closing', content.querySelectorAll('mark.hit').length, 0);

console.log('7) settings panel (tabs + number fields)');
id('btn-settings').click();
check('the panel opens', id('popover').hidden, false);
check('starts on the Typography tab', id('pop-type').hidden, false);
check('no Appearance tab (theme lives in the top bar)', document.querySelector('[data-ptab="look"]'), null);
// 全局设置入口搬到了左下角：它不该再出现在顶栏里，而且侧栏收起后也必须还在
const seat = id('btn-settings');
check('the settings entry is no longer in the top bar', document.querySelector('.topbar').contains(seat), false);
check('the settings entry is pinned bottom-left', window.getComputedStyle(seat).position, 'fixed');
check('the sidebar reserves room for it', window.getComputedStyle(id('sidebar-body')).getPropertyValue('--sidebar-pad-bottom').trim(), '62px');
check('no show-sidebar switch in settings', id('sw-sidebar'), null);
check('the serif switch is on the Typography tab', id('sw-serif') !== null && id('pop-type').contains(id('sw-serif')), true);
const num = id('n-scale');
num.value = '120';
num.dispatchEvent(new window.Event('change', { bubbles: true }));
check('typing a size updates the CSS variable', document.documentElement.style.getPropertyValue('--read-scale'), '1.2');
check('the slider follows', id('r-scale').value, '1.2');
num.value = '999';
num.dispatchEvent(new window.Event('change', { bubbles: true }));
check('out-of-range values are clamped', num.value, '140');
document.querySelector('[data-ptab="bg"]').click();
check('switch to the Background tab', id('pop-bg').hidden, false);
check('recents has 5 slots', id('recents').querySelectorAll('.recent').length, 5);
// 空格子以前叫 .recent.empty，和"空状态面板"的 .empty 撞名，被那套 max-width/margin/padding/圆角顶到下一行
const slotCell = id('recents').querySelector('.recent.slot');
check('empty slots use the slot class, not the empty-state .empty', slotCell !== null && slotCell.matches('.empty') === false, true);
// "无背景"下模糊/遮罩没有作用对象：灰掉并给出说明，而不是让人以为滑杆坏了
check('blur is disabled under plain mode', id('r-blur').disabled && id('field-blur').dataset.off, 'true');
check('the dim slider is disabled under plain mode', id('r-dim').disabled && id('field-dim').dataset.off, 'true');
check('the note explains plain mode', id('bg-note').textContent.includes('无背景'), true);
id('swatches').querySelectorAll('.swatch')[0].click();   // 再点一次"无背景"：滑杆应保持灰
check('clicking the plain swatch keeps blur disabled', id('r-blur').disabled, true);
id('swatches').querySelectorAll('.swatch')[1].click();   // 第一个内置渐变
check('blur becomes available after picking a preset', id('r-blur').disabled, false);
id('swatches').querySelectorAll('.swatch')[0].click();   // 还原成默认的"无背景"
id('sw-wrap').click();
check('code wrapping can be turned off', document.body.dataset.codeWrap, 'off');
id('sw-wrap').click();

console.log('8) sidebar: one scroll container, collapse and pull-out');
check('both the documents pane and the outline pane exist', id('pane-docs').hidden === false && id('pane-toc').hidden === false, true);
check('both panes are children of the same scroll container', id('pane-docs').parentElement === id('sidebar-body') && id('pane-toc').parentElement === id('sidebar-body'), true);
check('no draggable splitter anymore', document.querySelector('#sidebar-splitter, .splitter'), null);
check('no segmented control anymore', document.querySelector('[data-stab]'), null);
const bodyOverflow = window.getComputedStyle(id('sidebar-body')).overflowY;
check('the sidebar body scrolls itself (auto/scroll)', bodyOverflow === 'auto' || bodyOverflow === 'scroll', true);
const paneOverflow = window.getComputedStyle(id('pane-docs')).overflowY;
check('the documents pane no longer scrolls on its own (actual ' + (paneOverflow || '空') + '）', paneOverflow !== 'auto' && paneOverflow !== 'scroll', true);
check('the sidebar head does not scroll', id('sidebar-body').contains(id('btn-collapse')), false);

console.log('8b) outline collapsing');
const tocBox = id('toc');
const visibleRows = () => tocBox.querySelectorAll('.toc-row').length;
const totalHeadings = content.querySelectorAll('h1, h2, h3, h4').length;
check('the outline is a tree (rows with twisties exist)', tocBox.querySelectorAll('.toc-row .twisty:not(.spacer)').length > 0, true);
check('h3 entries are collapsed by default', visibleRows() < totalHeadings, true);
const hiddenRow = [...tocBox.querySelectorAll('.toc-row')].find((row) => row.dataset.target === '三级标题也会出现在目录里');
check('collapsed h3 entries are not listed', hiddenRow, undefined);
const parentTwisty = [...tocBox.querySelectorAll('.toc-row')].find((row) => row.dataset.target === '代码块').querySelector('.twisty');
parentTwisty.click();
check('expanding reveals the h3 entries', [...tocBox.querySelectorAll('.toc-row')].some((row) => row.dataset.target === '三级标题也会出现在目录里'), true);
check('clicking the twisty does not jump', decode(window.location.hash) === '' || decode(window.location.hash) === '#数学公式', true);
parentTwisty.click();
check('clicking again collapses', [...tocBox.querySelectorAll('.toc-row')].some((row) => row.dataset.target === '三级标题也会出现在目录里'), false);

check('sidebar starts open → 拉出按钮藏着', document.body.dataset.sidebar, 'open');
id('btn-collapse').click();
check('the sidebar can be collapsed', document.body.dataset.sidebar, 'closed');
check('the pull-out circle appears', id('btn-sidebar').classList.contains('sidebar-pull'), true);
id('btn-sidebar').click();
check('clicking the circle expands again', document.body.dataset.sidebar, 'open');
document.querySelector('[data-theme="system"]').click();
key('t');
check('T cycles the theme (system -> light)', document.body.hasAttribute('data-ds-dark-theme'), false);
key('t');
check('T again goes dark', document.body.hasAttribute('data-ds-dark-theme'), true);
document.querySelector('[data-theme="light"]').click();

console.log('9) multiple documents and the file tree');

if (useServer) {
  // 先关掉前面打开的示例文档，让这一节从干净的文档列表开始
  while (id('doc-list').querySelector('.doc-close') !== null) {
    id('doc-list').querySelector('.doc-close').click();
    await sleep(100);
  }
  check('the document list is empty', id('doc-list').querySelectorAll('.doc-row').length, 0);
  // 服务模式：树来自服务器的目录扫描
  const files = [...id('file-tree').querySelectorAll('.tree-row.file')];
  check('the file tree has files', files.length > 0, true);
  check('the root name is shown', id('root-name').textContent.length > 0, true);
  files[0].click();
  await sleep(300);
  const firstTitle = id('doc-title').textContent;
  check('clicking a file starts reading', document.body.dataset.reading, 'true');
  check('the URL carries ?file=', window.location.search.startsWith('?file='), true);
  // 展开一个子目录，找第二个文件
  const dir = id('file-tree').querySelector('.tree-row.dir');
  if (dir !== null) { dir.click(); await sleep(80) }
  const other = [...id('file-tree').querySelectorAll('.tree-row.file')].find((row) => row.dataset.path !== files[0].dataset.path);
  check('at least two files in the tree', other !== undefined, true);
  if (other !== undefined) { other.click(); await sleep(300) }
  check('two documents are open', id('doc-list').querySelectorAll('.doc-row').length >= 2, true);
  key('1', { altKey: true });
  await sleep(150);
  check('Alt+1 goes back to the first document', id('doc-title').textContent, firstTitle);
  key(']', { altKey: true });
  await sleep(150);
  check('Alt+] switches to the next', id('doc-title').textContent !== firstTitle, true);
} else {
  // 静态模式：模拟浏览器的"选了一个文件夹"——点按钮 → 给 #folder-input 喂一批 File → 触发 change
  id('btn-open-folder').click();
  // openDirectory 现在是异步的（会先问一句"托盘在不在"），等它走到"弹选择框"那一步再喂文件
  await sleep(250);
  const folderInput = id('folder-input');
  Object.defineProperty(folderInput, 'files', { value: window.__FAKE_FOLDER__, configurable: true });
  folderInput.dispatchEvent(new window.Event('change', { bubbles: true }));
  await sleep(300);
  check('the root name shows up', id('root-name').textContent, 'notes');
  check('after picking a folder the empty state points to the left list', id('card-browse').hidden, false);
  // 「选完文件夹什么都没发生」曾经是真实反馈：中间那段说明必须改口，别让人以为没反应
  check('the middle text now points to the left list', id('empty-sub').textContent.includes('左侧已经列出'), true);
  // 假目录里是 a.md 和 sub/b.md，一共 2 篇（示例文档不算在里面）
  check('the footer reports how many were found', id('toast').textContent.includes('找到 2 个 markdown 文件'), true);
  check('collapsed: only top-level files are shown', id('file-tree').querySelectorAll('.tree-row.file').length, 1);
  check('there is a collapsible folder', id('file-tree').querySelectorAll('.tree-row.dir').length, 1);
  id('file-tree').querySelector('.tree-row.file').click();
  await sleep(200);
  check('open the first file', id('doc-title').textContent, 'a.md');
  id('file-tree').querySelector('.tree-row.dir').click();
  await sleep(80);
  check('expanding shows the nested file', id('file-tree').querySelectorAll('.tree-row.file').length, 2);
  const second = [...id('file-tree').querySelectorAll('.tree-row.file')].find((row) => row.dataset.path === 'sub/b.md');
  second.click();
  await sleep(200);
  check('open the second file', id('doc-title').textContent, 'b.md');
  check('three documents open in total (sample included)', id('doc-list').querySelectorAll('.doc-row').length, 3);
  check('exactly one item is highlighted', id('doc-list').querySelectorAll('.doc-row.active').length, 1);
  key('1', { altKey: true });
  await sleep(150);
  check('Alt+1 jumps to the first document', id('doc-title').textContent, 'sample.md');
  key(']', { altKey: true });
  await sleep(150);
  check('Alt+] jumps to the next', id('doc-title').textContent, 'a.md');
  id('doc-list').querySelector('.doc-row.active .doc-close').click();
  await sleep(200);
  check('two left after closing', id('doc-list').querySelectorAll('.doc-row').length, 2);
  check('closing the current item switches to its neighbor', id('doc-title').textContent, 'b.md');
}

if (useServer) {
  // 每个用例单独开一个页面，假装浏览器里存着老设置，验证迁移规则
  console.log('12) migrating old settings (v4 <- legacy keys)');
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

/**
 * 收工：打印运行期问题与结论，关掉测试用的服务，按失败数决定退出码。
 * （单文件模式在它自己那组检查结束后就调用它，不往下跑共享的那一整套。）
 */
function finish() {
  console.log('');
  if (problems.length > 0) {
    console.log('runtime problems (' + problems.length + '）：');
    for (const item of problems.slice(0, 8)) console.log('  - ' + item);
  }
  console.log(failures === 0 ? 'all checks passed' : String(failures) + ' check(s) failed');
  if (server !== null) server.kill();
  process.exit(failures === 0 ? 0 : 1);
}

finish();
