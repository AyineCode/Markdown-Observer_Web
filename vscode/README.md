# VS Code 插件（Markdown Observer）

同一个渲染器，搬进编辑器。这份文档只讲**怎么开发、怎么打包、怎么测**；给用户看的那份由构建脚本生成。

## 形态：一个"自定义编辑器"

- 注册了 `Markdown Observer 阅读视图`，**不做默认编辑器**：双击 `.md` 仍进普通文本编辑器。
- 按 `Alt+Shift+V`（macOS `Cmd+Shift+V`）在**阅读视图 ↔ 文本编辑**之间来回切；
  也可以点编辑器右上角的"眼睛"图标，或在命令面板里搜 "Markdown Observer"。
- 想让阅读视图当默认：在 `settings.json` 里写
  `"workbench.editorAssociations": { "*.md": "markdownObserver.preview" }`。

## 关键设计：不复制应用本体

webview 里跑的就是仓库根目录那套前端（`index.html` + `js/app.js` + `styles/` + `vendor/`），
插件只多一个 `media/preview-bridge.js`——它把编辑器包装成 `app.js` 认得的**第四个宿主**
（前三个是 `noneHost` / `folderHost` / `serverHost`，见 `js/app.js` 里的 host 接口）。

所以排版、大纲、搜索、阅读位置、图片放大、代码复制**在这里一行都没有重写**；
以后改样式或加功能，插件重打包一次就同步了——"插件和浏览器版长得不一样"这种漂移不会发生。

应用本体为此只多了两处插座（都在 `js/app.js`，各几行）：`useHost` 里套用宿主设置、`boot` 里认这个宿主。

## 目录

    vscode/
    ├── package.json              清单：自定义编辑器、命令、快捷键、设置项（version 由构建注入）
    ├── src/extension.js          激活（薄）：注册自定义编辑器与两个命令
    ├── src/preview-provider.js   桥：装 webview、搬文档/图片/设置
    └── media/preview-bridge.js   webview 侧：把编辑器包装成宿主

    tools/vscode/
    ├── build.mjs                 组装（加 --package 再打 .vsix）
    └── smoke.mjs                 在 jsdom 里把 webview 整个跑一遍

## 常用命令

    node tools/vscode/build.mjs             # 组装到 build/vscode/pkg/
    node tools/vscode/smoke.mjs             # 自测（先组装一次）
    node tools/vscode/build.mjs --package   # 打出 build/vscode/markdown-observer-v<版本>.vsix


## 换快捷键

默认绑 `Alt+Shift+V`（macOS `Cmd+Shift+V`），命令名是 `markdownObserver.togglePreview`。
如果和你机器上别的软件（输入法、截图工具、其它插件）撞了，有两种改法：

**界面改**：`Ctrl+K` `Ctrl+S` 打开键盘快捷方式 → 搜 `Markdown Observer` → 双击那一行 → 直接按下你想用的组合 → 回车。

**写进配置文件**（命令面板 → `Preferences: Open Keyboard Shortcuts (JSON)`）：

**改键：只写这一条就够了**（下面把键换成你想要的）：

```json
{ "key": "ctrl+shift+alt+v", "command": "markdownObserver.togglePreview",
  "when": "editorLangId == markdown || activeCustomEditorId == markdownObserver.preview" }
```

**可选**：如果你想让插件自带的 `Alt+Shift+V` 彻底失效（不这样的话新旧两个键都会生效），
再加一条"解绑"——注意 command 前面那个 `-` 是 VS Code 表示"移除键位"的写法，
**它不是第二个按键**：

```json
{ "key": "alt+shift+v", "command": "-markdownObserver.togglePreview" }
```

第二行那种带 `-` 的写法是"解绑默认那条"——不想保留默认键位就加上它。

**找空键位的办法**：键盘快捷方式页右上角有个「记录按键」（Record Keys），按一下你想要的组合，
它会列出当前占用该组合的**所有**命令——冲突在哪一目了然，不用猜。

> 默认为什么选 `Alt+Shift+V`：`Ctrl+Alt+字母` 这一整类在中文 Windows 上经常被输入法或
> 截图工具抢走（`Ctrl+Alt+V` 就是这么丢的），而 `Alt+Shift+字母` 在 VS Code 默认里只占了 A / F / O / I。
> 但这只是"概率上更安全"，最终还得看你机器上装了什么。

## 在编辑器里试（这一步只能在有界面的机器上做）

1. 先组装：`node tools/vscode/build.mjs`
2. 用 VS Code 打开**仓库根目录**，按 **F5** → 会开一个"扩展开发宿主"窗口
   （用的是 `.vscode/launch.json` 里那个配置，指向 `build/vscode/pkg`）
3. 在那个窗口里打开任意 `.md`，按 `Alt+Shift+V`

装给别人用：`code --install-extension build/vscode/markdown-observer-v<版本>.vsix`，
或在 VS Code 里「扩展 → … → 从 VSIX 安装」。

## 改完代码怎么生效

改 `src/` 或 `media/preview-bridge.js`：重新组装 + 在开发宿主窗口里 `Ctrl+R` 重载。
改应用本体（`js/`、`styles/`）：同样重新组装（插件包里是它的副本）。
