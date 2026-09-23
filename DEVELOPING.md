# Markdown Observer · 开发与维护

这份文档写给**要改它、验证它**的人。只想读文档的话看 [README.md](README.md)。

---

## 命名：产品叫 Markdown Observer

产品名、页面标题、构建产物、发布包都统一成 **Markdown Observer**（仓库同名）。两处**故意不动**：

- **目录名还是 `md-reader/`**——它只是个路径，改它要动所有脚本里的相对路径和每个人的习惯，收益为零；
- **存储键还是 `md-reader:settings:v4` 和 IndexedDB 里的 `md-reader`**——改键等于把所有人的设置、背景图、阅读位置全部丢掉。

改名的只有"看得见的名字"：`index.html` 的标题与品牌、`serve.mjs` 的启动横幅、启动脚本里的提示、`sample.md` 的标题、构建产物 `markdown-observer.html`、发布包 `markdown-observer-v<版本>.zip`。

## 与 dsh 的保真度

**逐条搬运，并有机械校验**：`styles/markdown.css` 覆盖了 dsh 两个源样式表的**全部 137 条声明**（`MarkdownText.module.css` + `CodeBlock.module.css`），连注释里写的"为什么"都保留；五张 token 表是整份复制的；语法高亮用 dsh 自己的 `--shiki-*` 调色板。`node tools/check-styles.mjs` 每次校验，缺一条就报错。

保真的细节包括：代码块 `margin: 16px 0` 但非末位时 `margin-bottom: 11px`、`hr` 用 1px 背景而不是 border、引用块只有左边 2px 竖线且没有下边距、表格单元格 `max-width: min(30vw, 320px)`、`h4~h6` 后接列表时收紧到 8px、行内代码 `display: inline-flex` + `font-size: 0.875em`、脚注只做编号不做跳转链接。

**有意的差异**（都是为了"读自己的文档"这个用途）：

| 差异 | dsh 的做法 | 这里的做法 | 为什么 |
|---|---|---|---|
| 原始 HTML | 一律当纯文本转义 | DOMPurify 消毒后渲染 | 你读的是自己的文档，`<details>`、`<img width>` 该能用；脚本与事件属性会被挡掉 |
| 图片 | 只允许绝对 http(s) | 都显示、可点开放大 | 服务模式与文件夹模式会把相对路径接上（前者走 `/api/raw`，后者用浏览器给的句柄） |
| 标题锚点 | 没有 | 自动加可读 id | 目录、文内跳转、深链接都要用 |
| 文件提及按钮 | 有 | 没有 | 那是聊天里的功能，阅读器没有宿主上下文 |
| 公式 | KaTeX 0.16.47 | KaTeX 0.18.7 | 同一族库的更新版本，排版一致 |
| 代码高亮 | shiki（TextMate 语法） | highlight.js + dsh 的调色板 | shiki 要 WASM 与大量语法文件，不适合 `file://` 零构建；配色与代码块外壳一致 |

## 按钮与玻璃：两条设计约束

对着 dsh 自己的做法抄（`ui-sidebar/src/client/SidebarRoot.module.css` 与 `ui-workspace/.../WorkspaceBrowser.module.css` 的 `.iconButton`：28×28、`border: none`、`border-radius: 50%`、`background: transparent`，只有 hover 才浮出一层 `--dsw-alias-interactive-bg-hover`）。dsh 的取向很清楚：**能用位置和指针暗示的，就不画边框**。于是按钮按"重量"分四档：

| 档 | 谁 | 长什么样 |
|---|---|---|
| **0 · 什么都不画** | 顶栏的搜索 / 打印、侧栏的收起与打开文件夹、搜索条上的上一个 / 下一个 / 关闭、侧栏收起后那个"拉出小圆" | 只有图标；hover 时浮出一层很淡的实色（浅色 6% 墨、深色 8% 白）。**故意不用磨砂**：那只是一次"手在上面"的反馈，磨砂既看不出来，还白白多一个 `backdrop-filter`。 |
| **1 · 一块薄玻璃** | 侧栏「打开文件」、「看一篇示例」、「回到原处」、「恢复默认」、空状态三张卡、代码块复制按钮、色板与最近格子、左下角「设置」座位 | **不加底色、不描边**（0%）：背景色原样透过来，轮廓全靠**磨砂 + 凸感**。设置座位例外：它有两档专属底色（`--seat-glass-alpha`），因为它是全局入口，要比普通按钮显眼。 |
| **2 · 底板 + 小玻璃片** | 主题三态、设置面板的两个页签 | 一整条长玻璃底板 + 只有选中那一格盖一小块玻璃。 |
| **3 · 有色玻璃** | 主操作（`.btn.primary`） | 主题色的半透明底 + 白字。 |

**约束一：磨砂感来自 `backdrop-filter`，底色只决定"这片玻璃比周围亮还是暗"，而它必须跟着主题换方向。** 如果两个主题共用一个"深色低透明"的底色，深色主题下就成了实心黑按钮，浅色主题下按钮又会消失——两种"看着不对"其实是同一个原因。

| | 静止（第 1 档） | 悬停 | 选中的那一小片（第 2 档） |
|---|---|---|---|
| 浅色主题 | 完全透明：`rgba(38 49 72 / 0)` | 淡墨 `rgba(38 49 72 / 0.06)` | 白 `rgba(255 255 255 / 0.75)` |
| 深色主题 | 完全透明：`rgba(255 255 255 / 0)` | 淡光 `rgba(255 255 255 / 0.06)` | `rgba(255 255 255 / 0.24)` + 更亮的描边 |

**约束二：没有底色时，"凸感"由三样东西给出来**（`--btn-glass-rim` / `--btn-glass-lift`）：按钮**内顶**一道高光、**内下缘**一道暗线、外面一层投影。浅色主题的面板接近纯白，白高光叠上去等于没有，所以浅色主要靠内下缘那道 `rgba(15,23,42,0.12)` 的暗线 + 投影。像素实测（`tools/pixels.mjs`）：浅色下内下缘比按钮本身暗 **30**、投影比面板暗 **5**；深色下内顶高光比按钮亮 **11**、内下缘暗 **8**。

**切换型按钮**用的是「一整块玻璃底板 + 一小块玻璃片」：底板是那条长玻璃（`--seg-track-alpha`，10%，看得见边界）；**未选中的格子什么都不画**（按钮直接消失，只在悬停时浮出一点点）；**只有选中的那一格盖上一小块玻璃**。

第 1、2 档的模糊是**下限**（默认 14px，`--btn-glass-blur`）：低于 8px 玻璃感会消失、字也容易糊。浏览器不支持 `backdrop-filter` 时，这几档退回 dsh 原本那种"实心但干净"的底色，可读性优先；第 0 档本来就是透明的，不受影响。所有数值（含深色主题那几个）都在 `styles/tuning.css`，出厂值在 `styles/reader.css`——**删掉 tuning.css 里的一行就回到出厂值**。

## 八个踩过的坑（都写成了注释 + 断言）

**1. 通用类名会撞车。** 「最近使用」里的空格子原本叫 `.recent.empty`，而 `.empty` 是**空状态那个大面板**的类名（上面挂着 `max-width: 760px`、`margin: 5vh auto 0`、`padding: 46px 44px 34px`、`border-radius: 24px`）。于是占位格子被撑开、又被 5vh 的外边距顶到下一行——看上去就是"背景和占位边框不在同一行"。现在叫 `.recent.slot`（见 `styles/controls.css`），smoke 里加了 `slot.matches('.empty') === false` 这条断言防复发。**教训：面板级的类名要够特别，别用 `.empty`、`.box` 这种。**

**2. 事件派发后再重建 DOM，会让"点在面板里"变成"点在面板外"。** 换背景会重画色板和「最近使用」，被点的那颗按钮当场脱离文档；文档级那个"点外面就关面板"的处理函数随后跑到，`pop.contains(event.target)` 对已脱离的节点返回 false → 面板被误关。现在用 `event.composedPath()`（路径在派发时就固定）加 `event.target.isConnected === false` 兜底判断，面板不会再自己关上。**教训：判定"点在不在某个容器里"，别只信 `contains()` 加当前的 `event.target`。**

**3. 界面别排在持久化后面。** 设一张图片当背景时，原本的顺序是"记住 → 应用 → 写 IndexedDB"，而"最近使用"的缩略图是从 IndexedDB 里读的——那一刻图还没写进去，于是缩略图空着，要等下次重画才出现（用户看到的"切换后才好"）。中间试过"先写库再应用"，更糟：IndexedDB 慢或不可用（无头环境里就直接挂住）时，背景根本铺不上。正确的分工是——**缩略图对"当前这张图"直接用内存里的 `bgImage`，背景立刻生效，落库放到最后并且不等它**。`tools/measure.html` 现在会真拖一张图进来验这一条。**教训：能立刻画出来的东西，不要让它绕一趟存储。**

**4. 用正则改别人的压缩 CSS，边界字符必须写全。** 打包单文件版时要把 KaTeX 的字体换成 data URL，原来的写法是 `/src:\s*([^;]+);/g`——它要求 `src` 列表后面有个分号。可 KaTeX 的 `src` 是整条 `@font-face` 的**最后一项、没有分号**，于是匹配一路吃进了右花括号和下一条规则的 `@font-face{font-display:block;`：**20 条字体规则塌成 2 条**。症状很迷惑——**开发页公式完全正常，只有打包出来的那个文件里公式用回退字体、排版不对**（实测：开发页行内公式 46×22、字体 `check=true`；坏掉的打包版 42×21、四个 KaTeX 字体全是 `check=false / A network error`）。修法是让列表停在分号**或右花括号**上（`[^;}]+`，分号本身可选），并且在构建时就断言"@font-face 条数不能变、不能残留 url(fonts/…)"，smoke 的单文件模式里也加了同样的检查。**教训：改写别人生成的 CSS 时，先看清每条规则的结尾长什么样；再用一个"结构没变"的断言把它钉住。**

**5. 给浏览器原生控件设 `width: 100%` 时，别忘了 UA 自带的外边距。** 滑杆（`input[type=range]`）在 Chrome 的 UA 样式里有 `margin: 2px`（给滑块腾地方）。写了 `width: 100%` 之后这两侧各 2px 就成了实打实的溢出：面板内容盒 290px、滑杆占 294px，于是那个窄面板里冒出一条横向滚动条（用户看到的就是"不知道为什么左右也能滚"）。修法是 `margin: 0`——滑块本来就画在输入框内部，不需要这两边。面板里另外两处也一并收拾了：`overflow-x: hidden` 兜底、去掉 `scrollbar-gutter: stable`（它常驻占掉约 10px，同样会把内容挤出去）。**教训：窄容器里的横向滚动条，基本都是某个子元素比容器宽几个像素——去找它，别用 `overflow: hidden` 糊过去。**

**6. `void someAsyncFn()` 会把整条链路的异常吞掉。** 「打开文件夹」曾经是 `void openDirectory()`：用户点完、选完文件夹，只要后面任何一步抛错（权限、坏条目、遍历中途被删），就成了一个没人处理的 Promise 拒绝——**页面上一点动静都没有**，用户报的是「没反应」，而这句话几乎无法定位。现在整段 `try/catch` 兜住并把错误名说出来（`NotAllowedError` 这种就是权限），遍历的每一层也各自兜住并计数（一层读不动只跳过那一层，最后提示「有 N 处读不到，已跳过」），另外大目录会先弹一句「正在读…」、文件数封顶 3000。`tools/folder-probe.html` 能把这四种情况都跑一遍：`?case=normal|partial|denied|nopicker`。**教训：`void` 一个异步函数之前，先给它一个「一定会说话」的失败路径。**

**7. `showDirectoryPicker()` 在 `file://` 页面上会卡住。** 「打开文件夹」原本用的是 File System Access：`typeof window.showDirectoryPicker === 'function'`（`file://` 下确实存在）、`isSecureContext === true`、页面也没有任何报错——可用户选完文件夹之后**连第一句提示都没出现**。原因是这个 promise 在 `file://` 源上不落地：系统对话框弹得出来、用户也能选，但 `await` 之后那行代码永远不执行，整条链路静默卡死。（把 `showDirectoryPicker` 换成假句柄时一切正常，正是这一点把嫌疑指向真实 API，而不是我们自己的代码。）现在改用 `<input type="file" webkitdirectory multiple>`：浏览器直接把整个目录（含子目录）的文件交给页面，Chrome / Edge / Firefox / Safari 都支持，`file://` 也照常，而且拿到的是 File 对象，读正文与图片都更直接。**教训：能在 `file://` 下用的能力，才是「双击就能用」的本机工具能用的能力；用系统对话框类 API 之前，先在最苛刻的那种打开方式里验一遍。**

**8. 没被接住的链接会把整页导航走，然后"设置就失效了"。** 文档里写 `[README](README.md)` 这种**相对 .md 链接**时，链接处理只认 `http(s)` 和 `#` 两种，于是浏览器自己去请求那个 `.md`——用户看到的是"点一下下载了一个文件"。真正的麻烦在后面：**页面被导航走了**，而服务端判断"还有没有人在看"靠的就是那条 SSE 长连接，于是它从此认为没人在看，之后每次打开都开新标签页（复用得有个页面可复用），用户报的是**"设置里怎么调都没用"**——听起来像设置坏了，其实设置根本没参与决策。定位靠的是启动器日志里那行 `"listeners":0` 的突变。现在 `.md` 链接一律接住、在阅读器里就地打开（相对路径按当前文档所在目录解析），smoke 里加了"点它 → 文档就地切换 + 地址栏跟着走"这条断言。**教训：凡是"服务端靠连接数判断状态"的设计，都要问一句"这个页面有没有可能被导航走"；以及，用户报的现象和真正的原因可以隔得很远，先看日志里哪个数字变了。**

## 设置为什么放在那里

原则是**让控件出现在它所属的地方**，而不是全都塞进一个面板：

| 控件 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| **设置入口** | 顶栏的一个齿轮图标（和搜索/打印混在一起） | **左下角一个带文字的「设置」座位**（固定定位，侧栏收起后依然在） | 它是**全局**设置，不是某一篇文档的设置，不该和文档工具挤在顶栏；放在左下角既显眼，又和 dsh 把设置钉在侧栏底部是同一个取向。固定定位是关键：侧栏收起后入口必须还在，而侧栏本身带 `backdrop-filter`（会成为 fixed 子元素的包含块），所以它不能放在侧栏里面 |
| 收起 / 展开侧栏 | 在设置面板里 | **侧栏自己头上有收起按钮**；收起后舞台左上角出现小圆拉出按钮；设置里彻底删掉 | 它是界面部件，不是偏好——不该出现在设置里 |
| 打开文件 | 顶栏图标 + 空状态按钮 | **侧栏「文档」页顶部**，顶栏不再重复 | 与 dsh 一致：文件相关操作归侧栏；顶栏只放全局动作 |
| 设置面板 | 一长条，混着外观、排版、背景 | **两页切换**：排版 / 背景（主题只在顶栏，衬线字体归入排版） | 一屏一主题；与顶栏重复的控件不重复放 |
| 设置面板的尺寸 | 跟着内容长高（两页一长一短） | **固定高度 + 内部纵向滚动**（`--pop-h` 默认 443px = "排版页"正好放下的高度；背景页更长，在面板内部滚，**不画滚动条**；小窗口由 `calc(100vh - 76px)` 收窄） | 面板是绝对定位摆在入口上方的，位置由打开那一刻的高度算出来；切到更长的那一页就会长高 170px、底边直接压出屏幕（实测背景页底边跑到视口外）。固定高度之后切页签不动、位置永远有效，内容真放不下时在面板内部滚，不牵动整页 |
| 侧栏的内容排布 | 用一个分段控件切换「文档 / 目录」 | **上下两区常驻 + 共用一个滚动条** | 两者不是二选一的关系，同时看得见更好；共用一个滚动条之后，目录再长也不用"抢"高度 |
| 每个数值项 | 只有滑杆 | **滑杆 + 可直接输入的数字框** | 拖快、填准；拖到 108% 不用手抖 |
| 最近用过的背景 | 无 | **背景页顶部一行 5 个格子** | 换背景是高频动作，值得一步回退 |

## 持久化：记住什么、不记住什么

设计原则：**阅读器只负责"怎么渲染"，不负责"你读过什么"**。

| 记住 | 存在哪 | 说明 |
|---|---|---|
| 外观、排版、背景的全部设置 | localStorage（键 `md-reader:settings:v4`） | 换台机器就回到默认，符合直觉 |
| 自定义背景图（含最近 5 个背景） | **IndexedDB** | 图很大，localStorage 那 5MB 装不下几张；清理时会自动删掉不再引用的图 |
| 每篇文档读到哪一行 | localStorage | 这是唯一与具体文件相关的记忆；关掉再打开回到原处，不会出现在任何"最近打开"列表里 |
| 侧栏的开合 | localStorage | 视图状态，属于使用习惯 |

| 不记住 | 为什么 |
|---|---|
| 打开过的文件列表 / 最近文件 | 与"只负责渲染"的原则冲突；文件本来就在你自己的目录里 |
| 打开的文档本身 | 每次打开都是新的会话；关掉浏览器不留痕 |

## 目录结构

 ```
md-reader/              ← 目录名保持 md-reader；产品名是 Markdown Observer（见下）
├── .gitattributes / .gitignore / LICENSE / VERSION
├── index.html          页面骨架（开发用；单文件版由它构建而来）
├── serve.mjs           本地服务：静态文件 + 目录树 + 文件/图片读取（零依赖，只监听 127.0.0.1）
├── js/                 前端逻辑 app.js + 内置示例 sample.js（由 sample.md 生成，需入库）
├── styles/             dsh 的五张 token 表 + markdown.css（逐条搬运）+ 自己的壳与控件
│                       ★ tuning.css：外观尺码都在这（改它一个文件就够）
├── vendor/             第三方库（本地文件，见 NOTICE.md）+ 各家的许可证原文
├── sample.md           内置示例的源（→ js/sample.js）
├── README.md           用户手册（给读文档的人）
├── DEVELOPING.md       本文件
├── package.json        只有一个 devDependency（jsdom，自测用）；版本号不写这里（见「版本号只有一个来源」）
├── scripts/            启动与停止（古早但还支持的入口）
│   ├── start.sh / stop.sh        Linux / WSL / macOS
│   ├── start.bat / stop.bat      Windows（双击）
│   └── start.command             macOS（双击）
├── tools/              构建、自测、探针
│   ├── build-standalone.mjs  构建单文件 HTML
│   ├── build-share.mjs       生成分享包
│   ├── build-sample.mjs      由 sample.md 生成 js/sample.js
│   ├── release.mjs           打成发布 zip（零依赖，自己写的 zip）
│   ├── check-styles.mjs      保真度与 CSS 变量校验
│   ├── smoke.mjs             用 jsdom 把整个应用跑一遍（默认 / --server / --single / --standalone）
│   ├── version.mjs           版本号的唯一来源（读 git tag）
│   ├── measure.html / math-probe.html / folder-probe.html / pixel-probe.html   量算与探针页
│   ├── pixels.mjs            真截图量像素
│   └── win/                  Windows 那一摊（托盘、注册表、图标、安装包；详见 tools/win/README.md）
└── build/              所有产物，一行 .gitignore 全挡掉
    ├── standalone/     markdown-observer-v<版本>.html
    ├── share/          分享包（HTML + 说明 + 示例）
    ├── windows/        Markdown-Observer-Installer-v<版本>[-arm64].exe
    ├── vscode/         markdown-observer-v<版本>.vsix（将来）
    └── markdown-observer-v<版本>.zip   发布用
```

## 第一次上手（新克隆的仓库）

```sh
npm install              # 只有一个依赖：jsdom（自测用）
node tools/smoke.mjs     # 跑一遍自测（四种模式）
node tools/release.mjs   # 想构建产物：全落进 build/
```


## 自测

jsdom 那三个不需要浏览器（`cwd` 用 dsh 源码目录，借它的 `jsdom`）：

```sh
cd deepseek-harness-ayine
node ../md-reader/tools/check-styles.mjs                  # 保真度 + CSS 变量（秒级）
node ../md-reader/tools/smoke.mjs                          # 静态模式 + 模拟文件夹模式（114 项断言）
node ../md-reader/tools/smoke.mjs --server                 # 服务模式（113 项断言，含老设置迁移）
node ../md-reader/tools/smoke.mjs --standalone             # 单文件分享版（118 项断言，需先跑 tools/build-standalone.mjs）
DOC_ROOT=../sprite-plugin node ../md-reader/tools/smoke.mjs --server   # 用真实文档目录跑
```

还有两个**真浏览器**工具（不需要人看界面，跑完直接出结论）：

```sh
node tools/pixels.mjs                                     # 自己起临时服务（4398）+ 截图量像素，跑完自动关
READER_URL=http://127.0.0.1:4322 node tools/pixels.mjs     # 想量你正在用的那个服务
```

`tools/pixels.mjs` 会调用 headless Chrome（WSL 里自动用 Windows 侧那个；找不到就跳过），量四件事：按钮是不是真不带底色（和它所在的面板同色）、凸感在不在（内下缘暗线 / 深色下的内顶高光 / 外侧投影）、换背景后按钮像素是否跟着变（"磨砂是透的"的硬证据）、分段控件选中与未选中是否明显不同。任一不达标就非零退出。

为什么需要它：`getComputedStyle` 只能告诉你"声明写对了"，写对了但看着不对（深色主题下一块实心黑按钮就是这么来的）它发现不了。公式那一路还有个 `tools/math-probe.html`：把示例文档里的公式量出来（KaTeX 的四个字体到底加载没有、行内与独立公式的几何尺寸），
用法是在服务模式下开一个页面量另一页——`?src=/markdown-observer.html` 量打包版、
不写 `src` 就量开发页，两者数值应当**完全一致**：

```sh
chrome --headless=new --dump-dom "http://127.0.0.1:47821/tools/math-probe.html?src=/markdown-observer.html"
```

「打开文件夹」会弹系统对话框，无头浏览器点不了。`tools/folder-probe.html` 的做法是**直接把一批带 `webkitRelativePath` 的 File 喂给 `#folder-input` 并触发 `change`**——这正是用户真的选完一个文件夹之后，浏览器交给页面的东西。然后打印根目录名、树行数、提示文字、中间那段说明。场景用 `?case=normal|empty|huge` 选（正常两层目录 / 一个 md 都没有 / 超过 3000 篇上限），`?src=` 指定测哪一页（`../index.html` 是开发页，`markdown-observer.html` 是打包版）。

最省事的跑法是直接用阅读器自己的服务（开发页会自动进服务模式，但探针测的是 iframe 里的页面，不影响）：

```sh
./start.sh . --no-open &
chrome --headless=new --dump-dom "http://127.0.0.1:47821/tools/folder-probe.html?src=../index.html&case=normal"
```

要连"双击文件"那种场景一起验（静态模式、`file://`），Windows 侧 Chrome 可以这样直接读 WSL 里的文件：

```sh
chrome --headless=new --allow-file-access-from-files --dump-dom \
  "file://wsl.localhost/Ubuntu/home/<你>/.../md-reader/tools/folder-probe.html?src=../index.html&case=normal"
```

（`--allow-file-access-from-files` 只是让那个探针页能读同源的 iframe；阅读器本身不需要它。）

`tools/measure.html` 是配套的量算页，用 `chrome --headless=new --dump-dom` 打开它就能把每个按钮在浅色/深色下的最终颜色、边框、磨砂、设置弹层是否完整落在视口里（开在座位上方、不越界）、以及「最近使用」那一行是不是 5 个格子同一行同一高度打出来——纯几何和颜色的问题，人眼看不准，这个页面一跑就有数。

覆盖：渲染各元素、目录折叠、锚点跳转与深链接、主题、搜索、多文档切换与关闭、侧栏两区共用一个滚动条与收起／拉出、文件树折叠、空状态的三张卡（横排对齐、按环境显隐）、按钮的材质（不带底色、磨砂、凸感变量）、默认背景与「无背景」的渐变、设置两页与数字框、设置入口不在顶栏且固定在左下角、文件夹模式（用假句柄模拟浏览器的目录选择）、服务模式的目录接口，以及 v4 ← 老键的设置迁移（服务模式里逐个开页面，分别塞入老默认值与自选值）。

## 想改外观或默认值，改哪里

只有两个地方，改完保存、刷新页面即生效（改的是页面真正加载的源文件；发给朋友的那份单文件 HTML 要重跑一次 `node tools/build-share.mjs`）：

| 想改的东西 | 文件 | 形态 |
|---|---|---|
| 侧栏宽度、列表行高/圆角/留白、三角大小、两级缩进、正文面板圆角与内边距、顶栏与设置面板圆角、**设置面板高度（`--pop-h`）**、拉出小圆直径、进度条高度、玻璃模糊与饱和度、背景放大倍数、**按钮的玻璃配方**（底色浓淡 / 悬停 / 选中态 / 分段底板 / 磨砂半径 / 凸感）、空状态卡片的圆角与图标大小 | `styles/tuning.css` | 一屏 CSS 变量（46 个，含深色主题那一组），每个都带中文注释。**删掉一行就回到出厂默认**——每个用到它的地方都写了同一个数兜底（如 `var(--pull-size, 36px)`） |
| 初始主题、字号、行距、栏宽、代码换行、**默认背景（现在是无背景）**、背景图片模式下的模糊与遮罩、**面板不透明度（现在 50%）** | `js/app.js` 开头的 `DEFAULTS` | 一个 JS 对象，13 个字段，每个都带注释 |

为什么分两处：**尺码属于样式**（浏览器自己会算，不用跑 JS，改完刷新即生效）；**阅读偏好属于用户数据**（要写进 localStorage、要能被设置面板读写、要能一键恢复默认，而且它们由 JS 写成内联样式，优先级天然高于 CSS，放在 tuning.css 里也不会生效）。硬凑成一个文件反而会多出一层"读配置再写进 CSS"的胶水代码。

颜色不在这两处：全部来自 dsh 的那五张 token 表（`styles/base.css` 等），想换配色就改它们。

> 已经用过的浏览器里，`DEFAULTS` 会被 localStorage 里存的那份盖住；点设置面板里的「恢复默认」，或清掉 `md-reader:settings:v4` 即可。
>
> 设置键升级时做过两次迁移，规则都是**只搬"恰好等于老默认值"的那些，自己调过的人原样保留**：
> `v2 → v3` 把老默认背景（极光）改成「无背景」；`v3 → v4` 把老的面板不透明度 72% 改成 50%。迁移规则集中在 `js/app.js` 的 `migrateSettings()` 里，加一条默认值变更就往那里加一行。

## 版本号只有一个来源：`tools/version.mjs`

它读的是 **git tag**（tag 叫 `v1.0.0` → 版本就是 `1.0.0`）。不维护 VERSION 文件、也不写死在代码里——
tag 本身就是"发布这件事"，所有产物都从这一个函数取名：

| 产物 | 名字 | 谁生成 |
|---|---|---|
| 单文件 HTML | `markdown-observer-v1.0.0.html` | `tools/build-standalone.mjs` |
| 分享包 | `share/`（里面的 HTML 同名） | `tools/build-share.mjs` |
| 发布 zip | `markdown-observer-v1.0.0.zip` | `tools/release.mjs` |
| Windows 安装包 | `build/windows/Markdown-Observer-Installer-v1.0.0.exe` | `tools/win/make-package.mjs` |
| Windows 安装包（ARM64） | `build/windows/Markdown-Observer-Installer-v1.0.0-arm64.exe` | 同上，加 `--node <arm64 的 node.exe>`（脚本会核对架构，塞错会拒包） |
| 安装包判断"更新/修复/降级" | 比的就是这个版本号 | `tools/win/setup.cs` |
| 「设置 → 应用」里显示的版本 | `v1.0.0`（注册表 DisplayVersion） | `tools/win/install.mjs` |

仓库里还有一个 `VERSION` 文件，但**它是生成物，不是第二个来源**：内容由 tag 推出来（`node tools/version.mjs --write`，
发布脚本会自动跑），作用是让**下载源码 zip 的人**（没有 .git，看不到 tag）也知道自己拿到的是哪一版。
两个来源会漂移的毛病用一条自测堵住：`node tools/version.mjs --check` 会核对文件和 tag 是否一致，smoke 每次都会跑它。

**发新版只要三下**：`git tag v1.1.0` → `node tools/release.mjs`（会顺手更新 VERSION，记得一起提交）→ 上传产物。
HEAD 不在 tag 上时版本会带 `-dev`（`1.0.0-dev`）——一眼看出这不是发布版。
临时顶掉（打包测试用，不动仓库）：`MD_OBSERVER_VERSION=1.2.3 node tools/win/make-package.mjs`。

## 怎么发布

发布要解决的问题只有一个：**让"某个版本"有一个固定的下载地址**。这个仓库的分工是——

| 东西 | 放在哪 | 为什么 |
|---|---|---|
| 源码 | 仓库（git） | 一切都能从这里重建 |
| 能下载的成品（zip） | **GitHub Release 的附件** | 构建产物不进版本库；附件不占仓库体积，还能按版本回看"哪一版发给过谁" |
| 单文件版 / `share/` / zip | 本地（`.gitignore` 挡着） | 一条命令就能重建，没必要进库 |
| Windows 安装程序（`build/windows/*.exe`） | 本地（`.gitignore` 挡着） | `node tools/win/make-package.mjs` 重建；它自带 Node 运行时，约 35 MB，不适合进库 |

**版本号只有一个来源：git tag**（`v1.0.0` → `1.0.0`）。不额外维护 `VERSION` 文件、也不写死在代码里——tag 本身就是"发布这件事"，工具去读它，就不会出现"包里写 1.0.0、tag 是 1.0.1"这种对不上的情况。

### 一次发布

```sh
node tools/release.mjs          # 版本号取最近的 tag；也可以 node tools/release.mjs 1.0.1 指定
```

它会一条龙做完：**重建单文件版 → 重建 share/ → 打成 markdown-observer-v<版本>.zip → 打印"发布检查"和下一步**。zip 里是 `share/` 的三件套，**不套一层目录**，收件人解压后直接双击 `markdown-observer.html`。

打包为什么自己写：Windows / WSL / macOS 上有没有 `zip` 命令全看运气（本机就没有）。Node 自带 zlib，把 zip 的那几十行写在 `tools/release.mjs` 里，就能保证"一条命令到处一样"；产物用 Python 的 `zipfile` 验过（`testzip()` 无损坏、逐字节一致、deflate、权限 0644）。

跑完它会列一张清单（工作区干净吗、tag 有没有、远程配了吗、包叫什么），并**把 Release 说明的模板直接打出来**——复制粘贴即可。接着：

```sh
git add -A && git commit -m "..." && git push
git tag -a v1.0.0 -m "Markdown Observer v1.0.0" && git push origin v1.0.0
```

然后网页上三下：仓库 → **Releases → Draft a new release** → 选 tag `v1.0.0` → 把 zip 拖进 **Attach binaries** → **Publish**。

> 别把 zip 提交进仓库。它 463 KB 且每次改样式都会变，进版本库只会让历史越来越重——附件才是它的家，这也是 `.gitignore` 挡着它的原因。

**Release 说明写什么**：三段就够——① 这是什么；② 怎么用（下载哪个文件、双击哪个）；③ 这一版改了什么。前两段 `release.mjs` 已经生成好，第三段每次手写。

### 装了 gh 之后（可选）

没装也能发（网页三下就完事）；装了之后一条命令：

```sh
gh release create v1.0.0 markdown-observer-v1.0.0.zip --title "v1.0.0" --generate-notes
```

（`--generate-notes` 让 GitHub 按提交记录自动写说明；想自己写，就把上面 `release.mjs` 打印的那段存成 `RELEASE.md`，改用 `--notes-file RELEASE.md`。）

### 全自动（可选，想省掉网页那三下）

在仓库里放一个 `.github/workflows/release.yml`，"push 一个 tag"就自动构建并挂附件——因为打包零依赖（只用 Node 自带的 zlib），CI 里跑得起来：

```yaml
name: Release
on:
  push:
    tags: ['v*']
permissions:
  contents: write
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '22' }
      - run: node tools/build-share.mjs
      - run: node tools/release.mjs --no-build
      - run: gh release create "$GITHUB_REF_NAME" markdown-observer-*.zip --title "$GITHUB_REF_NAME" --generate-notes
        env: { GH_TOKEN: '${{ secrets.GITHUB_TOKEN }}' }
```

好处是"发布 = 推一个 tag"；代价是多一个要维护的 CI 文件、出问题得去 Actions 页面看日志。**自己发着玩的话，手工三步更直接。**

### 发布前的检查清单

1. 自测全绿：`node tools/check-styles.mjs`、三种 `smoke`、`node tools/pixels.mjs`（真浏览器量像素）；
2. `node tools/release.mjs <版本>` 跑完，清单里的勾都对；
3. 提交推送 → 打 tag 推送 → 建 Release（或网页那三下）；
4. **自己下载一次**，解开双击 `markdown-observer.html` 确认能读——这是唯一能证明"发出去的那个东西是好的"的办法。



**启动器参数**

```sh
./start.sh                      # 打开当前目录
./start.sh ~/notes              # 打开指定目录
./start.sh ~/notes --port 5000  # 指定端口
./start.sh --no-open            # 不起浏览器（纯服务）
```

**服务的起停与单实例**

```sh
./start.sh ~/notes     # 起服务（已经在跑同一个目录时，它只打开浏览器、不会起第二个）
./stop.sh              # 停掉它
```

启动时会把自己的 PID、端口、文档目录写进仓库根目录的 `.markdown-observer.pid`；`scripts/stop.sh` 读它来收工；Ctrl-C 结束也会自动清掉这个文件。所以**不会越起越多**：换个目录再启动，它会先停掉旧的那个。Windows 那边是 `scripts/start.bat` / `scripts/stop.bat`（后者按端口找进程），端口和其他入口一样固定 47821。这五个脚本都在 `scripts/` 里。

**服务接口**（服务模式下，插件/脚本也能用）

| 路径 | 作用 |
|---|---|
| `GET /api/info` | 服务信息（模式与根目录） |
| `GET /api/tree` | 根目录下所有 markdown 的路径列表 |
| `GET /api/file?path=…` | 读一个 markdown（返回路径、名称、正文、大小、修改时间） |
| `GET /api/raw?path=…` | 原样读一个文件（文档里的相对图片就走它） |

**深链接**：`http://127.0.0.1:47821/?file=docs%2Fguide.md#安装` 直接打开某篇文档的某一节。旧的 `#docs/guide.md` 形式也仍然可用。

**想改代码**：`js/app.js` 顶部是设置默认值，`PRESETS` 是内置背景；`styles/tuning.css` 是所有尺码与按钮材质；`styles/controls.css` 最后一节是按钮的统一配方；`styles/markdown.css` 是正文排版（与 dsh 一致的部分，改它前先看 `tools/check-styles.mjs`）；改完 `sample.md` 要跑一次 `node tools/build-sample.mjs`，改完前端要跑一次 `node tools/build-share.mjs`（否则单文件版与 `share/` 还是旧的）。

## 安全边界

本机工具最容易忽略的就是这一块，所以集中写清楚：

| 边界 | 怎么做的 |
|---|---|
| 只监听本机 | 服务绑 `127.0.0.1`，局域网里别人打不开 |
| 防 DNS rebinding | 每个请求都检查 `Host` 头，不是 `127.0.0.1:端口` / `localhost:端口` 一律 403 |
| 不读任意文件 | 白名单 `ROOTS`：只有「打开过的文件所在目录」才让读。**在阅读器里打开过的文档也算打开过**（否则点开 A 目录里的一篇、再点它里面的链接就跳不动了）；已有的高层目录能覆盖就不重复记 |
| 防跨站请求伪造 | `/api/open`、`/api/root`、`/api/pref`、`/api/quit` 这些**会改变状态**的接口，带 `Origin` 且不是我们自己的一律 403。跨站读不到响应（不发 CORS 头），但动作会真的发生，所以要挡 |
| 托盘的小接口 | 同样只认我们自己的页面（以前回 `Access-Control-Allow-Origin: *`，那等于任何网站都能让用户的浏览器去改开机自启，已经改掉） |
| 不联网 | 页面不发任何外部请求；库、字体、公式全在本地 |
| 文档里的 HTML | 渲染前过 DOMPurify，脚本、事件属性、危险标签都清掉 |

改这块之前先看一眼上表：**每一条都是有意为之的**，不是随手写的。

## 已知限制

- **"好不好看"这件事没有自动验收**：布局、动效、磨砂的观感由 `tools/pixels.mjs`（真截图量像素）和 `tools/measure.html`（真浏览器量最终颜色）覆盖到"数值对不对"，剩下的主观判断仍然需要人眼过一遍。
- **读文件夹用的是 `<input webkitdirectory>`，不是 File System Access**：前者到处都能用（含 `file://`），后者在 `file://` 页面上会卡住（见踩坑第 7 条）。代价有两个：拿到的是「一批 File」而不是目录句柄（空目录不会出现在树里、文件夹里改了文件要重新选一次才会刷新）；以及**选择框一确定，浏览器就要先把整个文件夹枚举一遍**，`node_modules` 也不例外——实测一个代码仓库 7 万个文件（5.6 万个在 node_modules），这一步会等很久。代码仓库请用服务模式（服务端遍历 + `SKIP_DIRS`：同一仓库 0.1 秒 / 1019 篇）。界面上做了两件事：点按钮时先提示一句；拿到超 2 万个文件时在结果里说明「一共 N 个文件，node_modules / .git 之类已跳过」。
- **静态模式（拖入文件）下文档里的相对图片显示不了**：浏览器不允许 `file://` 页面读同目录文件。用服务模式或「打开文件夹」就正常。
- **`file://` 下少数浏览器会禁用本地存储**：设置与阅读位置只在本次会话有效；服务模式下一定可用。
- 不支持 **mermaid** 图（dsh 也不支持）。公式支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。
- 只做阅读，不提供编辑。
- **"文件被改了自动刷新"是特意不做的**（评估过、决定放下）。原因与数据：服务多半跑在 WSL 里，而 md 往往在 `/mnt/c`（Windows 侧），那一侧的文件改动**不会**产生 inotify 事件，`fs.watch` 收不到；只能轮询 mtime，而实测 `stat` 一个 `/mnt/c` 上的文件要 **0.83 ms**（Linux 侧只要 0.001 ms）——20 个文件每 2 秒一轮就是单核 0.8%，为一个后台功能不值。
  将来真要做，有两条便宜得多的路：① **切回窗口时刷新**（监听 `focus` / `visibilitychange`，把开着的那几篇重新读一遍；空闲时零定时器、零磁盘访问，正好覆盖"编辑器改完切回阅读器"这个真实场景）；② 只盯**当前这一篇**、间隔放宽到 3 秒（约 0.04% 单核）。
