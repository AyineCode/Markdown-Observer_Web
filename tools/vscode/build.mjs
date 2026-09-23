/*
  把 VS Code 插件组装出来（可选再打包成 .vsix）。

  关键决定：插件**不复制**应用本体的渲染代码，而是把它整个装进插件的 media/ 里
  （index.html + js/ + styles/ + vendor/），再塞一个 preview-bridge.js 把编辑器包装成宿主。
  webview 里跑的就是浏览器版那一套 —— 所以"插件和浏览器版长得不一样"这类漂移不可能发生，
  以后改排版、加功能，插件重打包一次就同步了（和单文件 HTML 是同一个思路）。

  用法：
    node tools/vscode/build.mjs            # 只组装到 build/vscode/pkg/（快，改代码时用这个）
    node tools/vscode/build.mjs --package  # 再跑 vsce 打出 .vsix（需要 npx @vscode/vsce）
*/
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { readVersion, versionTag } from '../version.mjs'

// 本文件在 tools/vscode/ 下，往上三层才是仓库根
const APP = dirname(dirname(dirname(fileURLToPath(import.meta.url))))
const SRC = join(APP, 'vscode')
const OUT = join(APP, 'build', 'vscode')
const PKG = join(OUT, 'pkg')

const version = readVersion()
rmSync(PKG, { recursive: true, force: true })
mkdirSync(PKG, { recursive: true })

/** 把仓库里的一项放进插件包里（保持相对路径，插件的相对引用才不用改）。 */
function ship(rel, to = rel) {
  const from = join(APP, rel)
  const target = join(PKG, to)
  if (!existsSync(from)) { console.error('  ✗ 少了 ' + rel); process.exit(1) }
  mkdirSync(dirname(target), { recursive: true })
  cpSync(from, target, { recursive: true })
}
// ① 插件自己的代码
ship('vscode/src', 'src')
// ② 应用本体（webview 里跑的就是它）——全部装进 media/ 下，保持仓库里的相对关系，
//    这样 index.html 里的 styles/… js/… vendor/… 相对路径原样有效
ship('js', 'media/js')
ship('styles', 'media/styles')
ship('vendor', 'media/vendor')
// 桥也放进 media/js/：index.html 里用 js/preview-bridge.js 引它，正好落在改写规则内
ship('vscode/media/preview-bridge.js', 'media/js/preview-bridge.js')
// ③ index.html：多引一个精简外壳的样式 + 一个桥（其余一字不改）
const html = readFileSync(join(APP, 'index.html'), 'utf8')
  .replace('<link rel="stylesheet" href="styles/tuning.css">',
           '<link rel="stylesheet" href="styles/tuning.css">\n<link rel="stylesheet" href="styles/vscode.css">')
  .replace('<script src="js/app.js"></script>',
           '<script src="js/preview-bridge.js"></script>\n<script src="js/app.js"></script>')
writeFileSync(join(PKG, 'media', 'index.html'), html, 'utf8')
// ④ 清单：版本号在这里注入（仓库里那份写的是 0.0.0，免得出现第二个"版本来源"）
const manifest = JSON.parse(readFileSync(join(SRC, 'package.json'), 'utf8'))
manifest.version = version
writeFileSync(join(PKG, 'package.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8')
// ⑤ 商店需要一个 README；.vscodeignore 让 vsce 别把该带的漏掉
writeFileSync(join(PKG, 'README.md'), `# Markdown Observer

在编辑器里安安静静地读 markdown：排版跟随 DeepSeek Harness 的那一套。

- 打开一个 \`.md\`，按 \`Alt+Shift+V\`（macOS 上是 \`Cmd+Shift+V\`）在**编辑**与**阅读视图**之间来回切；
  也可以点编辑器右上角那个"眼睛"图标，或者在命令面板里搜 "Markdown Observer"。
- 阅读视图里：字号、行距、栏宽、背景、深浅色都在 **设置 → Markdown Observer** 里（也可以直接在 \`settings.json\` 里写）。
- 本页目录、\`/\` 搜索、图片点击放大、代码块一键复制，都在阅读视图里。

就是这个仓库的编辑器版本：同一个渲染器，同一个外观。

## 换快捷键

默认 Alt+Shift+V（macOS 是 Cmd+Shift+V），命令名 markdownObserver.togglePreview。
想换：在 VS Code 里按 Ctrl+K Ctrl+S 打开键盘快捷方式，搜 "Markdown Observer"，
双击那一行直接按下新组合；改键只写一条就够：{ "key": "你的组合", "command": "markdownObserver.togglePreview" }。
想让自带的 Alt+Shift+V 彻底失效，再加一条解绑（command 前的减号是 VS Code 表示"移除键位"的写法，
不是第二个按键）：{ "key": "alt+shift+v", "command": "-markdownObserver.togglePreview" }。
那一页右上角的「记录按键」能告诉你某个组合当前被谁占着。
` + '\n', 'utf8')
writeFileSync(join(PKG, '.vscodeignore'), '# 组装出来的包按原样发布，这里只挡掉没必要带的东西\n', 'utf8')

console.log('  已组装：' + PKG)
console.log('  media/ = index.html + js/ + styles/ + vendor/ + preview-bridge.js（应用本体原样搬进来）')
console.log('  版本：' + versionTag())

if (process.argv.includes('--package')) {
  const vsix = join(OUT, 'markdown-observer-' + versionTag() + '.vsix')
  // 用本地装好的 vsce（npm i -D @vscode/vsce），别让 npx 去网上下载
  execFileSync('npx', ['--no-install', 'vsce', 'package', '--out', vsix, '--allow-missing-repository'], {
    cwd: PKG,
    stdio: 'inherit',
  })
  console.log('  → ' + vsix)
}
