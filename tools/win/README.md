# tools/win —— Windows 的"打开方式"这一摊

让 **.md 文件在资源管理器里双击 / 右键就能用 Markdown Observer 打开**。这里放的是这件事需要的
Windows 侧零件；阅读器本体（`index.html` / `js` / `styles` / `vendor` / `serve.mjs`）仍在仓库根目录。

---

## 双击一个 .md 之后，发生了什么

```
Explorer（按注册表找到 MarkdownObserver.exe，把文件路径当参数交给它）
   ↓
MarkdownObserver.exe        读同目录的 config.txt，照着起一个后台进程，自己立刻退出
   ↓                        （编译成 winexe：双击时不闪黑窗口）
config.txt 说的那个进程      现在配的是 wsl.exe → tools/win/run-server.sh
   ↓
serve.mjs --file <那篇 md>  起一个只监听 127.0.0.1 的服务，然后自动打开浏览器
   ↓
浏览器里的 js/app.js        发现是服务模式 → 换上 serverHost
   ↓                        正文、图片、目录全部走 /api/*
你看到的那一篇
```

绕不开的前提：**浏览器读不了任意路径的文件**（安全沙箱）。所以必须有一个浏览器之外的"宿主"
替它读——`serve.mjs` 就是那个宿主，启动器只是把"双击"这个动作翻译成"起一个宿主"。

---

## 文件

| 文件 | 干什么 |
|---|---|
| `launcher.cs` | **总管**源码：既是"打开方式"被调起来的程序，也是右下角那个托盘。C# 5 写法（见下） |
| `build-launcher.mjs` | 编译它 → `MarkdownObserver.exe`（约 65 KB，含图标） |
| `MarkdownObserver.exe` | 编译产物，不入库 |
| `run-server.sh` | **本机开发用**：WSL 这边的入口，负责找到 node 再 exec serve.mjs |
| `install.mjs` | 装：编译启动器 → 复制到 `%LOCALAPPDATA%\MarkdownObserver` → 写注册表 |
| `uninstall.mjs` | 卸：删注册表 + 删那个目录，一个字不留 |
| `status.mjs` | 隔着端口问一句"服务在不在、在读哪篇"，`--stop` 让它退出（走 `/api/quit`） |
| `stop-servers.sh` | 兜底：服务是旧版本（还没有 `/api/quit`）或卡住时，用它硬停。必须通过 `wsl.exe` 起 |
| `make-icon.py` | 画图标（Pillow 排字体）。`--variants` 出字体对照表。想换图标只动它，或者直接换 .ico |
| `markdown-observer.ico` | 图标成品（多尺寸），入库；换图标就是换它 |
| `make-package.mjs` | 打成"双击就能装"的安装程序 → `dist/Markdown-Observer-Installer.exe` |
| `setup.cs` | 安装程序本体（一个 WinForms 小向导），被上面的脚本编译并贴上文件包 |

### 服务是"常驻后台"，不自己退

它就是要一直待着（吃完午饭回来还能接着读），所以：

- **不会空闲自杀**，也没有心跳轮询——为省那点内存反复启停、每 20 秒问一次"你还在吗"，
  才是真的浪费（实测常驻服务空闲时 CPU 占用 0.00%）。
- **端口固定 47821**。这不是随便定的：浏览器的设置、背景图、阅读位置都是按"源"（含端口）存的，
  端口一变，用户看到的就是"我的设置全丢了"。抢端口的问题由 `serve.mjs` 自己解决——
  端口上已经跑着我们自己的服务时，它会把新文件交给那个服务然后退出。
- **双击第二篇不会起第二个服务**：`serve.mjs` 发现端口被占 → 探一下 `/api/info` 确认是自己人 →
  调 `/api/open` 把这篇交过去 → 自己退出（退出码 0）。
- 想停掉：`node tools/win/status.mjs --stop`（服务端的 `/api/quit`；右下角的托盘程序做好之后，那里也能退）。
  停不掉（服务是旧版本、或卡住了）就用兜底脚本，注意要**通过 wsl.exe 起**——
  沙箱/容器有自己的 PID 命名空间，看不见别的空间里的进程，而端口是看得见的：
  `wsl.exe -d Ubuntu -u <用户名> -e /bin/bash <仓库>/tools/win/stop-servers.sh`

编译器用的是 Windows 自带的 `.NET Framework\v4.0.30319\csc.exe`：Win10 / Win11 天生就有，
不用装 .NET SDK、不用 Visual Studio、不用联网还原 NuGet。代价是它只认 C# 5——
`launcher.cs` 里不能用字符串插值、`?.`、表达式体成员，改的时候注意。

---

## 总管（MarkdownObserver.exe）的几种用法

| 命令 | 干什么 |
|---|---|
| `MarkdownObserver.exe "C:\notes\a.md"` | Explorer 双击时调的就是它：服务在跑就交给它，不在跑就起一个 |
| `MarkdownObserver.exe --tray` | 常驻托盘（全机只留一个）。**左键**＝开一个新的阅读器页面；**右键菜单**：打开文件… / 打开文件夹… / 退出 |
| `MarkdownObserver.exe --quit` | 服务和托盘一起退干净 |
| `MarkdownObserver.exe --status` | 把状态写进日志（给脚本、排查用） |
| `MarkdownObserver.exe --diag` | 自检：把"我打算干什么"写进日志并弹出来 |
| `MarkdownObserver.exe --uninstall` | 卸载：清注册表 → 停服务 → 删掉自己所在的目录。"设置 → 应用"里的卸载按钮走的就是它 |

第一次双击会自动把托盘也拉起来；之后每次双击都只是"把这篇交给已经在跑的服务"，不会再多起进程。

## 托盘的三个动作，各自是什么语义

| 动作 | 语义 |
|---|---|
| **左键** | 开一个**新的**阅读器页面（干净的 start 页）。地址里临时带个 `?n=时间戳`：不带的话浏览器会跳到已经开着的同地址标签，表现就是"怎么还是刚才那篇"。**页面加载后自己会把这个记号抹掉**，地址栏里留下的还是干净的 `?blank=1` |
| **右键 → 打开文件…** | 交给已经在跑的服务：默认**复用**已开着的页面（设置里「行为」可改成每次新开标签）；随后会把阅读器窗口**叫到前台**（不然"看起来没反应"） |
| **右键 → 打开文件夹…** | 开一个**新页面**，它有**自己的 Workspace**（各自一棵树、各自一份「打开的文档」，互不干扰）。服务端只负责"把这个目录加进允许列表"，工作区是页面自己的事（地址栏里的 `?root=`） |

网页里的 ＋ 和按钮是「就地切换**本页**的 Workspace」（改的是地址栏里的 `?root=`，不动别的页面）。

**「打开文件」也不走浏览器**：服务模式下它会请托盘弹同一个新式窗口（只列 markdown）。
浏览器自己的选择框给不了真实路径——地址栏没法跟着走，双击那套 URL 也就接不上。
只有单文件 HTML / `file://` 那种没有服务端的场合，才回落到浏览器的选择框。

**工作区永远是"每个页面自己的"**：服务端只维护一份"允许读哪些目录"的白名单，
谁在哪个文件夹、要不要显示树，全由页面地址栏里的 `?root=` 决定。
带 `?file=` 或 `?blank=1` 的页面（双击新开的标签、左键开的新页面）**不会**长出别人的文件夹树。

## "打开文件夹"为什么绕了一圈

网页拿不到文件夹的**真实路径**（浏览器的隐私规矩），而"用服务端快速扫描一个大文件夹"必须知道路径。
所以链路是这样的：

```
网页点「打开文件夹」 → 问托盘（127.0.0.1:47822，它就在 Windows 上）
                        托盘弹 **Windows 10/11 那个新式「选择文件夹」**（IFileOpenDialog，浏览器弹的也是它）
                        选完 → 托盘把路径交给服务端（/api/root）
                              → 服务端扫描 + 顺着长连接告诉页面"换文件夹了"
托盘不在时 → 退回服务端自己的老式对话框（功能一样，就是窗口老气）
```

注意方向：**必须是网页去问托盘**。服务端可能跑在 WSL 里，而 WSL 连不到 Windows 那边的
localhost（反过来 Windows → WSL 可以）。托盘拿到的是 Windows 路径，它会自己转成服务端认的写法。

**对话框的主人必须是"当前前台窗口"**（一般就是浏览器）。拿托盘自己那个看不见的小窗口当主人时，
对话框会被摆到屏幕外、或者躲在别的窗口后面——而且它**确实开着**，于是"一次只弹一个"的闸一直被它
占着，用户点什么都被忽略，看起来就是"点了没反应"（日志里会是一串"已经有一个对话框开着"）。
另外还留了一道保险：同一个对话框超过 5 分钟没动静就当它丢了，放行新的请求。

老式对话框（`SHBrowseForFolder`）**已经整条删掉**了：不为省一点等待就弹一个老气窗口。

## 图标

一个来源，处处生效：**图标只存在于 `markdown-observer.ico`**，编译时用 `/win32icon` 嵌进 exe，
托盘那个图标也是运行时从 exe 自己身上取的（`Icon.ExtractAssociatedIcon`）——所以换一次就够，
任务管理器、资源管理器、托盘、"打开方式"列表全跟着变。

```sh
python3 tools/win/make-icon.py                        # 用 make-icon.py 顶部的 FONT / 配色重新生成
python3 tools/win/make-icon.py --variants             # 生成字体对照表（挑字体用）
python3 tools/win/make-icon.py --font <字体.ttf>       # 临时换一个字体看看
node tools/win/build-launcher.mjs                     # 把图标编进 exe
node tools/win/install.mjs                            # 更新注册表里的 DefaultIcon
```

改配色就看 `make-icon.py` 顶上那四行（`BG_TOP`/`BG_BOTTOM` 是方块的上下渐变，`INK_TOP`/`INK_BOTTOM` 是 M 的），
改形状就看 `INSET`（留边）、`CORNER`（圆角）、`INK_SCALE`（字多大）、`STROKE`（描边加粗，太大就糊）。
也可以直接拿自己的多尺寸 `.ico` 覆盖 `markdown-observer.ico`，连 Python 都不用。

**一个改不了的**：后台服务进程（`node.exe`）在任务管理器里显示的是 Node 自己的图标——
图标是编在可执行文件里的，改别人的 exe 不现实。

## 打成安装包

```sh
node tools/win/make-package.mjs                       # → dist/Markdown-Observer-Installer.exe（约 35 MB）
node tools/win/make-package.mjs --node <node.exe>     # 换一个 Node 运行时（默认借本机装的那个）
```

一个 exe，自带 Node 运行时，目标电脑**什么都不用装**。它长这样：

```
[用 csc 编出来的 setup.exe][压缩后的文件包][8 字节长度][8 字节魔数 "MDOBSET1"]
```

运行时读自己的尾巴 → 解开 → 落到安装目录 → 用包里自带的 `node.exe` 跑 `tools/win/install.mjs`。
**安装逻辑只有 install.mjs 那一份**，安装程序只是个壳——不然两处迟早不一致。

装完那一页只给说明，不摆按钮：**Windows 不允许程序自己抢默认**，得用户右键一个 .md → 打开方式 → 选择其他应用，
勾「始终」。说明里把这几步写清楚了。


静默安装（给脚本/测试用）：

```sh
"Markdown Observer 安装程序.exe" --silent [--dir <目录>] [--autostart | --no-autostart]
"Markdown Observer 安装程序.exe" --extract-only <目录>     # 只解包，不写注册表（自测用）
```

## 杀软误报（先说清楚）

安装包**有一定概率被杀软拦下来**。这不是"写错了什么"，而是这个包的**形状**碰巧是恶意软件的经典形状：

| 我们的做法 | 在启发式引擎眼里像什么 |
|---|---|
| exe 尾巴上贴一段压缩数据，运行时解出来 | dropper（释放器） |
| 包里带 `node.exe` 并执行它 | 恶意软件最常用的宿主之一 |
| 写 `HKCU\...\Run`（开机自启）、抢文件关联 | 流氓软件的标准动作 |
| 卸载时 `cmd /c ping & rmdir` 删自己 | 木马自删除的经典写法 |
| 没有代码签名、全网没人见过这个文件 | 零信誉，直接拦 |

**能做的（按有效性排）**：

1. **把文件提交给微软复核**（免费、通常一两天）：<https://www.microsoft.com/en-us/wdsi/filesubmission>
   选 "I believe this file is incorrectly detected"，把 exe 传上去。误报一旦确认，Defender 的库会更新。
2. **代码签名**：买一张 OV/EV 证书给 exe 签名，是根治办法（现在 OV 证书也要配硬件令牌或云 HSM）。
3. **换一种分发形态**：不做"单文件自解压"，改成**绿色版 zip**（zip 里放 node.exe + 程序 + 一个安装.exe），
   形状上就从"释放器"变回"一个压缩包"，误报会明显减少——代价是用户要多一步"解压到哪儿"。
4. 让用户自己在杀软里加白名单（最不推荐，但对熟人小范围够用）。

## 装 / 卸 / 试

```sh
node tools/win/install.mjs --dry-run    # 先看它打算干什么（一个字都不改）
node tools/win/install.mjs              # 装
node tools/win/uninstall.mjs            # 卸
node tools/win/build-launcher.mjs       # 只重编启动器
./tools/win/MarkdownObserver.exe 'C:\path\to\a.md'   # 绕开注册表，直接试启动器
```

装完之后：

- 右键任意 `.md` → **用 Markdown Observer 阅读**（认 `.md` / `.markdown` / `.mdown` / `.mkd`，**不碰 .txt**）
- 想设成默认：右键 → 打开方式 → 选择其他应用 → Markdown Observer → 勾"始终使用此应用"。
  Windows 10 之后**不允许程序自己抢默认**（有 UserChoice 哈希保护），这一步只能由人点。
- 卸载：**设置 → 应用 → Markdown Observer → 卸载**（不用命令行，走的是 `--uninstall`）；
  开发时也可以用 `node tools/win/uninstall.mjs`。

---

## 两个模式

启动器是"配置驱动"的：它只认 `config.txt` 里的三行（`command` / `args` / `pathmap`），
所以同一份启动器能伺候两种完全不同的跑法：

| | 本机开发（现在装的这个） | 要发给别人的那份 |
|---|---|---|
| `command` | `wsl.exe` | 包里自带的 `node.exe` |
| 阅读器代码 | 仓库里这份，改完刷新就见效 | 复制一份进包里 |
| `pathmap` | `wsl`（`C:\x` → `/mnt/c/x`） | `native` |
| 前提 | 装了 WSL + node | 什么都不用装 |
| 适合 | 改代码的时候 | 发给别人 |

对外的那一份还没做。

---

## 踩过的坑（别踩第二次）

1. **`wsl.exe` 不认带引号的选项。** 参数写成 `"-l"`，它会当成"要执行的命令"扔给默认 shell，
   报 `-l: command not found`。所以启动器只在参数含空格时才加引号（`launcher.cs` 的 `QuoteAll`）。
   这个坑排查很久：直接看命令行完全正常，非要把子进程的 argv 打出来才看见。
2. **子进程的"工作目录"要挑中立的地方**，两个原因：
   · Windows 不允许它是 UNC（`\\wsl.localhost\...`），开发机上启动器恰好住在那种路径里，
     传给 `CreateProcess` 直接失败；
   · **更不能把安装目录设成工作目录**——Windows 里"进程的当前目录"会锁住那个目录，
     于是只要还有一个服务活着，卸载就会 `EACCES` 删不掉。`SafeWorkingDirectory()` 统一
     用一个本地中立目录（`%LOCALAPPDATA%`）。
3. **别拿 `%TEMP%` / `/tmp` 跨进程传东西**：WSL 的 `/tmp` 和 Windows 的 `%TEMP%` 是两回事。
   要跨进程就写进双方都看得见的目录。
4. **注册表全在 `HKCU\Software\Classes`**：当前用户，不需要管理员；卸载就是删这几个键。
5. **`.md` 的默认程序别硬抢**：`install.mjs` 只做"出现在打开方式列表 + 右键菜单"，
   默认留给用户自己点一次。硬改 UserChoice 是跟系统对着干，会被系统更新和杀软收拾。
6. **端口要固定，但必须处理"端口被自己占着"**：固定端口是为了让设置/背景图/阅读位置跟着
   origin 走（随机端口 = 每次都是新"网站" = 设置全丢）。而固定端口遇到的第一个问题就是
   "上一篇的服务还在跑"，所以 `serve.mjs` 端口被占时会先探 `/api/info`：
   是自己人就 `/api/open` 交过去，是别人就老实报错。两头都得管。
7. **"双击没反应"是最难查的故障**：服务是隐藏窗口，报错没地方看。所以启动器会盯着子进程
   1.5 秒，起不来就弹一个写清原因的框（`silent = true` 时只写日志）。
8. **关 socket 前要把请求读干净**：托盘那个小接口只读了一行就回，剩下没读完的请求数据会让 TCP
   发 RST，对方（浏览器 / PowerShell）报"远程主机强迫关闭了一个现有的连接"——响应其实已经发出去了。
   现在读到空行为止再回。
9. **"看不见的窗口"要真的看不见**：托盘拿一个隐藏 Form 当"主人窗口"，WinForms 在建句柄、往它上面
   Invoke 的时候可能真把它显示出来；而它是主窗口——用户关掉它，托盘就跟着没了。现在那个 Form 重写了
   `SetVisibleCore`（永远不显示）和 `OnFormClosing`（用户手动关不算数），双保险。
10. **`hidden` 属性会被自己的 CSS 盖掉**：浏览器默认那条 `[hidden] { display: none }` 住在浏览器样式表里，
   优先级最低，我们自己的 `.tree { display: flex }` 这种规则会把它压过去，于是 `hidden` 形同虚设。
   左侧"文件夹那一行"和"文件树"都栽在这上面（两次！），所以 styles/reader.css 里有一条全局的
   `[hidden] { display: none !important }` 一次性按死；自测里也加了一条"全页面扫一遍"的断言。
   **只检查 `.hidden` 属性是骗人的，要检查 `getComputedStyle`。**
11. **别给 DOM 元素起名叫 empty**：程序里 `.empty` 是"空状态面板"，`body[data-reading=true]` 会把它
   藏掉；新加的一行要是不小心也叫 `.empty`，就会"一打开文档就消失"。（这个是 app.js 那边的坑，
   记在这儿免得再犯。）
12. **打包格式里的"魔数"必须正好是约定的字节数**：我写了 `MDOBSETUP1`（10 个字符），读取时按
   "最后 8 字节"读——于是长度字段也跟着错位 2 字节，报出来的是**"这个 exe 里没有安装包"**，
   看起来像文件被改坏了，其实是自己数错了。现在两边都写死 8 字节的 `MDOBSET1`。
13. **.NET 的 `DeflateStream` 认的是"裸 deflate"**，而 Node 的 `zlib.deflateSync` 会多带 2 字节
   zlib 头和 Adler 校验——C# 那边一读就炸（`InvalidDataException`）。用 `deflateRawSync`。
14. **`csc.exe` 的工作目录不能在 UNC 上**：开发机的项目在 `\\wsl.localhost\...` 里，编译器会抱怨
   `CMD.EXE: UNC 路径不支持`。编译时把 `cwd` 指到一个 Windows 本地目录（比如 `%TEMP%`）。
   顺带：编译产物也先落到 `%TEMP%` 再读回来，Windows 程序往 WSL 的 UNC 路径写文件不一定被允许。
15. **网页里"没被接住的链接"= 整页被导航走 = 长连接断掉**：文档里 `[README](README.md)` 这种
   **相对 .md 链接**一开始没人处理，浏览器就自己去请求那个文件（变成"下载一个文件"），
   页面随之卸载——而服务端判断"还有没有人在看"靠的就是那条 SSE 长连接，于是它从此认为
   **没人在看**，之后每次打开都新开标签页（复用得有个页面可复用），用户看到的是
   **"设置里怎么调都没用"**。现在 `.md` 链接一律接住、在阅读器里就地打开。
   **教训：凡是"服务端靠连接数判断状态"的设计，都要问一句"这个页面有没有可能被导航走"。**
