/** Optional public browser check for a live Mac desktop. Reads the dashboard PIN
 * from stdin, prints only geometry and status, and always presses Stop. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';

const url = process.argv[2];
if (!url || !url.startsWith('https://')) throw new Error('HTTPS desktop URL required');
const pin = await new Promise(resolve => {
  let value = '';
  process.stdin.on('data', chunk => { value += chunk; });
  process.stdin.on('end', () => resolve(value.trim()));
});
if (!/^\d{6}$/.test(pin)) throw new Error('six-digit PIN required on stdin');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-desktop-browser-'));
const chromePath = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const chrome = spawn(chromePath, ['--headless=new', '--no-first-run',
  '--no-default-browser-check', '--disable-background-networking',
  '--remote-debugging-port=0', `--user-data-dir=${profile}`, url], { stdio: 'ignore' });
let socket;
let evaluate;
let stopAttempted = false;
try {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let i = 0; i < 100 && !fs.existsSync(portFile); i++) await sleep(100);
  if (!fs.existsSync(portFile)) throw new Error('Chrome did not start');
  let port = '';
  for (let i = 0; i < 100 && !port; i++) {
    port = fs.readFileSync(portFile, 'utf8').split('\n')[0];
    if (!/^\d+$/.test(port) || Number(port) === 0) { port = ''; await sleep(100); }
  }
  if (!port) throw new Error('Chrome DevTools port was unavailable');
  let page;
  for (let i = 0; i < 100 && !page; i++) {
    const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
    page = targets.find(target => target.type === 'page' && target.url.startsWith(url));
    if (!page) await sleep(100);
  }
  if (!page) throw new Error('Chrome did not open the desktop page');
  socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  let serial = 0;
  const pending = new Map();
  socket.on('message', raw => {
    const message = JSON.parse(raw.toString());
    if (!pending.has(message.id)) return;
    pending.get(message.id)(message);
    pending.delete(message.id);
  });
  const call = (method, params = {}) => new Promise(resolve => {
    const id = ++serial;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });
  evaluate = async expression => {
    const response = await call('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true,
    });
    if (response.error || response.result?.exceptionDetails) {
      throw new Error(response.error?.message || response.result?.exceptionDetails?.text || 'browser evaluation failed');
    }
    return response.result?.result?.value;
  };
  await call('Runtime.enable');
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = await evaluate("document.readyState === 'complete' && !!document.getElementById('unlockButton')"); }
    catch (error) {
      if (!/Execution context was destroyed/.test(error.message)) throw error;
    }
    if (!ready) await sleep(100);
  }
  if (!ready) {
    const probe = await evaluate("({state:document.readyState, title:document.title, hasButton:!!document.getElementById('unlockButton'), url:location.pathname, body:document.body?.textContent.slice(0,100)})");
    throw new Error(`desktop page did not finish loading: ${JSON.stringify(probe)}`);
  }
  const opened = await evaluate(`(async () => {
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    for (let i = 0; i < 100 && !document.getElementById('unlockButton'); i++) await sleep(100);
    const pin = document.getElementById('pin');
    const unlock = document.getElementById('unlockButton');
    if (!pin || !unlock) return { error: 'viewer missing' };
    pin.value = ${JSON.stringify(pin)};
    unlock.click();
    for (let i = 0; i < 350; i++) {
      const image = document.getElementById('screen');
      const canvas = document.getElementById('videoCanvas');
      const control = document.getElementById('control');
      const status = document.getElementById('status')?.textContent || '';
      if (control && !control.hidden && ((image && !image.hidden && image.naturalWidth)
        || (canvas && !canvas.hidden && canvas.width))) {
        return { width: canvas && !canvas.hidden ? canvas.width : image.naturalWidth,
          height: canvas && !canvas.hidden ? canvas.height : image.naturalHeight,
          codec: canvas && !canvas.hidden ? 'h264' : 'jpeg', status };
      }
      if (/unavailable|refused|not accepted|error/i.test(status)) return { error: status };
      await sleep(100);
    }
    return { error: 'first frame timed out', status: document.getElementById('status')?.textContent };
  })()`);
  stopAttempted = true;
  const stopped = await evaluate(`(async () => {
    document.getElementById('stopButton')?.click();
    for (let i = 0; i < 100; i++) {
      const status = document.getElementById('status')?.textContent || '';
      if (/stopped/i.test(status)) return { status, blank: !document.getElementById('screen').getAttribute('src')
        && document.getElementById('videoCanvas').hidden && document.getElementById('control').hidden };
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { status: document.getElementById('status')?.textContent, blank: false };
  })()`);
  if (opened?.error) throw new Error(`desktop open failed: ${opened.error}`);
  if (opened?.width !== 1920 || opened?.height !== 1080) {
    throw new Error(`desktop geometry wrong: ${opened?.width}x${opened?.height}`);
  }
  if (!stopped?.blank || !/stopped/i.test(stopped.status)) throw new Error('Stop did not blank and revoke');
  console.log(JSON.stringify({ geometry: `${opened.width}x${opened.height}`,
    codec: opened.codec, stopped: true }));
} finally {
  if (evaluate && !stopAttempted) {
    try {
      await evaluate("document.getElementById('stopButton')?.click(); true");
      await sleep(300);
    } catch { /* Closing the browser also ends its socket. */ }
  }
  try { socket?.close(); } catch { /* browser may already be gone */ }
  chrome.kill('SIGTERM');
  await sleep(300);
  SafeFsExecutor.safeRmSync(profile, { recursive: true, force: true,
    operation: 'desktop-public-browser-smoke:temporary-browser-profile-cleanup' });
}
