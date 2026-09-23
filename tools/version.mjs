/*
  version.mjs —— 版本号的**唯一来源**。

  规矩（DEVELOPING.md 里也写着）：版本号只来自 **git tag**（tag 叫 v1.0.0 → 版本就是 1.0.0）。
  不额外维护 VERSION 文件、也不写死在代码里——tag 本身就是"发布这件事"。

  谁在用：单文件 HTML 的名字、分享包、发布 zip、Windows 安装包的名字、
  安装包判断"更新还是修复"、以及"设置 → 应用"里显示的版本号。
  全都从这一个函数取，就不会出现"zip 里写 1.0.0、安装包说 1.0.1"这种对不上的情况。

  用法：
    import { readVersion, versionTag } from './version.mjs'
    node tools/version.mjs                 # 直接打印当前版本（排查用）
    MD_OBSERVER_VERSION=1.2.3 node ...     # 临时顶掉（打包测试用，不改仓库状态）
*/
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const APP = dirname(dirname(fileURLToPath(import.meta.url)))

/** 最近的那个 tag（去掉 v 前缀）；没有就 null。 */
function lastTag() {
  try {
    const tag = execFileSync('git', ['describe', '--tags', '--abbrev=0'], {
      cwd: APP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return tag === '' ? null : tag.replace(/^v/, '')
  } catch {
    return null   // 不是 git 仓库（比如别人下载的源码 zip），或者一个 tag 都还没有
  }
}

/** HEAD 是不是正好落在某个 tag 上。 */
function onExactTag() {
  try {
    execFileSync('git', ['describe', '--tags', '--exact-match'], {
      cwd: APP,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

/**
 * 当前版本：
 *   · HEAD 正好在 tag 上        → 1.0.0        （正式发布）
 *   · tag 之后还有提交          → 1.0.0-dev    （一眼看出不是发布版，别发出去）
 *   · 取不到（没 tag / 非仓库）  → 0.0.0-dev
 */
export function readVersion() {
  const override = process.env.MD_OBSERVER_VERSION
  if (override !== undefined && override !== '') return override.replace(/^v/, '')
  const tag = lastTag()
  if (tag !== null) return onExactTag() ? tag : tag + '-dev'
  // 不是 git 仓库（比如别人下载的源码 zip）：退回 VERSION 文件。
  // 那个文件是**生成出来的**（node tools/version.mjs --write），别手动改。
  const file = join(APP, 'VERSION')
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').trim().replace(/^v/, '')
    if (text !== '') return text
  }
  return '0.0.0-dev'
}

/**
 * 把当前 tag 写进 VERSION 文件（发布流程会调它）。
 * 为什么还要这个文件：tag 只在 git 仓库里看得见，而源码 zip 里没有 .git；
 * 有了它，下载源码的人也知道自己拿到的是哪一版。
 * @returns {boolean} 内容有没有变化（变了就该提交一次）
 */
export function writeVersionFile() {
  const tag = lastTag()
  if (tag === null) return false          // 没 tag 就不写，免得写进去一个假的
  const value = onExactTag() ? tag : tag + '-dev'
  const file = join(APP, 'VERSION')
  const before = existsSync(file) ? readFileSync(file, 'utf8').trim() : ''
  if (before === value) return false
  writeFileSync(file, value + '\n', 'utf8')
  return true
}

/**
 * 校验 VERSION 文件和 tag 一致（自测会调它）。
 * 这就是"两个来源"的解药：文件是生成的，而且每次跑测试都会被核对一遍。
 * @returns {{ ok: boolean, reason?: string }}
 */
export function checkVersionFile() {
  const tag = lastTag()
  if (tag === null) return { ok: true }        // 不在 git 仓库里（源码 zip）：没什么可核对的
  const file = join(APP, 'VERSION')
  if (!existsSync(file)) return { ok: false, reason: 'VERSION 文件不存在，跑一次 node tools/version.mjs --write' }
  const got = readFileSync(file, 'utf8').trim().replace(/^v/, '')
  const bare = got.replace(/-dev$/, '')
  // 只有"正在发布"（HEAD 正好落在 tag 上）才要求逐字一致。
  // 平时提交几次之后 HEAD 就跑到 tag 前面了，那会儿 VERSION 写着 1.0.0 或 1.0.0-dev 都算正常——
  // 这里较真只会让每次提交后的自测都变红，反而没人看。
  if (!onExactTag()) {
    return bare === tag ? { ok: true } : { ok: false, reason: 'VERSION 是 ' + got + '，但 tag 是 ' + tag + '（跑 node tools/version.mjs --write）' }
  }
  return got === tag ? { ok: true } : { ok: false, reason: '正在发布 ' + tag + '，但 VERSION 是 ' + got + '（跑 node tools/version.mjs --write）' }
}

/** 带 v 前缀的写法（文件名、标签里用）。 */
export function versionTag() {
  return 'v' + readVersion()
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  if (args.includes('--write')) {
    console.log(writeVersionFile() ? 'VERSION 已更新为 ' + readVersion() + '（记得提交一次）' : 'VERSION 已经是最新的：' + readVersion())
  } else if (args.includes('--check')) {
    const result = checkVersionFile()
    console.log(result.ok ? 'VERSION 与 tag 一致：' + readVersion() : '不一致：' + result.reason)
    if (!result.ok) process.exit(1)
  } else {
    console.log(readVersion())
  }
}
