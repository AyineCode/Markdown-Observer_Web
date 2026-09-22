#!/usr/bin/env node
/**
 * status.mjs —— 看看 Markdown Observer 的服务在不在、在服务什么；需要的话让它退出。
 *
 * 为什么用 HTTP 而不是 pgrep：服务可能是在别的 PID 命名空间里起来的（开发时从沙箱、
 * 或者从托盘程序），那种情况下 pgrep 根本看不见它，但端口一定看得见。
 * 所以这里一律"隔着端口问一句"。
 *
 * 跑法：
 *   node tools/win/status.mjs          # 看看在不在
 *   node tools/win/status.mjs --stop   # 让它退出（走 /api/quit）
 *   node tools/win/status.mjs --port 47821
 */
const PORT = (() => {
  const i = process.argv.indexOf('--port');
  return i === -1 ? 47821 : Number(process.argv[i + 1]);
})();
const BASE = 'http://127.0.0.1:' + PORT;

/** 问一句"端口上是不是我们的服务"。 */
async function probe() {
  try {
    const res = await fetch(BASE + '/api/info', { headers: { accept: 'application/json' } });
    if (!res.ok) return null;
    const body = await res.json();
    return body !== null && body.mode === 'server' ? body : null;
  } catch {
    return null;
  }
}

const info = await probe();
if (info === null) {
  console.log('No Markdown Observer service is running on port ' + PORT + '.');
  process.exit(0);
}

console.log('Service is running (port ' + PORT + '):');
console.log('  shape      : ' + (info.shape === 'file' ? 'single file (opened by double-click)' : 'folder'));
console.log('  root name  : ' + info.name);
console.log('  allowed    : ' + (Array.isArray(info.roots) ? info.roots.join(', ') : '?'));
if (typeof info.lastOpened === 'string' && info.lastOpened !== '') console.log('  last open  : ' + info.lastOpened);
else if (typeof info.file === 'string' && info.file !== '') console.log('  document   : ' + info.file);
console.log('  on dblclick: ' + (info.openMode === 'tab' ? 'open a new browser tab' : 'reuse the open reader page'));

if (!process.argv.includes('--stop')) {
  console.log('');
  console.log('To stop it: node tools/win/status.mjs --stop');
  process.exit(0);
}

try {
  const res = await fetch(BASE + '/api/quit');
  console.log('');
  console.log(res.ok ? 'Asked it to exit.' : 'It refused the quit request (HTTP ' + res.status + ').');
} catch {
  console.log('');
  console.log('Could not deliver the quit request - the service may already be gone.');
}
