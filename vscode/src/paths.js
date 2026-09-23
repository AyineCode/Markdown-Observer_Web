/*
 * 路径小工具。单独一个文件，是为了能被自测直接 require：
 * preview-provider.js 顶部要 require('vscode')，在编辑器之外根本加载不了——
 * 把"纯计算"拿出来，图片地址这种最容易出错的地方才能被自动测到。
 */
const { dirname, isAbsolute, join, relative } = require('node:path');
const { fileURLToPath } = require('node:url');

/** Windows 的反斜杠换成 /：应用本体是按正斜杠路径设计的（和服务端给的一致）。 */
function toAppPath(fsPath) {
  return fsPath.replace(/\\/g, '/');
}

/**
 * 文档里写的图片地址 → 磁盘路径。三种都得认：
 *   images/a.png   → 按文档所在目录解析（最常见）
 *   /home/x/a.png 或 C:\\x\\a.png → 绝对路径，原样
 *   file:///x/a.png → 转成路径
 */
function resolvePath(fromDoc, target) {
  if (/^file:/i.test(target)) {
    try { return fileURLToPath(target) } catch { return target }
  }
  if (isAbsolute(target) || /^[a-zA-Z]:[\\/]/.test(target)) return target;
  return join(dirname(fromDoc), target);
}

/** file 是不是在 root 底下（webview 只能读 localResourceRoots 之内的文件）。 */
function isInside(root, file) {
  const rel = relative(root, file);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

module.exports = { toAppPath, resolvePath, isInside };
