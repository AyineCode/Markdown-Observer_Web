/**
 * check-styles.mjs —— 两项静态校验（不需要浏览器）：
 *
 *   1. 保真度：styles/markdown.css 里的每条声明，是否都能在 dsh 的原文件里找到。
 *      （只比对"属性: 值"，类名改写不算差异——CSS Modules 的哈希类名本来就搬不过来）
 *   2. CSS 变量：所有 var(--x) 引用是否都有定义（含 JS 运行时写入的那几个，和 tuning.css 里的出口子）。
 *
 * 跑法：node tools/check-styles.mjs
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const APP = dirname(dirname(fileURLToPath(import.meta.url)));
const DSH = process.env.DSH_CHECKOUT ?? fileURLToPath(new URL('../../deepseek-harness-ayine/', import.meta.url));

let failures = 0;
function fail(message) { failures += 1; console.log('  FAIL ' + message) }

/**
 * 抽出所有 `属性: 值` 对。
 * 按"规则块"解析而不是全文正则，这样能按选择器跳过有意不搬的部分。
 * @param {string} css 样式表内容
 * @param {(selector: string) => boolean} skip 返回 true 的规则整块跳过
 * @returns {Set<string>} 形如 `property: value` 的集合
 */
function declarations(css, skip = () => false) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out = new Set();
  const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
  let rule;
  while ((rule = ruleRe.exec(clean)) !== null) {
    const selector = rule[1].trim();
    if (skip(selector)) continue;
    const bodyRe = /([-a-zA-Z]+)\s*:\s*([^;{}]+);?/g;
    let m;
    while ((m = bodyRe.exec(rule[2])) !== null) {
      const prop = m[1].trim().toLowerCase();
      const value = m[2].replace(/\s+/g, ' ').trim();
      if (prop === '' || value === '') continue;
      out.add(prop + ': ' + value);
    }
  }
  return out;
}

console.log('1) 保真度：markdown.css 是否覆盖了 dsh 原样式表的每条声明');
const originals = [
  'packages/client/ui-primitives/src/markdown/MarkdownText.module.css',
  'packages/client/ui-primitives/src/markdown/CodeBlock.module.css',
];
const mine = declarations(readFileSync(join(APP, 'styles', 'markdown.css'), 'utf8'));
let checked = 0;
let missingDecl = 0;
// .fileMention 是 dsh 聊天专有的"文件提及"按钮，阅读器没有这个功能，整块不搬。
const skipRule = (selector) => selector.includes('fileMention');
for (const rel of originals) {
  const source = readFileSync(join(DSH, rel), 'utf8');
  for (const decl of declarations(source, skipRule)) {
    checked += 1;
    if (!mine.has(decl)) { missingDecl += 1; fail(rel.split('/').pop() + ' 里的声明没搬过来: ' + decl); }
  }
}
console.log('  比对了 ' + checked + ' 条声明，缺失 ' + missingDecl + ' 条');

console.log('2) CSS 变量：有没有引用未定义的 --变量');
const sheets = [
  'styles/base.css', 'styles/design-platform.css', 'styles/scrollbar.css',
  'styles/gradient-shadow-text.css', 'styles/shiki.css', 'styles/markdown.css',
  'styles/highlight-dsh.css', 'styles/reader.css', 'styles/controls.css',
  // 最后一层覆盖表：只是给上面几张表里的尺寸开出口子，不参与保真度比对
  'styles/tuning.css',
];
const defined = new Set();
const used = new Map();
for (const rel of sheets) {
  // 先去掉注释：注释里出现的 --token-* 通配写法不该被当成变量引用
  const css = readFileSync(join(APP, rel), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  let m;
  const defRe = /(--[a-zA-Z0-9-]+)\s*:/g;
  while ((m = defRe.exec(css)) !== null) defined.add(m[1]);
  const useRe = /var\(\s*(--[a-zA-Z0-9-]+)/g;
  while ((m = useRe.exec(css)) !== null) {
    if (!used.has(m[1])) used.set(m[1], rel);
  }
}
// 这几个由 JS 在运行时写到 html/body 上，或者由浏览器提供
// 这几个由 JS 在运行时写到 html 上（不在任何样式表里定义）
const runtime = new Set(['--bg-image', '--docs-pane-max']);
let missing = 0;
for (const [name, where] of used) {
  if (defined.has(name) || runtime.has(name)) continue;
  missing += 1;
  fail('未定义的变量 ' + name + '（用在 ' + where + '）');
}
console.log('  引用了 ' + used.size + ' 个变量，未定义 ' + missing + ' 个');

console.log('');
console.log(failures === 0 ? '全部通过' : '有 ' + failures + ' 项失败');
process.exit(failures === 0 ? 0 : 1);
