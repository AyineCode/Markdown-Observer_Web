#!/usr/bin/env node
/**
 * 把整个阅读器打包成一个自包含的 HTML 文件。
 *
 * 为什么需要它：发给不懂计算机的朋友时，"一个文件、双击就开"比"解压一个文件夹、
 * 里面还要找 index.html"友好得多，也不会因为路径/丢文件而失败。
 *
 * 做法：把 <link> 的样式表与 <script src> 的脚本全部内联进 HTML；KaTeX 的字体
 * （math 公式用的 woff2）转成 data URL 一起塞进去。产物断网可用、不依赖任何外部请求。
 *
 * 跑法：node tools/build-standalone.mjs
 */
import { readFileSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = dirname(dirname(fileURLToPath(import.meta.url)))
export const OUT_NAME = 'markdown-observer.html'

/** 读一个相对 APP 的文件。 */
const read = (rel) => readFileSync(join(APP, rel), 'utf8')

/**
 * 把 KaTeX CSS 里的字体换成本地 data URL。
 *
 * 这里按整个 src 声明来重建，而不是逐个替换 url()：KaTeX 每个字体会写三条回退
 * （woff2 / woff / ttf），我们只随包提供 woff2，所以要连 format(...) 一起丢掉，
 * 否则单文件版会为不存在的字体发请求，还会留下悬空的逗号。
 *
 * ⚠️ 两个字符都不能少：src 列表要用 `[^;}]+ `停在分号**或右花括号**上。
 * KaTeX 里 src 就是整条规则的最后一项、后面没有分号，只用 `[^;]+` 会一路吃进
 * 右花括号和**下一条 @font-face 的开头**，结果是 20 条字体规则塌成 2 条、
 * 公式只好用回退字体——"开发页好好的、打包出来不对"就是这么来的。
 * @param {string} css katex.min.css 的内容
 * @returns {string} 字体已内联的 CSS
 */
function inlineKatexFonts(css) {
  const before = (css.match(/@font-face/g) ?? []).length;
  const out = css.replace(/src:\s*([^;}]+)(;?)/g, (whole, list, semicolon) => {
    const kept = [];
    for (const entry of list.split(',')) {
      const match = /url\(\s*(['"]?)fonts\/([^'")]+)\1\s*\)(\s*format\([^)]*\))?/.exec(entry);
      if (match === null) { kept.push(entry.trim()); continue }
      const file = match[2];
      try {
        const data = readFileSync(join(APP, 'vendor', 'fonts', file));
        const type = file.endsWith('.woff2') ? 'font/woff2' : (file.endsWith('.woff') ? 'font/woff' : 'font/ttf');
        kept.push('url(data:' + type + ';base64,' + data.toString('base64') + ')' + (match[3] || ''));
      } catch {
        // 这个格式的文件没随包提供：整条丢掉（浏览器会用剩下的那条）
      }
    }
    return 'src: ' + kept.join(', ') + semicolon;
  });
  // 构建期就把话说死：字体规则的条数不能变、里面不能再引用外部字体文件
  const after = (out.match(/@font-face/g) ?? []).length;
  const external = (out.match(/url\(\s*['"]?fonts\//g) ?? []).length;
  if (after !== before || external !== 0) {
    throw new Error('内联字体时破坏了 CSS：@font-face ' + before + ' → ' + after + '，仍有 ' + external + ' 处引用外部字体');
  }
  return out;
}

/**
 * 生成单文件版本。
 * @returns {{ path: string, bytes: number }} 产物路径与大小
 */
export function buildStandalone() {
  let html = read('index.html');

  // ① 样式表 → <style>
  html = html.replace(/<link rel="stylesheet" href="([^"]+)">/g, (whole, href) => {
    const rel = href.replace(/^\.\//, '');
    const css = rel === 'vendor/katex.min.css' ? inlineKatexFonts(read(rel)) : read(rel);
    return '<style>\n/* ' + rel + ' */\n' + css + '\n</style>';
  });

  // ② 脚本 → <script>（顺便把 </script 转义，免得脚本文本里恰好出现它就截断了标签）
  html = html.replace(/<script src="([^"]+)"><\/script>/g, (whole, src) => {
    const rel = src.replace(/^\.\//, '');
    const code = read(rel).replace(/<\/script/gi, '<\\/script');
    return '<script>\n/* ' + rel + ' */\n' + code + '\n</script>';
  });

  // ③ 标记来源（方便日后一眼看出这是构建产物）
  html = html.replace('<head>', '<head>\n  <!-- 由 tools/build-standalone.mjs 生成：所有样式、脚本与字体都已内联，可单文件分发。 -->');

  const path = join(APP, OUT_NAME);
  writeFileSync(path, html);
  return { path, bytes: statSync(path).size };
}

// 直接运行时打印结果
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildStandalone();
  console.log('已生成：' + result.path);
  console.log('大小：' + Math.round(result.bytes / 1024) + ' KB（单文件、断网可用、不需要安装任何东西）');
}
