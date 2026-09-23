/*
 * 阅读视图 = 一个"自定义编辑器"（custom editor）。
 *
 *   .md 文件（文本编辑器）  ←─ Alt+Shift+V ─→  我们这个 webview
 *
 * 为什么用自定义编辑器而不是"另开一个预览面板"：VS Code 原生的 Reopen With 机制
 * 就是为这件事准备的——切换、记住每个标签页、跟编辑器主题走、快捷键与标题栏按钮
 * 全都由编辑器负责，我们只描述"这个文件用哪种方式显示"。少写很多状态管理，也更稳。
 *
 * 这个类的职责只有"桥"：
 *   · 把仓库里那套前端（index.html + js/app.js + styles + vendor）装进 webview；
 *   · 文档内容、图片地址、设置，在编辑器与 webview 之间来回搬。
 * 渲染、排版、大纲、搜索这些**一行都没有重写**——webview 里跑的就是应用本体，
 * 它通过 window.__VSCODE_HOST__ 把编辑器当成一个宿主（见 media/preview-bridge.js）。
 */
const vscode = require('vscode');
const { existsSync, mkdirSync, readFileSync, writeFileSync } = require('node:fs');
const { join, dirname } = require('node:path');
const { isInside, resolvePath, toAppPath } = require('./paths');

const VIEW_TYPE = 'markdownObserver.preview';

/**
 * VSCode 设置 → 应用本体的设置（名字、单位都对齐应用里那份，见 js/app.js 的 DEFAULTS）。
 *
 * **只发用户显式配置过的项**，没配的一项都不发。为什么这点很关键：
 * 应用自己也有一套设置（字号、背景模式……存在 webview 的 localStorage 里），
 * 而"发默认值"等于每次打开都把它们按回默认——
 * 最典型的后果：面板里选的图片背景，下次打开时被 background 的默认值 none 顶掉，
 * 看起来就是"背景图没有持久化"。（这个坑踩过）
 *
 * 用 inspect() 区分"没配"和"配成了默认值"：三种作用域都没有值才算没配。
 */
function readSettings() {
  const config = vscode.workspace.getConfiguration('markdownObserver');
  const isSet = (key) => {
    const inspected = config.inspect(key);
    if (inspected === undefined) return false;
    return inspected.globalValue !== undefined
      || inspected.workspaceValue !== undefined
      || inspected.workspaceFolderValue !== undefined;
  };
  const out = {};
  if (isSet('theme')) out.theme = config.get('theme');
  if (isSet('serif')) out.serif = config.get('serif');
  if (isSet('scale')) out.scale = config.get('scale') / 100;       // 控件是百分比，应用里是倍数
  if (isSet('leading')) out.leading = config.get('leading') / 100;
  if (isSet('width')) out.width = config.get('width');
  if (isSet('wrapCode')) out.wrapCode = config.get('wrapCode');
  if (isSet('background')) out.bgMode = config.get('background');
  if (isSet('backgroundPreset')) out.bgPreset = config.get('backgroundPreset');
  // 注意：背景图**不在这里**——它的地址要按"当前这份文档"算（可能是相对路径），
  // 见 PreviewProvider 里的 backgroundUrl()
  return out;
}

/** 背景图设置里的路径 → webview 能读的地址；没设置或读不到就返回空串。 */
function backgroundUrl(webview, document, readable) {
  const raw = vscode.workspace.getConfiguration('markdownObserver').get('backgroundImage', '');
  if (typeof raw !== 'string' || raw.trim() === '') return '';
  const file = resolvePath(document.uri.fsPath, raw.trim());
  if (!readable(file)) {
    console.log('[Markdown Observer] 背景图不在可读范围：' + raw + ' → ' + file);
    return '';
  }
  try {
    return webview.asWebviewUri(vscode.Uri.file(file)).toString();
  } catch (error) {
    console.log('[Markdown Observer] 背景图地址转换失败：' + raw + '：' + error.message);
    return '';
  }
}

// 路径相关的纯计算都在 paths.js 里（那里能被自测直接加载）

class PreviewProvider {
  constructor(context) {
    this.context = context;
    this.mediaRoot = vscode.Uri.joinPath(context.extensionUri, 'media');
    this.template = null;   // 组装好的 index.html，读一次就够
    /*
      面板里选过的背景图存在这里（扩展自己的存储目录，跟着扩展走、跨窗口共享）。
      为什么不放在 webview 里：webview 的 IndexedDB 不保证跨会话留得住，
      用户会觉得"背景图怎么又没了"。undefined = 还没读过，null = 读过但没有。
    */
    this.storageFile = vscode.Uri.joinPath(context.globalStorageUri, 'background-image.txt');
    this.storedBackground = undefined;
  }

  /** 宿主存着的那张背景图（面板里选过的）；没有就是 null。读一次就缓存。 */
  readStoredBackground() {
    if (this.storedBackground !== undefined) return this.storedBackground;
    this.storedBackground = null;
    try {
      const file = this.storageFile.fsPath;
      if (existsSync(file)) {
        const text = readFileSync(file, 'utf8').trim();
        // 只认 dataURL：坏了的内容别塞进 webview
        if (text.startsWith('data:image/')) this.storedBackground = text;
      }
    } catch (error) {
      console.log('[Markdown Observer] 读取存下的背景图失败：' + error.message);
    }
    return this.storedBackground;
  }

  /**
   * 当前"该管的那个文件"的 URI。
   *
   * 先看 activeTextEditor（最常见），再退回到活动标签页：
   * 用户在资源管理器里点开文件时，编辑器是打开了，但焦点还在资源管理器上，
   * 这时 activeTextEditor 未必是那个文件——光靠它会"按了没反应"。
   */
  activeUri() {
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) return editor.document.uri;
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab === undefined ? undefined : tab.input;
    if (input instanceof vscode.TabInputText) return input.uri;
    if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) return input.uri;
    return undefined;
  }

  /** 打开（或切到）当前文件对应的阅读视图。 */
  async openPreview() {
    const uri = this.activeUri();
    if (uri === undefined) return;
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE, vscode.ViewColumn.active);
  }

  /**
   * 编辑 ↔ 阅读 一键切换。
   * 判断"现在是不是我们自己在显示"用的是标签页的 input 类型——这是官方推荐的做法，
   * 比记住"我开过哪些文件"可靠得多（用户可能用 Reopen With 手动切过）。
   */
  async toggle() {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const input = tab === undefined ? undefined : tab.input;
    if (input instanceof vscode.TabInputCustom && input.viewType === VIEW_TYPE) {
      await vscode.commands.executeCommand('vscode.openWith', input.uri, 'default', vscode.ViewColumn.active);
      return;
    }
    const editor = vscode.window.activeTextEditor;
    if (editor !== undefined) await this.openPreview();
  }

  /** 组装 webview 的页面：就是应用本体那份 index.html，只把资源路径换成 webview 能读的形式。 */
  render(webview, docPath, settings) {
    if (this.template === null) this.template = readFileSync(join(this.mediaRoot.fsPath, 'index.html'), 'utf8');
    const uri = (rel) => webview.asWebviewUri(vscode.Uri.joinPath(this.mediaRoot, rel)).toString();
    let html = this.template
      .replace(/(href|src)="((?:styles|js|vendor)\/[^"]+)"/g, (whole, attr, rel) => attr + '="' + uri(rel) + '"')
      .replace('</head>', '  <meta http-equiv="Content-Security-Policy" content="'
        + "default-src 'none'; "
        // blob: 不能少：应用给背景图做等比缩小时用的是 createObjectURL(file)，
        // 少了它图会被 CSP 挡掉，用户看到的是"这张图读不出来"（这个坑踩过）
        + 'img-src ' + webview.cspSource + ' data: blob: https:; '
        + 'style-src ' + webview.cspSource + " 'unsafe-inline'; "
        + 'font-src ' + webview.cspSource + '; '
        + 'script-src ' + webview.cspSource + '; '
        + 'connect-src ' + webview.cspSource + ';">\n</head>');
    // 启动数据用 body 的 data-* 传（不是脚本，不受 CSP 限制；桥在 preview-bridge.js 里读）
    // 两个都用"先 JSON 再 URI 编码"：桥那边统一 JSON.parse(decodeURIComponent(...))，纯字符串也走同一条路
    // 启动数据走 body 的 data-*（不是脚本，不受 CSP 限制）。
    // 注意把 bgImageData 摘掉：那是几百 KB 的 dataURL，塞进 HTML 属性又大又难看，
    // 改成页面起来之后用消息发过去（见 settingsWithBackground）。
    const bootSettings = Object.assign({}, settings);
    delete bootSettings.bgImageData;
    const boot = ' data-vscode-file="' + encodeURIComponent(JSON.stringify(docPath)) + '"'
      + ' data-vscode-settings="' + encodeURIComponent(JSON.stringify(bootSettings)) + '"';
    return html.replace(/<body(\s|>)/, '<body' + boot + '$1');
  }

  resolveCustomTextEditor(document, panel) {
    const docPath = toAppPath(document.uri.fsPath);
    const settings = readSettings();
    /*
      资源白名单：扩展自己的 media/、文档所在目录、以及所有工作区目录。
      （webview 读不了白名单之外的本地文件——所以工作区外的图片显示不出来，和内置预览是同样的限制。）
    */
    const docDir = dirname(document.uri.fsPath);
    // 白名单放宽到"文档所在目录 + 上一级"：`![](../assets/x.png)` 这种写法很常见
    const roots = [this.mediaRoot, vscode.Uri.file(docDir), vscode.Uri.file(dirname(docDir))];
    for (const folder of vscode.workspace.workspaceFolders || []) roots.push(folder.uri);
    panel.webview.options = { enableScripts: true, localResourceRoots: roots };

    /** 白名单里能不能取到这个文件 */
    const readable = (file) => roots.some((root) => isInside(root.fsPath, file));

    /*
      设置里带上"这份文档的背景图"（相对路径按文档所在目录解析）。
      注意它必须定义在 readable 之后——它是箭头函数，但**调用**发生在下面那行，
      顺序写反就是 TDZ 报错，用户看到的是"这个编辑器打不开"。（这个坑踩过）
    */
    const settingsWithBackground = () => {
      const next = readSettings();
      const url = backgroundUrl(panel.webview, document, readable);
      if (url !== '') next.bgImageUrl = url;              // VS Code 设置里指定的图（优先）
      const stored = this.readStoredBackground();
      if (stored !== null) next.bgImageData = stored;      // 面板里选过的那张（用不用由应用决定）
      return next;
    };

    panel.webview.html = this.render(panel.webview, docPath, settingsWithBackground());

    const post = (message) => { void panel.webview.postMessage(message) };

    let timer = null;
    const subscriptions = [
      // 编辑区改了内容：安静 150ms 再通知 webview，别每敲一个键都重渲染
      vscode.workspace.onDidChangeTextDocument((event) => {
        if (event.document.uri.toString() !== document.uri.toString()) return;
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => post({ type: 'changed', path: docPath }), 150);
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration('markdownObserver')) post({ type: 'settings', settings: settingsWithBackground() });
      }),
      panel.webview.onDidReceiveMessage(async (message) => {
        if (message === null || typeof message !== 'object') return;
        if (message.type === 'ready') { post({ type: 'settings', settings: settingsWithBackground() }); return }
        if (message.type !== 'call') return;
        try {
          const data = await this.handleCall(message, { document: document, webview: panel.webview, readable: readable });
          post({ type: 'result', id: message.id, ok: true, data: data });
        } catch (error) {
          post({ type: 'result', id: message.id, ok: false, error: String(error && error.message ? error.message : error) });
        }
      }),
    ];
    /*
      注意：这个函数的返回值必须是**一个 Disposable**，不能是数组。
      返回数组时 VSCode 会抛 "Assertion Failed: Argument is undefined or null"，
      用户看到的就是"这个编辑器打不开"。（这个坑踩过）
      把几条监听合成一个：编辑器关掉时统一释放，不留悬挂的监听。
    */
    return new vscode.Disposable(() => { for (const item of subscriptions) item.dispose() });
  }

  /** webview 发来的请求（读正文 / 换图片地址 / 切回编辑）。 */
  async handleCall(message, context) {
    const payload = message.payload === undefined ? {} : message.payload;
    if (message.kind === 'read') {
      // 正文直接取自编辑器里的文档对象：编辑区里没保存的改动也能立刻读到
      const name = context.document.uri.path.split('/').pop();
      return { text: context.document.getText(), name: name, size: Buffer.byteLength(context.document.getText(), 'utf8') };
    }
    if (message.kind === 'images') {
      const out = {};
      for (const raw of payload.paths || []) {
        if (typeof raw !== 'string' || raw === '') continue;
        const file = resolvePath(context.document.uri.fsPath, raw);
        if (!context.readable(file)) {
          // 白名单外（工作区之外的图片）：webview 本来就读不到，说清楚免得以为是 bug
          console.log('[Markdown Observer] 图片不在可读范围，保持原样：' + raw + ' → ' + file);
          continue;
        }
        try {
          out[raw] = context.webview.asWebviewUri(vscode.Uri.file(file)).toString();
        } catch (error) {
          console.log('[Markdown Observer] 图片地址转换失败：' + raw + ' → ' + file + '：' + error.message);
        }
      }
      return out;
    }
    if (message.kind === 'toggle') { await this.toggle(); return null }
    if (message.kind === 'storeBackground') {
      const dataUrl = typeof payload.dataUrl === 'string' ? payload.dataUrl : '';
      const file = this.storageFile.fsPath;
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, dataUrl, 'utf8');
      this.storedBackground = dataUrl === '' ? null : dataUrl;
      console.log('[Markdown Observer] 背景图已存到扩展存储（' + Math.round(dataUrl.length / 1024) + ' KB）');
      return null;
    }
    throw new Error('不认识的请求：' + message.kind);
  }
}

PreviewProvider.viewType = VIEW_TYPE;
module.exports = { PreviewProvider, VIEW_TYPE };
