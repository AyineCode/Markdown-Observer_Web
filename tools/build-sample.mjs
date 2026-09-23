#!/usr/bin/env node
/**
 * 把 sample.md 打包成 sample.js（window.__SAMPLE_MD__）。
 *
 * 为什么需要这一步：静态模式是 file:// 打开的，浏览器不允许 fetch 本地文件，
 * 所以示例文档只能以 <script> 的形式带进来。改了 sample.md 后重新跑一次本脚本即可：
 *   node tools/build-sample.mjs
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const dir = dirname(dirname(fileURLToPath(import.meta.url)))
const md = readFileSync(join(dir, 'sample.md'), 'utf8')
const banner = [
  '/* 本文件由 tools/build-sample.mjs 从 sample.md 生成，请不要直接编辑。 */',
].join('\n')
writeFileSync(join(dir, 'js', 'sample.js'), banner + '\n' + 'window.__SAMPLE_MD__ = ' + JSON.stringify(md) + ';\n')
console.log('sample.js 已更新（' + md.length + ' 字符）')
