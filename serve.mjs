#!/usr/bin/env node
/**
 * md-reader 的本地服务（零依赖：只用 Node 内置模块）。
 *
 * 它干四件事：
 *   1. 把阅读器自己的静态文件（index.html / styles / js / vendor）发给浏览器；
 *   2. 目录形态下提供目录树，让你在左侧浏览一个文件夹里的 md；
 *   3. 按路径读正文与图片；
 *   4. 常驻，并且能把"打开这一篇"推给已经开着的页面（SSE）。
 *
 * 用法：
 *   node serve.mjs                       # 目录形态：服务当前目录，左侧有文件树
 *   node serve.mjs ~/notes               # 目录形态：服务指定目录
 *   node serve.mjs --file ~/notes/a.md   # 单篇形态：左侧只列"打开的文档"，不显示文件树
 *   node serve.mjs --file a.md --open    # 起好之后自动打开浏览器
 *   node serve.mjs --port 0              # 端口（默认 47821；0 = 让系统随便挑）
 *   node serve.mjs --idle 600            # 可选：没人访问 600 秒就自己退出（默认永不退出）
 *
 * 安全（三件事，都别拆）：
 *   · 只监听 127.0.0.1——外面访问不到；
 *   · 文件访问走**白名单**：只读"被打开过的文件所在的目录"，不是整个硬盘；
 *   · 校验 Host 头，挡住 DNS rebinding 那种"网页偷偷读你本地服务"的花招。
 */
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { readFile, readdir, stat } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'

/** 阅读器自己的文件所在目录（= 本文件所在目录）。 */
const APP_DIR = dirname(fileURLToPath(import.meta.url))

/** 阅读器默认端口。固定端口是有意的：浏览器的设置/背景图是按"源"（含端口）存的，
 *  端口一变，用户就会觉得"我的设置全没了"。 */
const DEFAULT_PORT = 47821

/** 解析命令行：位置参数是文档目录，其余是可选项。 */
function parseArgs(argv) {
  const out = {
    root: null, port: Number(process.env.PORT ?? DEFAULT_PORT), quiet: false,
    file: null, open: false, idle: 0, prefs: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--port' || arg === '-p') { out.port = Number(argv[i + 1]); i += 1; continue }
    if (arg === '--quiet' || arg === '-q') { out.quiet = true; continue }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
    if (arg === '--file' || arg === '-f') { out.file = argv[i + 1]; i += 1; continue }
    if (arg === '--open' || arg === '-o') { out.open = true; continue }
    if (arg === '--idle') { out.idle = Number(argv[i + 1]); i += 1; continue }
    if (arg === '--prefs') { out.prefs = argv[i + 1]; i += 1; continue }
    // 自动化测试 / 由别的程序负责开浏览器时用：只把地址打出来，不真的去开
    if (arg === '--no-browser') { out.noBrowser = true; continue }
    if (arg.startsWith('-')) continue;
    if (out.root === null) out.root = arg;
  }
  return out;
}

const OPTIONS = parseArgs(process.argv.slice(2));
if (OPTIONS.help === true) {
  console.log('usage: node serve.mjs [folder] [--port 47821] [--quiet] [--open]');
  console.log('       node serve.mjs --file <some.md> [--open] [--idle seconds]');
  process.exit(0);
}

/**
 * 形态：
 *   'file'   —— 启动时给了 --file（Windows"打开方式"双击起来的就是这个）。
 *               左侧只列"打开的文档"，不显示文件树，也不显示当前文件夹。
 *   'folder' —— 启动时给的是一个目录。左侧显示文件树与根目录名。
 */
const INITIAL_SHAPE = OPTIONS.file === null || OPTIONS.file === undefined ? 'folder' : 'file'
const INITIAL_FILE = INITIAL_SHAPE === 'file' ? resolve(OPTIONS.file) : null
if (INITIAL_FILE !== null && !existsSync(INITIAL_FILE)) {
  console.error('file not found: ' + INITIAL_FILE)
  process.exit(1)
}
/**
 * 当前形态。可以在运行中变：
 *   网页里点"打开文件夹" → 服务端弹原生选择框 → 拿到真实路径 → 切成 folder 形态去扫（比浏览器自己读快得多）。
 */
let shape = INITIAL_SHAPE
/** 目录形态下的根目录（网页打开文件夹时会被换掉）。 */
let folderRoot = INITIAL_SHAPE === 'folder' ? resolve(OPTIONS.root ?? process.cwd()) : dirname(INITIAL_FILE)
const PORT = OPTIONS.port
/** 多久没人访问就自己退出（毫秒）。默认 0 = 永不退出：双击起来的服务是"总管后台"，该一直待着。 */
const IDLE_MS = Number(OPTIONS.idle ?? 0) * 1000
/** 最近一次收到请求的时间（只有配了 --idle 才有用）。 */
let lastActivity = Date.now()
/** 真正监听的端口（--port 0 时由系统分配，listen 之后才知道）。 */
let actualPort = PORT
/** 最近一次被要求打开的文档（status.mjs 靠它报"现在在读哪篇"）。 */
let lastOpened = null

/**
 * 允许访问的目录白名单。
 * 每打开一个文件，就把它所在的目录加进来——不是整块硬盘都敞开。
 * 这是"这个服务能被网页指挥着读什么"的唯一围栏，别绕过它。
 */
const ROOTS = []
/** 把一个目录加进白名单（已经在里面、或者被某个已有的目录包住，就复用）。 */
function allow(dir) {
  const target = resolve(dir)
  if (ROOTS.includes(target)) return target
  ROOTS.push(target)
  return target
}
/** 这个绝对路径在白名单里吗？ */
function isAllowed(full) {
  return ROOTS.some((root) => full === root || full.startsWith(root + sep))
}
allow(folderRoot)

/**
 * 网页那边一律用"正斜杠的绝对路径"说话（Windows 上也写成 C:/notes/a.md），
 * 这样客户端不用关心平台差异，服务端自己转。
 */
const toWire = (p) => p.split(sep).join('/')
/** 反过来：把网页给的正斜杠路径还原成本机路径（resolve 会顺手消掉 .. 和 .）。 */
const fromWire = (p) => resolve(p)

/** 认作 markdown 的扩展名。 */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])
/** 默认跳过的目录名（用户可以在设置的"高级"里改，存在偏好里）。 */
const DEFAULT_SKIP_DIRS = ['node_modules', '.git', '.cache', 'dist', 'build', 'out', 'vendor', '.venv', 'venv', '__pycache__']
/** 扫描上限：误点了一个巨大（或很深）的文件夹时，别把界面拖死，列到上限就停并标记 capped。 */
const MAX_TREE_FILES = 5000
const MAX_TREE_MS = 4000
/** 静态文件允许的扩展名 → content-type。 */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.woff2': 'font/woff2',
}

// ── 偏好设置：和浏览器里那份分开，因为"双击时要不要新开标签页"是**服务**要用的 ──
const PREFS_PATH = OPTIONS.prefs ?? join(homedir(), '.markdown-observer', 'prefs.json')
//  openMode  = reuse（复用已开着的阅读器页面）| tab（每次新开标签页）
//  skipDirs  = 扫描时跳过的目录名（设置 → 行为 → 高级 里可改）
let PREFS = { openMode: 'reuse', skipDirs: DEFAULT_SKIP_DIRS.slice() }
try {
  const saved = JSON.parse(readFileSync(PREFS_PATH, 'utf8'))
  if (saved !== null && typeof saved === 'object') PREFS = Object.assign(PREFS, saved)
} catch {
  // 没有 / 读坏了都用默认值，不值得打断启动
}
function savePrefs() {
  try {
    mkdirSync(dirname(PREFS_PATH), { recursive: true })
    writeFileSync(PREFS_PATH, JSON.stringify(PREFS, null, 2) + '\n', 'utf8')
  } catch {
    // 存不下就只在内存里生效
  }
}

/**
 * 递归收集 markdown 文件（绝对路径，正斜杠）。
 * @param {string} dir 从哪个目录开始
 * @returns {Promise<{ files: string[], capped: boolean }>} capped = 撞到上限提前收手了
 */
async function collectMarkdown(dir) {
  const skip = new Set(Array.isArray(PREFS.skipDirs) ? PREFS.skipDirs : DEFAULT_SKIP_DIRS)
  const files = []
  const startedAt = Date.now()
  let capped = false

  /** @param {string} current @param {number} depth */
  async function walk(current, depth) {
    if (capped || depth > 8) return
    if (files.length >= MAX_TREE_FILES || Date.now() - startedAt > MAX_TREE_MS) {
      capped = true
      return
    }
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return   // 读不到的目录（权限等）直接跳过，不让整棵树失败
    }
    for (const entry of entries) {
      if (capped) return
      if (entry.name.startsWith('.')) continue
      const full = join(current, entry.name)
      if (entry.isDirectory()) {
        if (skip.has(entry.name)) continue
        await walk(full, depth + 1)
      } else if (entry.isFile() && MARKDOWN_EXT.has(extname(entry.name).toLowerCase())) {
        files.push(toWire(full))
        if (files.length >= MAX_TREE_FILES) { capped = true; return }
      }
    }
  }

  await walk(dir, 0)
  return { files, capped }
}

/** 发一个 JSON 响应。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

/**
 * 正在监听"打开这一篇"的页面（SSE 长连接）。
 * 它同时是"页面还开着吗"的答案：有人连着 → 复用这个页面；没人连着 → 开一个新标签页。
 */
const LISTENERS = new Set()
/** 把一条消息推给所有开着的页面。 */
function broadcast(payload) {
  const text = 'data: ' + JSON.stringify(payload) + '\n\n'
  for (const res of LISTENERS) {
    try { res.write(text) } catch { LISTENERS.delete(res) }
  }
}

/** 阅读器页面的地址（带上要打开的那一篇）。 */
function pageUrl(filePath) {
  const query = filePath === undefined ? '' : '?file=' + encodeURIComponent(filePath)
  return 'http://127.0.0.1:' + actualPort + '/' + query
}

/**
 * 打开一篇文档：授权它所在的目录 → 有人看着就推过去，没人看就开一个浏览器标签页。
 * @param {string} filePath 绝对路径（本机写法）
 */
function openDocument(filePath) {
  const target = resolve(filePath)
  if (!existsSync(target)) return { error: '找不到这个文件：' + target }
  allow(dirname(target))
  lastOpened = target
  const doc = { path: toWire(target), name: basename(target) }
  const reuse = PREFS.openMode !== 'tab' && LISTENERS.size > 0
  if (reuse) broadcast({ type: 'open', doc })
  else openBrowser(pageUrl(toWire(target)))
  return { ok: true, mode: reuse ? 'reuse' : 'tab', doc, listeners: LISTENERS.size }
}

/**
 * 把一个目录加进白名单（**不**换当前根目录）。
 * 托盘"开一个新工作区"用这个：新页面认它自己那个 root，不许动别人。
 * @param {string} target 绝对路径
 * @returns {{ok?: boolean, name?: string, root?: string, error?: string}}
 */
function allowFolder(target) {
  let info
  try {
    info = statSync(target)
  } catch {
    return { error: '找不到这个文件夹：' + target }
  }
  if (!info.isDirectory()) return { error: '这不是一个文件夹：' + target }
  allow(target)
  return { ok: true, name: basename(target), root: toWire(target) }
}



/**
 * 请求是不是冲着"本机的这个服务"来的？
 * 浏览器连 127.0.0.1 时 Host 必然是 127.0.0.1:端口；被 DNS rebinding 骗来的请求
 * Host 会是攻击者的域名——那种一律拒绝。
 */
function hostOk(req) {
  const host = req.headers.host
  if (typeof host !== 'string') return false
  const name = host.split(':')[0]
  return name === '127.0.0.1' || name === 'localhost' || name === '[::1]'
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = decodeURIComponent(url.pathname)
  lastActivity = Date.now()   // 任何请求都算"还有人在这儿"

  try {
    if (!hostOk(req)) {
      res.writeHead(403, { 'content-type': 'text/plain; charset=utf-8' }).end('forbidden');
      return;
    }

    // ── 接口：页面报平安（现在主要给不支持 SSE 的环境兜底）
    if (pathname === '/api/ping') {
      json(res, 200, { ok: true, listeners: LISTENERS.size })
      return;
    }

    // ── 接口：阅读器用它来了解"现在是什么形态、根目录叫什么"
    if (pathname === '/api/info') {
      json(res, 200, {
        mode: 'server',
        shape,
        name: basename(shape === 'folder' ? folderRoot : dirname(INITIAL_FILE)),
        roots: ROOTS.map(toWire),
        openMode: PREFS.openMode,
        skipDirs: PREFS.skipDirs,
        file: INITIAL_FILE === null ? null : toWire(INITIAL_FILE),
        lastOpened: lastOpened === null ? null : toWire(lastOpened),
      })
      return;
    }

    // ── 接口：目录树。单篇形态本来没有树（返回空表）；
    //    但带了 ?root= 就是"另一个工作区"（托盘开的那个新页面），照常扫。
    if (pathname === '/api/tree') {
      const wanted = url.searchParams.get('root');
      const hasRoot = wanted !== null && wanted !== '';
      if (shape === 'file' && !hasRoot) {
        json(res, 200, { root: toWire(folderRoot), files: [], capped: false })
        return;
      }
      const target = hasRoot ? fromWire(wanted) : folderRoot;
      if (!isAllowed(target)) {
        json(res, 400, { error: '这个目录不在允许列表里' });
        return;
      }
      const scan = await collectMarkdown(target);
      json(res, 200, {
        root: toWire(target),
        files: scan.files.sort((a, b) => a.localeCompare(b, 'zh')),
        capped: scan.capped,
      })
      return;
    }

    // ── 接口：把某个文件夹变成"当前打开的文件夹"（左侧那棵树扫它）
    if (pathname === '/api/root') {
      // 只做一件事：把这个目录加进允许列表。**不动**任何"当前根目录"——
      // 工作区是每个页面自己的事（地址栏里的 ?root=），谁也不许改别人的。
      const result = allowFolder(fromWire(url.searchParams.get('path') ?? ''));
      json(res, result.error === undefined ? 200 : 400, result)
      return;
    }

    // ── 接口：打开一篇（启动器/托盘双击时调它）
    if (pathname === '/api/open') {
      const result = openDocument(fromWire(url.searchParams.get('path') ?? ''));
      json(res, result.error === undefined ? 200 : 404, result);
      return;
    }

    // ── 接口：读一个文件（正文）
    if (pathname === '/api/file') {
      const target = fromWire(url.searchParams.get('path') ?? '');
      if (!isAllowed(target) || !MARKDOWN_EXT.has(extname(target).toLowerCase())) {
        json(res, 400, { error: '路径不合法（不在允许的目录里）' });
        return;
      }
      const info = await stat(target);
      const text = await readFile(target, 'utf8');
      json(res, 200, {
        path: toWire(target),
        name: basename(target),
        text,
        size: info.size,
        mtime: info.mtimeMs,
      });
      return;
    }

    // ── 接口：原样读一个文件（给文档里的相对图片用，不限于 markdown）
    if (pathname === '/api/raw') {
      const target = fromWire(url.searchParams.get('path') ?? '');
      if (!isAllowed(target)) {
        json(res, 400, { error: '路径不合法（不在允许的目录里）' });
        return;
      }
      const body = await readFile(target);
      res.writeHead(200, {
        'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
        'cache-control': 'no-cache',
      });
      res.end(body);
      return;
    }

    // ── 接口：让服务自己退出（托盘菜单的"退出"、status.mjs --stop 都用它）
    if (pathname === '/api/quit') {
      json(res, 200, { ok: true });
      setTimeout(() => {
        server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 500).unref();
      }, 50);
      return;
    }

    // ── 接口：偏好设置。openMode: reuse（复用开着的页面）| tab（每次新开标签页）
    if (pathname === '/api/pref') {
      if (req.method === 'POST') {
        let body = '';
        for await (const chunk of req) body += chunk;
        try {
          const patch = JSON.parse(body === '' ? '{}' : body);
          if (patch.openMode === 'reuse' || patch.openMode === 'tab') PREFS.openMode = patch.openMode;
          if (Array.isArray(patch.skipDirs)) {
            PREFS.skipDirs = patch.skipDirs.map((name) => String(name).trim()).filter((name) => name.length > 0);
          }
          savePrefs();
        } catch {
          json(res, 400, { error: '看不懂这份设置' });
          return;
        }
      }
      json(res, 200, PREFS);
      return;
    }

    // ── 接口：长连接。页面挂着它 = "我还开着"，服务有新文档就顺着它推过去
    if (pathname === '/api/events') {
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-store',
        connection: 'keep-alive',
      });
      res.write(': connected\n\n');
      LISTENERS.add(res);
      req.on('close', () => { LISTENERS.delete(res) });
      return;
    }

    // ── 静态文件：/ 映射到 index.html
    const rel = pathname === '/' ? 'index.html' : pathname;
    const target = resolve(APP_DIR, rel.replace(/^[/\\]+/, ''));
    if (target !== APP_DIR && !target.startsWith(APP_DIR + sep)) {
      res.writeHead(403).end('forbidden');
      return;
    }
    const body = await readFile(target);
    res.writeHead(200, {
      'content-type': TYPES[extname(target).toLowerCase()] ?? 'application/octet-stream',
      // 开发期方便：改完刷新就生效
      'cache-control': 'no-cache',
    });
    res.end(body);
  } catch (error) {
    const code = error && error.code === 'ENOENT' ? 404 : 500;
    res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(code === 404 ? 'not found' : 'server error: ' + String(error && error.message));
  }
});

server.on('error', (error) => {
  if (error !== null && error.code === 'EADDRINUSE') {
    void attachToRunning();
    return;
  }
  throw error;
});

/** 问一句"这个端口上是不是我们的服务"。 */
async function probeRunning() {
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/info', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body !== null && body.mode === 'server' ? body : null;
  } catch {
    return null;
  }
}

/**
 * 端口已经被占了。分两种情况：
 *   · 占着它的是**我们自己**的服务（常驻后台）→ 把这篇交给它，本进程退出。
 *     这就是"双击第二篇"能被复用的地方：不再起第二个服务，也不会报错。
 *   · 是别的程序 → 老实说清楚，让用户换端口。
 */
async function attachToRunning() {
  const running = await probeRunning();
  if (running === null) {
    console.error('Port ' + PORT + ' is taken by another program. Try another port, for example:');
    console.error('  node serve.mjs --port ' + (PORT + 1));
    process.exit(1);
  }
  if (INITIAL_FILE === null) {
    console.error('A Markdown Observer service is already running (port ' + PORT + ', shape ' + running.shape + ').');
    process.exit(0);
  }
  try {
    const res = await fetch('http://127.0.0.1:' + PORT + '/api/open?path=' + encodeURIComponent(toWire(INITIAL_FILE)));
    const data = await res.json();
    if (OPTIONS.quiet !== true) {
      console.log('handed to the running service: ' + (data.mode === 'reuse' ? 'reuse the open page' : 'open a new tab'));
    }
    process.exit(0);
  } catch (error) {
    console.error('could not hand the file to the running service: ' + String(error && error.message));
    process.exit(1);
  }
}

/** 是不是跑在 WSL 里（那时要用 Windows 侧的浏览器打开）。 */
function isWsl() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME !== undefined) return true;
  try {
    return readFileSync('/proc/version', 'utf8').toLowerCase().includes('microsoft');
  } catch {
    return false;
  }
}

/**
 * 用系统默认浏览器打开一个地址。按平台依次尝试几种办法，第一个真正起来的算成功。
 * 全部失败只提示一句，不影响服务本身——用户手动访问地址一样能读。
 * @param {string} url 要打开的地址
 */
function openBrowser(url) {
  if (OPTIONS.noBrowser === true) {
    console.log('(--no-browser) would have opened: ' + url);
    return;
  }
  // 优先用 rundll32 直接 ShellExecute 那个网址：不经过 cmd，URL 里的 %2F 之类不会被
  // cmd 的变量展开碰坏（cmd /c start 是常见做法，但拿 % 没办法）。后两个是兜底。
  const viaCmd = ['cmd.exe', ['/c', 'start', url]];
  const chain = process.platform === 'win32'
    ? [['rundll32', ['url.dll,FileProtocolHandler', url]], viaCmd]
    : process.platform === 'darwin'
      ? [['open', [url]]]
      : isWsl()
        ? [['wslview', [url]], ['rundll32', ['url.dll,FileProtocolHandler', url]], viaCmd, ['explorer.exe', [url]]]
        : [['xdg-open', [url]]];
  let index = 0;
  const attempt = () => {
    if (index >= chain.length) {
      console.error('could not open a browser automatically; please visit: ' + url);
      return;
    }
    const [command, args] = chain[index];
    index += 1;
    let child;
    try {
      child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true });
    } catch {
      attempt();
      return;
    }
    child.on('error', () => attempt());   // 这个命令不存在 → 试下一个
    child.on('spawn', () => child.unref());
  };
  attempt();
}

server.listen(PORT, '127.0.0.1', () => {
  actualPort = server.address().port;
  const url = 'http://127.0.0.1:' + actualPort + '/';
  if (OPTIONS.quiet !== true) {
    console.log('Markdown Observer (server mode)');
    if (INITIAL_FILE !== null) console.log('  document   : ' + INITIAL_FILE);
    console.log('  allowed dirs: ' + ROOTS.join(', '));
    console.log('  open: ' + url);
    console.log('  Ctrl-C to stop');
  }
  if (OPTIONS.open === true) openBrowser(pageUrl(INITIAL_FILE === null ? undefined : toWire(INITIAL_FILE)));

  // 空闲退出：默认关（常驻服务该一直待着）。只有显式给了 --idle 才启用。
  if (IDLE_MS > 0) {
    const every = Math.min(2000, Math.max(500, Math.round(IDLE_MS / 4)));
    setInterval(() => {
      if (Date.now() - lastActivity < IDLE_MS) return;
      if (OPTIONS.quiet !== true) console.log('no requests for ' + Math.round(IDLE_MS / 1000) + ' seconds, exiting.');
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 1000).unref();
    }, every).unref();
  }
});
