#!/usr/bin/env node
/**
 * 生成"分享包"：发给不懂计算机的朋友的那一份。
 *
 * 产物（默认在 share/ 目录里，文件名英文、内容中文）：
 *   markdown-observer-v<版本>.html  单文件阅读器，双击即用，不需要装任何东西
 *   HOW-TO-OPEN.txt       五行说明，不用命令行
 *   sample.md             让朋友有东西可以马上试
 *
 * 只负责"生成这个文件夹"；要打成一个 zip 发人，跑 node tools/release.mjs（那边是零依赖的打包）。
 *
 * 跑法：node tools/build-share.mjs
 */
import { chmodSync, copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildStandalone, OUT_NAME } from './build-standalone.mjs'

const APP = dirname(dirname(fileURLToPath(import.meta.url)))
const OUT_DIR = join(APP, 'build', 'share')

/** 给朋友看的说明：不用任何术语，五行讲完。 */
const NOTE = [
  'Markdown Observer · 使用说明',
  '',
  '1. 双击「' + OUT_NAME + '」就能打开（推荐用 Chrome 或 Edge 浏览器）。',
  '2. 把 .md 文件拖进窗口，或者点中间那张「打开文件」的卡片。',
  '3. 想看一整个文件夹里的文档：点「打开文件夹」（子目录会一起读，任何浏览器都行）；',
  '   打开之后，左侧「文档」区里就是这棵目录树。',
  '4. 右上角可以换深浅色、换背景、调字号；左侧是文件列表、打开的文档和本篇目录。',
  '5. 想打印或存成 PDF：按 Ctrl+P。',
  '',
  '不需要安装任何东西；文件只在你自己的电脑上打开，不会上传到任何地方。',
  '',
].join('\n')

/**
 * 生成分享包。
 * @returns {{ dir: string, zip: string | null, bytes: number }} 产物信息
 */
export function buildShare() {
  const standalone = buildStandalone();
  rmSync(OUT_DIR, { recursive: true, force: true });
  mkdirSync(OUT_DIR, { recursive: true });

  copyFileSync(join(APP, 'build', 'standalone', OUT_NAME), join(OUT_DIR, OUT_NAME));
  writeFileSync(join(OUT_DIR, 'HOW-TO-OPEN.txt'), NOTE);
  if (existsSync(join(APP, 'sample.md'))) {
    copyFileSync(join(APP, 'sample.md'), join(OUT_DIR, 'sample.md'));
  }
  // 复制过来的文件会带上原文件的权限（示例文档在本机是 600）。发给别人的东西一律放宽成可读，
  // 否则对方解压后可能打不开。
  for (const name of [OUT_NAME, 'HOW-TO-OPEN.txt', 'sample.md']) {
    try { chmodSync(join(OUT_DIR, name), 0o644) } catch { /* 某些文件系统不支持，不影响使用 */ }
  }

  return { dir: OUT_DIR, bytes: standalone.bytes };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = buildShare();
  console.log('分享包已生成：' + result.dir);
  console.log('  阅读器：' + Math.round(result.bytes / 1024) + ' KB（单文件）');
  console.log('  说明：HOW-TO-OPEN.txt（给朋友看的，内容中文）');
  console.log('  要发人：node tools/release.mjs（打成 markdown-observer-v<版本>.zip）');
}
