/*
 * Markdown Observer 的 VS Code 插件 —— 激活入口。
 *
 * 这里刻意保持"薄"：干活的是 src/preview-provider.js（文档 ↔ webview 的桥）。
 * 为什么用 CommonJS 而不是仓库里那种 ESM：插件宿主对 CJS 的支持最广、最不会出意外
 * （ESM 插件要新一些的 VS Code 才支持）。插件里也没有需要和仓库共享的模块——
 * 渲染那一套是**复用应用本体**（webview 里跑的就是 index.html + js/app.js），不在这里复制。
 */
const vscode = require('vscode');
const { PreviewProvider } = require('./preview-provider');

/** @param {vscode.ExtensionContext} context */
function activate(context) {
  const provider = new PreviewProvider(context);
  context.subscriptions.push(
    vscode.window.registerCustomEditorProvider(PreviewProvider.viewType, provider, {
      // 切到别的标签页再切回来，不要重新渲染（阅读位置、图片都在）
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('markdownObserver.togglePreview', () => provider.toggle()),
    vscode.commands.registerCommand('markdownObserver.openPreview', () => provider.openPreview()),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
