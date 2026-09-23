/*
  插件的自测：在 jsdom 里把"webview 那一整份"跑起来。

  为什么能这么测：插件的界面 = 应用本体 + 一个桥，两边都是普通的前端代码，
  只有 acquireVsCodeApi 是编辑器给的。这里伪造一个最小实现（顺便把扩展那一侧
  的 read/images 也实现掉），就能把"宿主 → 应用 → 渲染"整条链路走一遍——
  剩下的只有"编辑器真的把 webview 显示出来"这一步，那一步只能在编辑器里按 F5 看。

  用法：node tools/vscode/smoke.mjs
*/
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createRequire } from 'node:module';

import { JSDOM, VirtualConsole } from 'jsdom';

const APP = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const MEDIA = join(APP, 'build', 'vscode', 'pkg', 'media');

// 插件的路径计算（CJS，纯函数）：直接加载来测，不经过编辑器
const require = createRequire(import.meta.url);
const paths = require(join(APP, 'vscode', 'src', 'paths.js'));
const DOC = join(APP, 'build', 'vscode', 'pkg', 'media', 'sample.md');

const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, ok });
  console.log('  ' + (ok ? 'ok  ' : 'FAIL') + ' ' + name + (detail === undefined ? '' : ' -> ' + detail));
};

const markdown = [
  '# 插件渲染自测',
  '',
  '正文里有**加粗**、`行内代码`，还有公式 $a^2 + b^2 = c^2$。',
  '',
  '## 二级标题',
  '',
  '```js',
  'const answer = 42;',
  '```',
  '',
  '| 列 | 值 |',
  '| --- | --- |',
  '| a | 1 |',
  '',
  '- [x] 任务一',
  '- [ ] 任务二',
  '',
].join('\n');

/*
  真实场景里，扩展会在 webview 的 <body> 上注入两个 data-*（见 src/preview-provider.js）。
  这里照做一遍——既是启动数据，也顺便验证"用 data 而不是脚本"这条路走得通。
*/
const bootHtml = readFileSync(join(MEDIA, 'index.html'), 'utf8').replace(
  /<body(\s|>)/,
  '<body data-vscode-file="' + encodeURIComponent(JSON.stringify('/fake/notes/test.md')) + '"'
  + ' data-vscode-settings="' + encodeURIComponent(JSON.stringify({
    scale: 1.1, width: 700, theme: 'light',
    // 宿主给的背景图（编辑器里就是 VS Code 设置里那个路径转成的地址）
    bgImageUrl: 'vscode-resource://fake/bg.png',
  })) + '"$1',
);

const sent = [];
const settingsSeen = [];
const dom = new JSDOM(bootHtml, {
  url: 'file://' + MEDIA + '/index.html',
  runScripts: 'dangerously',
  resources: 'usable',
  pretendToBeVisual: true,
  virtualConsole: new VirtualConsole(),   // 应用自己的 console 噪音不往这里灌
  beforeParse(window) {
    const api = {
      postMessage(message) {
        sent.push(message);
        // 扩展那一侧的最小实现：读正文、换图片地址
        if (message.type !== 'call') return;
        if (message.kind === 'read') {
          window.postMessage({ type: 'result', id: message.id, ok: true, data: { text: markdown, name: 'test.md', size: markdown.length } }, '*');
        } else if (message.kind === 'images') {
          const map = {};
          for (const raw of (message.payload && message.payload.paths) || []) map[raw] = 'vscode-resource://fake/' + raw;
          window.postMessage({ type: 'result', id: message.id, ok: true, data: map }, '*');
        } else {
          window.postMessage({ type: 'result', id: message.id, ok: true, data: null }, '*');
        }
      },
      getState: () => undefined,
      setState: () => {},
    };
    window.acquireVsCodeApi = () => api;
    // jsdom 没有剪贴板；应用会据此不挂"复制"按钮（这个判断是对的），这里补上
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async () => {} }, configurable: true });
    // index.html 里引的 sample.md 不存在，jsdom 会报 404；挡掉这个噪音
    window.addEventListener('error', () => {});
  },
});

const { window } = dom;
const $ = (sel) => window.document.querySelector(sel);
const waitFor = async (fn, timeout = 4000) => {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (fn()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

const ready = await waitFor(() => $('#content') !== null && $('#content').children.length > 0);
check('webview 起来了并渲染出正文', ready);
if (ready) {
  const content = $('#content');
  check('桥认得出这是编辑器里', window.__VSCODE_HOST__ !== undefined);
  check('换上了精简外壳（data-shell=vscode）', window.document.body.dataset.shell === 'vscode', window.document.body.dataset.shell);
  check('一级标题渲染', content.querySelector('h1') !== null, content.querySelector('h1') && content.querySelector('h1').textContent);
  check('二级标题渲染', content.querySelectorAll('h2').length >= 1);
  check('加粗与行内代码', content.querySelector('strong') !== null && content.querySelector('code') !== null);
  check('代码块高亮 + 复制按钮', content.querySelector('pre code') !== null && content.querySelector('.md-code-block .copyButton') !== null);
  check('表格包了横向滚动容器', content.querySelector('table') !== null);
  check('任务列表渲染成复选框', content.querySelectorAll('input[type=checkbox]').length === 2, String(content.querySelectorAll('input[type=checkbox]').length));
  check('KaTeX 公式渲染', content.querySelector('.katex') !== null);
  check('本页目录（#pane-toc）有内容', window.document.querySelectorAll('#pane-toc .toc-row').length >= 2,
    String(window.document.querySelectorAll('#pane-toc .toc-row').length) + ' 项');
  check('精简外壳的样式挂上了', window.document.querySelector('link[href*="vscode.css"]') !== null);
  check('宿主设置被套用（字号 110%、栏宽 700）',
    window.document.documentElement.style.getPropertyValue('--read-scale') === '1.1'
    && window.document.documentElement.style.getPropertyValue('--read-width') === '700px',
    window.document.documentElement.style.getPropertyValue('--read-scale') + ' / ' + window.document.documentElement.style.getPropertyValue('--read-width'));
  check('深浅色按宿主设置走（light）',
    window.document.documentElement.style.colorScheme === 'light' && !window.document.body.hasAttribute('data-ds-dark-theme'),
    'colorScheme=' + window.document.documentElement.style.colorScheme);
  check('宿主给的背景图画上去了',
    window.document.body.dataset.bgMode === 'image'
    && window.document.documentElement.style.getPropertyValue('--bg-image').includes('bg.png'),
    'bgMode=' + window.document.body.dataset.bgMode + ' bg-image=' + window.document.documentElement.style.getPropertyValue('--bg-image').slice(0, 40));
  check('启动时向编辑器报过到（ready）', sent.some((m) => m.type === 'ready'));
  check('正文是从编辑器读来的（发过 read 请求）', sent.some((m) => m.type === 'call' && m.kind === 'read'));
}
/*
  图片地址解析：插件里最容易出错的地方，单独测一遍（不依赖编辑器，纯计算）。
  这一组的存在本身就是个提醒——它原来被困在 require('vscode') 的模块里，压根测不到。
*/
console.log('\n1) 图片地址解析');
{
  const doc = process.platform === 'win32' ? 'C:\\notes\\a.md' : '/notes/a.md';
  const dir = process.platform === 'win32' ? 'C:\\notes' : '/notes';
  const cases = [
    ['相对路径', paths.resolvePath(doc, 'img/a.png'), join(dir, 'img/a.png')],
    ['上一级目录', paths.resolvePath(doc, '../assets/a.png'), join(dirname(dir), 'assets', 'a.png')],
    ['那也去不掉的反斜杠（Windows 写法）', paths.toAppPath('C:\\notes\\a.md'), 'C:/notes/a.md'],
    ['file:// 地址', paths.resolvePath(doc, 'file://' + (process.platform === 'win32' ? '/C:/notes/a.png' : '/notes/a.png')),
      process.platform === 'win32' ? 'C:\\notes\\a.png' : '/notes/a.png'],
  ];
  for (const [name, got, want] of cases) check('解析：' + name, got === want, got === want ? undefined : '得到 ' + got + '，期望 ' + want);
  check('白名单：文档同目录算在内', paths.isInside('/notes', '/notes/a.png'));
  check('白名单：上一级算在内', paths.isInside('/notes', '/notes/assets/a.png'));
  check('白名单：隔壁目录不算', paths.isInside('/notes', '/other/a.png') === false);
  check('白名单：自己不算', paths.isInside('/notes', '/notes') === false);
}

/*
  扩展本体（编辑器那一侧）也要能加载。
  webview 那部分是普通前端，能在 jsdom 里跑；而 src/*.js 要 require('vscode')，
  编辑器之外加载不了——所以这里塞一个最小的假 vscode 进去，把"激活 → 打开一个文件"
  这条真实路径走一遍。语法错误、require 不到的东西、API 用错、返回值不合规，都会在这里现形。
*/
console.log('\n2) 扩展本体（编辑器那一侧）');
{
  const Module = require('node:module');
  // 用户"显式配过"的 VS Code 设置（其余的都不该被发给应用）
  const CONFIGURED = { scale: 110, width: 700, theme: 'light' };
  const listeners = [];
  const registered = { editors: [], commands: [] };
  class Disposable {
    constructor(fn) { this.fn = fn }
    dispose() { if (this.fn) this.fn() }
  }
  const fakeUri = (p) => ({
    fsPath: p,
    path: p.replace(/\\/g, '/'),
    toString: () => 'file://' + p,
  });
  const stub = {
    Disposable,
    Uri: { file: (p) => fakeUri(p), joinPath: (base, ...rest) => fakeUri([base.fsPath.replace(/\/$/, ''), ...rest].join('/')) },
    ViewColumn: { active: -1 },
    TabInputCustom: class { constructor(uri, viewType) { this.uri = uri; this.viewType = viewType } },
    TabInputText: class { constructor(uri) { this.uri = uri } },
    window: {
      activeTextEditor: undefined,
      tabGroups: { activeTabGroup: { activeTab: undefined } },
      registerCustomEditorProvider: (viewType, provider, options) => {
        registered.editors.push({ viewType, provider, options });
        return new Disposable();
      },
      registerWebviewPanelSerializer: () => new Disposable(),
    },
    workspace: {
      workspaceFolders: undefined,
      // 模拟用户显式配过的项：只有这些应该被发给应用（见 preview-provider 的 readSettings）
      getConfiguration: () => ({
        get: (key, fallback) => (CONFIGURED[key] === undefined ? fallback : CONFIGURED[key]),
        inspect: (key) => ({ globalValue: CONFIGURED[key] }),
      }),
      onDidChangeTextDocument: (fn) => { listeners.push(fn); return new Disposable() },
      onDidChangeConfiguration: (fn) => { listeners.push(fn); return new Disposable() },
    },
    commands: {
      registerCommand: (id) => { registered.commands.push(id); return new Disposable() },
      executeCommand: async () => undefined,
    },
  };
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'vscode') return stub;
    return originalLoad.apply(this, arguments);
  };
  let extension = null;
  try {
    extension = require(join(APP, 'build', 'vscode', 'pkg', 'src', 'extension.js'));
  } catch (error) {
    check('扩展本体能加载（语法 / 依赖）', false, String(error.message).slice(0, 120));
  }
  if (extension !== null) {
    check('扩展本体能加载（语法 / 依赖）', true);
    // 指向真正组装出来的插件包：这样"读 media/index.html"这条路径也顺便被验证了
    // 真实编辑器里 context 一定有 globalStorageUri（宿主存背景图用的就是它）
    const context = {
      subscriptions: [],
      extensionUri: fakeUri(join(APP, 'build', 'vscode', 'pkg')),
      globalStorageUri: fakeUri(join(APP, 'build', 'vscode', 'storage')),
    };
    try {
      extension.activate(context);
      check('activate() 不抛错', true);
    } catch (error) {
      check('activate() 不抛错', false, String(error.message).slice(0, 120));
    }
    check('注册了自定义编辑器', registered.editors.length === 1 && registered.editors[0].viewType === 'markdownObserver.preview',
      registered.editors.map === undefined ? undefined : String(registered.editors.length));
    check('注册了两个命令', registered.commands.includes('markdownObserver.togglePreview') && registered.commands.includes('markdownObserver.openPreview'),
      registered.commands.join(', '));
    const entry = registered.editors[0];
    if (entry !== undefined) {
      const document = { uri: { fsPath: '/notes/a.md', path: '/notes/a.md', toString: () => 'file:///notes/a.md' }, getText: () => '# 标题\n\n正文' };
      const posted = [];
      const panel = {
        webview: {
          options: {},
          html: '',
          cspSource: 'vscode-webview://test',
          asWebviewUri: (uri) => ({ toString: () => 'vscode-webview://test' + uri.fsPath }),
          postMessage: async (m) => { posted.push(m); return true },
          onDidReceiveMessage: () => new Disposable(),
        },
      };
      let result = null;
      try {
        result = entry.provider.resolveCustomTextEditor(document, panel);
      } catch (error) {
        check('resolveCustomTextEditor() 不抛错', false, String(error.message).slice(0, 140));
      }
      check('resolveCustomTextEditor() 不抛错', result !== null);
      // 这一条正是刚才"打不开"的原因：返回值必须是单个 Disposable，不能是数组
      check('返回值是 Disposable（不是数组）', result !== null && typeof result.dispose === 'function',
        Array.isArray(result) ? '返回了数组（VSCode 会断言失败）' : typeof result);
      const csp = typeof panel.webview.html === 'string'
        ? (panel.webview.html.match(/Content-Security-Policy" content="([^"]*)"/) || [])[1] || ''
        : '';
      check('webview 页面注入了启动数据与 CSP',
        typeof panel.webview.html === 'string' && panel.webview.html.includes('data-vscode-file=') && csp !== '');
      // 背景图做等比缩小时用的是 createObjectURL(file)（blob: 地址）；
      // img-src 少了 blob: 图就会被 CSP 挡掉，用户看到的是"这张图读不出来"。（这个坑踩过）
      check('CSP 放行了 blob:（背景图要能读）', csp.includes('blob:'), csp.slice(0, 80));
      check('CSP 放行了 data: 与 https:', csp.includes('data:') && csp.includes('https:'));
      check('资源白名单已设置', Array.isArray(panel.webview.options.localResourceRoots) && panel.webview.options.localResourceRoots.length >= 2);
      /*
        回归：焦点不在编辑器里时（典型的：刚在资源管理器里点了文件，光标还没进去），
        命令也要能找到"该管的那个文件"并开出阅读视图。
        以前只认 activeTextEditor + when 里的 editorLangId，这种情况下按快捷键毫无反应。
      */
      const invoked = [];
      const originalExecute = stub.commands.executeCommand;
      stub.commands.executeCommand = async (...args) => { invoked.push(args); return undefined };
      const originalActive = stub.window.activeTextEditor;
      stub.window.activeTextEditor = undefined;
      stub.window.tabGroups.activeTabGroup.activeTab = { input: new stub.TabInputText(document.uri) };
      await entry.provider.openPreview();
      stub.window.activeTextEditor = originalActive;
      stub.commands.executeCommand = originalExecute;
      check('焦点不在编辑器时，命令依然能找到文件并打开阅读视图',
        invoked.length === 1 && invoked[0][0] === 'vscode.openWith' && invoked[0][2] === 'markdownObserver.preview',
        JSON.stringify(invoked.map((args) => args.slice(0, 3))));
      /*
        回归：用户"什么都没配"时，宿主**一项设置都不该发**。
        发默认值会把应用自己存的设置按回默认——最典型的后果就是
        "面板里选的图片背景，下次打开没了"（这一条就是为那个 bug 写的）。
      */
      const saved = Object.assign({}, CONFIGURED);
      for (const key of Object.keys(CONFIGURED)) delete CONFIGURED[key];
      const blankPanel = {
        webview: {
          options: {}, html: '', cspSource: 'vscode-webview://test',
          asWebviewUri: (uri) => ({ toString: () => 'vscode-webview://test' + uri.fsPath }),
          postMessage: async () => true,
          onDidReceiveMessage: () => new Disposable(),
        },
      };
      entry.provider.resolveCustomTextEditor(document, blankPanel);
      const attr = /data-vscode-settings="([^"]*)"/.exec(blankPanel.webview.html);
      const boot = attr === null ? {} : JSON.parse(decodeURIComponent(attr[1]));
      check('用户没配设置时，宿主一项都不发（否则会顶掉应用自己的背景/排版）',
        boot.bgMode === undefined && boot.scale === undefined && boot.theme === undefined && boot.width === undefined,
        Object.keys(boot).join(', ') || '(空)');
      Object.assign(CONFIGURED, saved);
    }
  }
  Module._load = originalLoad;
}

/*
  应用行为：背景"最近使用"的排序。
  点过的背景（无论是内置渐变还是自定义图片）都应该提到最前面。
  这里只测预设那条路——因为它不需要 IndexedDB，而 bug 恰好就出在这条路上
  （applyRecent 的预设分支原来直接 return，忘了 rememberBackground）。
  判断顺序用的是 DOM 里那几个按钮的 title（预设名），不依赖 localStorage。
*/
console.log('\n3) 背景最近使用的排序（应用行为）');
{
  const pick = (selector) => Array.from(window.document.querySelectorAll(selector));
  const order = () => pick("#recents button").map((btn) => btn.title);
  // 色板里第一个是「无背景」（class 带 plain），它不进"最近使用"，所以排除掉
  const swatches = pick("#swatches button:not(.plain)");
  check("预设色板画出来了", swatches.length >= 2, String(swatches.length));
  if (swatches.length >= 2) {
    swatches[0].click();
    const first = order()[0];
    swatches[1].click();
    const second = order()[0];
    check("连点两个预设，最近使用会重新排序", first !== second && first !== undefined, first + " → " + second);
    const target = pick("#recents button").find((btn) => btn.title === first);
    check("刚点过的那个还在最近使用里", target !== undefined);
    if (target !== undefined) {
      target.click();
      check("点最近使用里的预设，它会提到最前", order()[0] === first, "现在第一是 " + order()[0] + "，期望 " + first);
    }
  }
}

const failed = checks.filter((c) => !c.ok);
console.log('\n' + (failed.length === 0 ? 'all checks passed' : failed.length + ' check(s) failed'));
process.exit(failed.length === 0 ? 0 : 1);
