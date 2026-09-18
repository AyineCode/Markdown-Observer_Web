#!/usr/bin/env node
/**
 * md-reader 的本地服务模式（零依赖：只用 Node 内置模块）。
 *
 * 它做三件事：
 *   1. 把阅读器自己的静态文件（index.html / styles / js / vendor）发给浏览器；
 *   2. 提供一个目录树接口，让你在左侧浏览整个文件夹里的 md；
 *   3. 提供按路径读取文件内容的接口。
 *
 * 用法：
 *   node serve.mjs                 # 服务当前目录
 *   node serve.mjs ~/notes         # 服务指定目录
 *   PORT=5000 node serve.mjs .     # 换端口（默认 4321）
 *
 * 安全：只监听 127.0.0.1（外面访问不到）；所有路径都被限制在你指定的根目录内。
 */
import { createServer } from 'node:http'
import { readFile, readdir, stat } from 'node:fs/promises'
import { dirname, extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 阅读器自己的文件所在目录（= 本文件所在目录）。 */
const APP_DIR = dirname(fileURLToPath(import.meta.url))
/** 允许浏览的根目录：命令行第一个参数，默认当前目录。 */
const ROOT = resolve(process.argv[2] ?? process.cwd())
const PORT = Number(process.env.PORT ?? 4321)
/** 认作 markdown 的扩展名。 */
const MARKDOWN_EXT = new Set(['.md', '.markdown', '.mdown', '.mkd', '.txt'])
/** 目录树里跳过的目录（避免把 node_modules 也扫出来）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', 'dist', 'build', '.venv', '__pycache__'])
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

/**
 * 把 URL 里的相对路径解析成绝对路径，并挡住"跳出根目录"的尝试。
 * @param {string} rel 相对 ROOT 的路径（已经过 URL 解码）。
 * @param {string} base 解析基准目录（默认 ROOT）。
 * @returns {string | undefined} 安全时返回绝对路径，越界返回 undefined。
 */
function safeResolve(rel, base = ROOT) {
  const target = resolve(base, rel.replace(/^[/\\]+/, ''))
  // 必须仍在 base 之内：要么等于 base，要么以 base + 分隔符开头
  if (target !== base && !target.startsWith(base + sep)) return undefined
  return target
}

/** 递归收集 markdown 文件，返回相对 ROOT 的路径数组。 */
async function collectMarkdown(dir, out = [], depth = 0) {
  if (depth > 8) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out   // 读不到的目录（权限等）直接跳过，不让整棵树失败
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue
      await collectMarkdown(full, out, depth + 1)
    } else if (entry.isFile() && MARKDOWN_EXT.has(extname(entry.name).toLowerCase())) {
      out.push(relative(ROOT, full).split(sep).join('/'))
    }
  }
  return out
}

/** 发一个 JSON 响应。 */
function json(res, status, body) {
  const text = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const pathname = decodeURIComponent(url.pathname)

  try {
    // ── 接口：阅读器用它来判断"现在是服务模式吗"
    if (pathname === '/api/info') {
      json(res, 200, { mode: 'server', root: ROOT, name: ROOT.split(sep).pop() })
      return;
    }

    // ── 接口：目录树
    if (pathname === '/api/tree') {
      const files = (await collectMarkdown(ROOT)).sort((a, b) => a.localeCompare(b, 'zh'));
      json(res, 200, { root: ROOT, files });
      return;
    }

    // ── 接口：读一个文件
    if (pathname === '/api/file') {
      const target = safeResolve(url.searchParams.get('path') ?? '');
      if (target === undefined || !MARKDOWN_EXT.has(extname(target).toLowerCase())) {
        json(res, 400, { error: '路径不合法' });
        return;
      }
      const info = await stat(target);
      const text = await readFile(target, 'utf8');
      json(res, 200, {
        path: relative(ROOT, target).split(sep).join('/'),
        name: target.split(sep).pop(),
        text,
        size: info.size,
        mtime: info.mtimeMs,
      });
      return;
    }

    // ── 接口：原样读一个文件（给文档里的相对图片用，不限于 markdown）
    if (pathname === '/api/raw') {
      const target = safeResolve(url.searchParams.get('path') ?? '');
      if (target === undefined) {
        json(res, 400, { error: '路径不合法' });
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

    // ── 静态文件：/ 映射到 index.html
    const rel = pathname === '/' ? 'index.html' : pathname;
    const target = safeResolve(rel, APP_DIR);
    if (target === undefined) {
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

server.listen(PORT, '127.0.0.1', () => {
  console.log('md-reader（服务模式）');
  console.log('  文档根目录：' + ROOT);
  console.log('  打开：http://127.0.0.1:' + PORT + '/');
  console.log('  Ctrl-C 结束');
});
