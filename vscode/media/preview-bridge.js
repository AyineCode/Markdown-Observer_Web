/*
 * webview 侧的桥 —— 让"编辑器"成为应用本体的一个宿主。
 *
 * 应用本体的前端（js/app.js）从一开始就是按"宿主可插拔"写的：
 *   noneHost（双击单文件）/ folderHost（拖入文件夹）/ serverHost（本地服务）
 * 这里补上第四种：vscodeHost —— 宿主就是编辑器本身。
 * 好处是渲染管线、大纲、搜索、阅读位置、图片放大、代码复制**一行都不用重写**，
 * 也不会出现"插件和浏览器版样式不一样"这种漂移。
 *
 * 两个通道：
 *   请求/应答（call）：读正文、换图片地址、切回编辑
 *   推送（changed/settings）：编辑区改了内容、用户改了 VS Code 设置
 */
(function () {
  if (typeof acquireVsCodeApi !== 'function') return;   // 不是 webview（例如浏览器直接打开），什么都不做
  const api = acquireVsCodeApi();
  // 外壳标记：html 和 body 都打（样式里据此把滚动锁在 .stage 上，不依赖 :has()）
  document.documentElement.dataset.shell = 'vscode';
  document.body.dataset.shell = 'vscode';

  /** body 上那两个 data-* 是编辑器注入的（用 data 而不是脚本，免得放宽 CSP） */
  function readData(value, fallback) {
    if (value === undefined) return fallback;
    try { return JSON.parse(decodeURIComponent(value)) } catch { return fallback }
  }
  const filePath = readData(document.body.dataset.vscodeFile, null);
  const bootSettings = readData(document.body.dataset.vscodeSettings, {});

  let seq = 0;
  const waiting = new Map();     // 请求 id → {resolve, reject}
  let push = null;               // 应用本体注册的"宿主推来消息"回调
  let applySettings = null;      // 应用本体注册的"套用设置"回调
  const settings = Object.assign({}, bootSettings);

  function call(kind, payload) {
    return new Promise((resolve, reject) => {
      const id = ++seq;
      waiting.set(id, { resolve: resolve, reject: reject });
      api.postMessage({ type: 'call', id: id, kind: kind, payload: payload });
    });
  }

  function nextSettings(next) {
    Object.assign(settings, next);
    // 应用可能还没起来（boot 是异步的）：先攒着，它来取的时候一起给
    if (applySettings !== null) applySettings(next);
  }

  // 打印在 webview 里没有对应物：按钮已经藏了，顺手把 Ctrl+P 也吞掉，
  // 免得按下去弹出"没有反应"的打印对话框（而 Ctrl+P 在编辑器里本来是快速打开）
  window.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p') {
      event.preventDefault();
    }
  }, true);

  window.addEventListener('message', (event) => {
    const message = event.data;
    if (message === null || typeof message !== 'object') return;
    if (message.type === 'result') {
      const slot = waiting.get(message.id);
      if (slot === undefined) return;
      waiting.delete(message.id);
      if (message.ok) slot.resolve(message.data);
      else slot.reject(new Error(message.error === undefined ? '操作失败' : message.error));
      return;
    }
    if (message.type === 'settings') { nextSettings(message.settings); return }
    // 编辑区改了内容：应用本体走"换一篇"那条路（同一篇会就地重渲染，不会开两份）
    if (message.type === 'changed' && push !== null) push({ type: 'open', doc: { path: message.path } });
  });

  window.__VSCODE_HOST__ = {
    id: 'vscode',
    get rootName() { return null },        // 编辑器里不显示文件夹名（文件由资源管理器管）
    get hasTree() { return false },
    get treeNote() { return null },
    get settings() { return Object.assign({}, settings) },
    get workspaceRoot() { return null },
    watchSettings(callback) { applySettings = callback },
    count: 0,
    single: filePath,
    canPickFolder: false,                  // 选文件夹交给编辑器的资源管理器
    canDeepLink: false,                    // webview 没有地址栏，深链接无从谈起
    canNativeDialog: false,
    async list() { return [] },
    async read() { return await call('read', {}) },      // 正文来自编辑器里的文档对象
    async fixImages(imgs, docPath) {
      if (docPath === undefined) return;
      const wanted = [];
      for (const img of imgs) {
        const raw = img.getAttribute('src');
        if (raw === null || raw === '') continue;
        // 网络地址、内嵌数据：不用管
        if (/^(https?:|data:|blob:)/i.test(raw)) continue;
        // 已经换成 webview 地址的：别换第二次
        if (/^vscode-|^https:\/\/file\+/i.test(raw)) continue;
        // 其余（相对路径、以 / 或 C: 开头的绝对路径、file://）统统交给扩展那边解析——
        // 服务端模式会跳过绝对路径（那边有 /api/raw 兜底），插件里没有兜底，必须自己解析
        wanted.push(raw);
      }
      if (wanted.length === 0) return;
      let map = {};
      try { map = await call('images', { paths: wanted }) } catch { return }   // 取不到就保持原样
      for (const img of imgs) {
        const raw = img.getAttribute('src');
        if (raw !== null && map[raw] !== undefined) img.setAttribute('src', map[raw]);
      }
    },
    listen(onPush) { push = onPush; return true },
    /**
     * 把面板里选的那张背景图交给宿主存起来。
     * 编辑器里 webview 的 IndexedDB 不保证留得住，存到扩展那边下次打开才还在。
     */
    async saveBackgroundImage(dataUrl) {
      try { await call('storeBackground', { dataUrl: dataUrl }) } catch { /* 存不上就本次生效 */ }
    },
    heartbeat() {},
  };
  api.postMessage({ type: 'ready' });
})();
