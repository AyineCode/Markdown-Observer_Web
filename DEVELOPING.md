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

## 三个踩过的坑（都写成了注释 + 断言）

**1. 通用类名会撞车。** 「最近使用」里的空格子原本叫 `.recent.empty`，而 `.empty` 是**空状态那个大面板**的类名（上面挂着 `max-width: 760px`、`margin: 5vh auto 0`、`padding: 46px 44px 34px`、`border-radius: 24px`）。于是占位格子被撑开、又被 5vh 的外边距顶到下一行——看上去就是"背景和占位边框不在同一行"。现在叫 `.recent.slot`（见 `styles/controls.css`），smoke 里加了 `slot.matches('.empty') === false` 这条断言防复发。**教训：面板级的类名要够特别，别用 `.empty`、`.box` 这种。**

**2. 事件派发后再重建 DOM，会让"点在面板里"变成"点在面板外"。** 换背景会重画色板和「最近使用」，被点的那颗按钮当场脱离文档；文档级那个"点外面就关面板"的处理函数随后跑到，`pop.contains(event.target)` 对已脱离的节点返回 false → 面板被误关。现在用 `event.composedPath()`（路径在派发时就固定）加 `event.target.isConnected === false` 兜底判断，面板不会再自己关上。**教训：判定"点在不在某个容器里"，别只信 `contains()` 加当前的 `event.target`。**

**3. 界面别排在持久化后面。** 设一张图片当背景时，原本的顺序是"记住 → 应用 → 写 IndexedDB"，而"最近使用"的缩略图是从 IndexedDB 里读的——那一刻图还没写进去，于是缩略图空着，要等下次重画才出现（用户看到的"切换后才好"）。中间试过"先写库再应用"，更糟：IndexedDB 慢或不可用（无头环境里就直接挂住）时，背景根本铺不上。正确的分工是——**缩略图对"当前这张图"直接用内存里的 `bgImage`，背景立刻生效，落库放到最后并且不等它**。`tools/measure.html` 现在会真拖一张图进来验这一条。**教训：能立刻画出来的东西，不要让它绕一趟存储。**

## 设置为什么放在那里

原则是**让控件出现在它所属的地方**，而不是全都塞进一个面板：

| 控件 | 之前 | 现在 | 为什么 |
|---|---|---|---|
| **设置入口** | 顶栏的一个齿轮图标（和搜索/打印混在一起） | **左下角一个带文字的「设置」座位**（固定定位，侧栏收起后依然在） | 它是**全局**设置，不是某一篇文档的设置，不该和文档工具挤在顶栏；放在左下角既显眼，又和 dsh 把设置钉在侧栏底部是同一个取向。固定定位是关键：侧栏收起后入口必须还在，而侧栏本身带 `backdrop-filter`（会成为 fixed 子元素的包含块），所以它不能放在侧栏里面 |
| 收起 / 展开侧栏 | 在设置面板里 | **侧栏自己头上有收起按钮**；收起后舞台左上角出现小圆拉出按钮；设置里彻底删掉 | 它是界面部件，不是偏好——不该出现在设置里 |
| 打开文件 | 顶栏图标 + 空状态按钮 | **侧栏「文档」页顶部**，顶栏不再重复 | 与 dsh 一致：文件相关操作归侧栏；顶栏只放全局动作 |
| 设置面板 | 一长条，混着外观、排版、背景 | **两页切换**：排版 / 背景（主题只在顶栏，衬线字体归入排版） | 一屏一主题；与顶栏重复的控件不重复放 |
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
├── .gitattributes      行尾规则：仓库里一律 LF，Windows 的 .bat 用 CRLF
├── .gitignore          构建产物 / 运行期文件 / 系统杂物
├── LICENSE             本项目 MIT（© 2026 AyineCode）
├── start.sh / stop.sh / start.command / start.bat / stop.bat   启动与停止
├── index.html          页面骨架（开发用；单文件版由它构建而来）
├── markdown-observer.html  构建产物：单文件、可直接分发
├── share/              给朋友的三件套（HTML + 说明 + 示例；构建产物）
├── serve.mjs           本地服务：静态文件 + 目录树 + 文件/图片读取（零依赖，只监听 127.0.0.1）
├── js/app.js           全部前端逻辑
├── styles/             dsh 的五张 token 表 + markdown.css（逐条搬运）+ 自己的壳与控件
│                       ★ tuning.css：外观尺码都在这（改它一个文件就够）
├── vendor/             第三方库（本地文件，见 NOTICE.md）+ 各家的许可证原文
├── sample.md / sample.js  示例文档与其内嵌版本
├── README.md           用户手册（给读文档的人）
├── DEVELOPING.md       本文件
└── tools/
    ├── build-standalone.mjs  构建单文件 HTML
    ├── build-share.mjs       生成 share/ 分享包
    ├── release.mjs           打成 markdown-observer-v<版本>.zip（零依赖，自己写的 zip）
    ├── build-sample.mjs      由 sample.md 生成 sample.js
    ├── check-styles.mjs      保真度与 CSS 变量校验
    ├── smoke.mjs             用 jsdom 把整个应用跑一遍
    ├── measure.html          量算页：打印各按钮在浅/深色下的最终颜色
    ├── pixel-probe.html      像素探针页：给截图量像素用
    └── pixels.mjs            真截图量像素：背景透不透、凸感在不在、切换看不看得出
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

为什么需要它：`getComputedStyle` 只能告诉你"声明写对了"，写对了但看着不对（深色主题下一块实心黑按钮就是这么来的）它发现不了。`tools/measure.html` 是配套的量算页，用 `chrome --headless=new --dump-dom` 打开它就能把每个按钮在浅色/深色下的最终颜色、边框、磨砂、设置弹层是否完整落在视口里（开在座位上方、不越界）、以及「最近使用」那一行是不是 5 个格子同一行同一高度打出来——纯几何和颜色的问题，人眼看不准，这个页面一跑就有数。

覆盖：渲染各元素、目录折叠、锚点跳转与深链接、主题、搜索、多文档切换与关闭、侧栏两区共用一个滚动条与收起／拉出、文件树折叠、空状态的三张卡（横排对齐、按环境显隐）、按钮的材质（不带底色、磨砂、凸感变量）、默认背景与「无背景」的渐变、设置两页与数字框、设置入口不在顶栏且固定在左下角、文件夹模式（用假句柄模拟浏览器的目录选择）、服务模式的目录接口，以及 v4 ← 老键的设置迁移（服务模式里逐个开页面，分别塞入老默认值与自选值）。

## 想改外观或默认值，改哪里

只有两个地方，改完保存、刷新页面即生效（改的是页面真正加载的源文件；发给朋友的那份单文件 HTML 要重跑一次 `node tools/build-share.mjs`）：

| 想改的东西 | 文件 | 形态 |
|---|---|---|
| 侧栏宽度、列表行高/圆角/留白、三角大小、两级缩进、正文面板圆角与内边距、顶栏与设置面板圆角、拉出小圆直径、进度条高度、玻璃模糊与饱和度、背景放大倍数、**按钮的玻璃配方**（底色浓淡 / 悬停 / 选中态 / 分段底板 / 磨砂半径 / 凸感）、空状态卡片的圆角与图标大小 | `styles/tuning.css` | 一屏 CSS 变量（46 个，含深色主题那一组），每个都带中文注释。**删掉一行就回到出厂默认**——每个用到它的地方都写了同一个数兜底（如 `var(--pull-size, 36px)`） |
| 初始主题、字号、行距、栏宽、代码换行、**默认背景（现在是无背景）**、背景图片模式下的模糊与遮罩、**面板不透明度（现在 50%）** | `js/app.js` 开头的 `DEFAULTS` | 一个 JS 对象，13 个字段，每个都带注释 |

为什么分两处：**尺码属于样式**（浏览器自己会算，不用跑 JS，改完刷新即生效）；**阅读偏好属于用户数据**（要写进 localStorage、要能被设置面板读写、要能一键恢复默认，而且它们由 JS 写成内联样式，优先级天然高于 CSS，放在 tuning.css 里也不会生效）。硬凑成一个文件反而会多出一层"读配置再写进 CSS"的胶水代码。

颜色不在这两处：全部来自 dsh 的那五张 token 表（`styles/base.css` 等），想换配色就改它们。

> 已经用过的浏览器里，`DEFAULTS` 会被 localStorage 里存的那份盖住；点设置面板里的「恢复默认」，或清掉 `md-reader:settings:v4` 即可。
>
> 设置键升级时做过两次迁移，规则都是**只搬"恰好等于老默认值"的那些，自己调过的人原样保留**：
> `v2 → v3` 把老默认背景（极光）改成「无背景」；`v3 → v4` 把老的面板不透明度 72% 改成 50%。迁移规则集中在 `js/app.js` 的 `migrateSettings()` 里，加一条默认值变更就往那里加一行。

## 怎么发布

发布要解决的问题只有一个：**让"某个版本"有一个固定的下载地址**。这个仓库的分工是——

| 东西 | 放在哪 | 为什么 |
|---|---|---|
| 源码 | 仓库（git） | 一切都能从这里重建 |
| 能下载的成品（zip） | **GitHub Release 的附件** | 构建产物不进版本库；附件不占仓库体积，还能按版本回看"哪一版发给过谁" |
| 单文件版 / `share/` / zip | 本地（`.gitignore` 挡着） | 一条命令就能重建，没必要进库 |

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

启动时会把自己的 PID、端口、文档目录写进 `.markdown-observer.pid`；`stop.sh` 读它来收工；Ctrl-C 结束也会自动清掉这个文件。所以**不会越起越多**：换个目录再启动，它会先停掉旧的那个。Windows 的 `start.bat` / `stop.bat` 是另一套（固定 4321 端口、`stop.bat` 按端口找进程），它们没入库，属于本机便利脚本。

**服务接口**（服务模式下，插件/脚本也能用）

| 路径 | 作用 |
|---|---|
| `GET /api/info` | 服务信息（模式与根目录） |
| `GET /api/tree` | 根目录下所有 markdown 的路径列表 |
| `GET /api/file?path=…` | 读一个 markdown（返回路径、名称、正文、大小、修改时间） |
| `GET /api/raw?path=…` | 原样读一个文件（文档里的相对图片就走它） |

**深链接**：`http://127.0.0.1:4321/?file=docs%2Fguide.md#安装` 直接打开某篇文档的某一节。旧的 `#docs/guide.md` 形式也仍然可用。

**想改代码**：`js/app.js` 顶部是设置默认值，`PRESETS` 是内置背景；`styles/tuning.css` 是所有尺码与按钮材质；`styles/controls.css` 最后一节是按钮的统一配方；`styles/markdown.css` 是正文排版（与 dsh 一致的部分，改它前先看 `tools/check-styles.mjs`）；改完 `sample.md` 要跑一次 `node tools/build-sample.mjs`，改完前端要跑一次 `node tools/build-share.mjs`（否则单文件版与 `share/` 还是旧的）。

## 已知限制

- **"好不好看"这件事没有自动验收**：布局、动效、磨砂的观感由 `tools/pixels.mjs`（真截图量像素）和 `tools/measure.html`（真浏览器量最终颜色）覆盖到"数值对不对"，剩下的主观判断仍然需要人眼过一遍。
- **「打开文件夹」只支持 Chromium 系**（Chrome / Edge）：这是浏览器的能力（File System Access API），Firefox / Safari 上点它会提示改用服务模式；其余功能不受影响。
- **静态模式（拖入文件）下文档里的相对图片显示不了**：浏览器不允许 `file://` 页面读同目录文件。用服务模式或「打开文件夹」就正常。
- **`file://` 下少数浏览器会禁用本地存储**：设置与阅读位置只在本次会话有效；服务模式下一定可用。
- 不支持 **mermaid** 图（dsh 也不支持）。公式支持 `$...$`、`$$...$$`、`\(...\)`、`\[...\]`。
- 只做阅读，不提供编辑。
