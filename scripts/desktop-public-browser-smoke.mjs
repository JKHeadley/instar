/** Optional public browser check for a live Mac desktop. Reads the dashboard PIN
 * from stdin, prints only geometry and status, and always presses Stop. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';

const url = process.argv[2];
const landscape = process.argv.includes('--landscape');
const mobile = process.argv.includes('--mobile') || landscape;
const wheel = process.argv.includes('--wheel');
const cursorCheck = process.argv.includes('--cursor');
const anyGeometry = process.argv.includes('--any-geometry');
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
  await call('Page.enable');
  await call('Page.addScriptToEvaluateOnNewDocument', { source: `(() => {
    window.__desktopSmokeInjected = true;
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const path = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      if (path === '/dashboard/unlock' || path === '/desktop/requests') {
        try {
          const value = await response.clone().json();
          if (path === '/dashboard/unlock') window.__desktopSmokeAuth = value;
          else if (args[1]?.method === 'POST') window.__desktopSmokeRequestId = value.requestId;
        } catch { /* A failed response is handled by the viewer. */ }
      }
      return response;
    };
  })();` });
  if (mobile) {
    await call('Emulation.setDeviceMetricsOverride', {
      width: landscape ? 844 : 390, height: landscape ? 390 : 844,
      deviceScaleFactor: 3, mobile: true,
    });
    await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 2 });
  }
  await call('Page.reload', { ignoreCache: true });
  let ready = false;
  for (let i = 0; i < 100 && !ready; i++) {
    try { ready = await evaluate("window.__desktopSmokeInjected === true && document.readyState === 'complete' && !!document.getElementById('unlockButton')"); }
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
          codec: canvas && !canvas.hidden ? 'h264' : 'jpeg',
          machine: document.getElementById('machineName')?.textContent || '', status };
      }
      if (/unavailable|refused|not accepted|error/i.test(status)) return { error: status };
      await sleep(100);
    }
    return { error: 'first frame timed out', status: document.getElementById('status')?.textContent };
  })()`);
  let mobileResult;
  let wheelResult;
  let cursorResult;
  if (cursorCheck && !opened?.error) {
    const move = await evaluate(`(async () => {
      const auth = window.__desktopSmokeAuth, id = window.__desktopSmokeRequestId;
      if (!auth?.token || !auth?.operatorSessionToken || !id) throw new Error('browser session was not captured');
      const response = await fetch('/desktop/requests/' + encodeURIComponent(id) + '/cursor', {
        headers: { Authorization: 'Bearer ' + auth.token,
          'X-Instar-Operator-Session': auth.operatorSessionToken } });
      if (!response.ok) throw new Error('initial host cursor read failed');
      const before = await response.json();
      const target = { x: before.x < 0.5 ? 0.8 : 0.2, y: before.y < 0.5 ? 0.8 : 0.2 };
      const source = document.getElementById('videoCanvas').hidden
        ? document.getElementById('screen') : document.getElementById('videoCanvas');
      const rect = source.getBoundingClientRect();
      const width = source.naturalWidth || source.width, height = source.naturalHeight || source.height;
      const scale = Math.min(rect.width / width, rect.height / height);
      const imageWidth = width * scale, imageHeight = height * scale;
      const left = rect.left + (rect.width - imageWidth) / 2;
      const top = rect.top + (rect.height - imageHeight) / 2;
      return { before, target, x: left + target.x * imageWidth, y: top + target.y * imageHeight,
        restoreX: left + before.x * imageWidth, restoreY: top + before.y * imageHeight };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: move.x, y: move.y, pointerType: 'mouse' });
    for (let i = 0; i < 40; i++) {
      await sleep(50);
      const point = await evaluate(`(async () => {
        const auth = window.__desktopSmokeAuth, id = window.__desktopSmokeRequestId;
        const response = await fetch('/desktop/requests/' + encodeURIComponent(id) + '/cursor', {
          headers: { Authorization: 'Bearer ' + auth.token,
            'X-Instar-Operator-Session': auth.operatorSessionToken } });
        return response.ok ? response.json() : null;
      })()`);
      if (point && Math.abs(point.x - move.target.x) < 0.07
        && Math.abs(point.y - move.target.y) < 0.07) { cursorResult = { moved: true }; break; }
    }
    if (!cursorResult) throw new Error('host cursor did not move to the browser input target');
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x: move.restoreX,
      y: move.restoreY, pointerType: 'mouse' });
  }
  if (wheel && !opened?.error) {
    const desktopControls = await evaluate(`({ touchModeHidden: document.getElementById('modeButton').hidden,
      cursorOutline: document.querySelector('#localCursor path')?.getAttribute('stroke') })`);
    if (!desktopControls.touchModeHidden || desktopControls.cursorOutline !== '#000') {
      throw new Error(`laptop controls are stale: ${JSON.stringify(desktopControls)}`);
    }
    const center = await evaluate(`(() => {
      const rect = document.getElementById('surface').getBoundingClientRect();
      window.__desktopWheelCheck = null;
      document.addEventListener('wheel', event => {
        window.__desktopWheelCheck = { prevented: event.defaultPrevented,
          dx: event.deltaX, dy: event.deltaY };
      }, { once: true });
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x,
      y: center.y, deltaX: 0, deltaY: 60, pointerType: 'mouse' });
    for (let i = 0; i < 20; i++) {
      wheelResult = await evaluate('window.__desktopWheelCheck');
      if (wheelResult) break;
      await sleep(50);
    }
    if (!wheelResult?.prevented || wheelResult.dy !== 60) {
      throw new Error(`laptop wheel was not handled by the desktop: ${JSON.stringify(wheelResult)}`);
    }
  }
  if (mobile && !opened?.error) {
    const layout = await evaluate(`(() => {
      const s = document.getElementById('surface').getBoundingClientRect();
      const c = document.getElementById('control').getBoundingClientRect();
      const dock = document.querySelector('.desktop-dock').getBoundingClientRect();
      return { surface: { x: s.x, y: s.y, width: s.width, height: s.height },
        control: { width: c.width, height: c.height }, viewport: { width: innerWidth, height: innerHeight },
        dockInside: dock.right <= c.right && dock.bottom <= c.bottom };
    })()`);
    if (Math.abs(layout.surface.width - layout.viewport.width) > 2
      || Math.abs(layout.surface.height - layout.viewport.height) > 2 || !layout.dockInside) {
      throw new Error(`mobile viewer did not fill viewport: ${JSON.stringify(layout)}`);
    }
    const touchPolicy = await evaluate(`(() => {
      const control = getComputedStyle(document.getElementById('control'));
      const input = getComputedStyle(document.getElementById('typeText'));
      return { mode: document.getElementById('modeButton').getAttribute('aria-pressed'),
        touchAction: control.touchAction, select: control.webkitUserSelect || control.userSelect,
        inputSelect: input.webkitUserSelect || input.userSelect };
    })()`);
    if (touchPolicy.mode !== 'false' || touchPolicy.touchAction !== 'none'
      || touchPolicy.select !== 'none' || touchPolicy.inputSelect !== 'text') {
      throw new Error(`mobile tap/selection policy is stale: ${JSON.stringify(touchPolicy)}`);
    }
    const x = layout.surface.x + layout.surface.width / 2;
    const y = layout.surface.y + layout.surface.height / 2;
    const touch = (type, points) => call('Input.dispatchTouchEvent', { type, touchPoints: points });
    await touch('touchStart', [{ x: x - 60, y, id: 1 }, { x: x + 60, y, id: 2 }]);
    await touch('touchMove', [{ x: x - 95, y, id: 1 }, { x: x + 95, y, id: 2 }]);
    await touch('touchEnd', []);
    const zoomed = await evaluate(`({ zoom: document.getElementById('viewTransform').style.transform,
      fitVisible: !document.getElementById('zoomResetButton').hidden })`);
    if (!zoomed.fitVisible || !/scale\((?:1\.[1-9]|[2-4])/.test(zoomed.zoom)) {
      throw new Error(`mobile pinch did not zoom: ${JSON.stringify(zoomed)}`);
    }
    const panBefore = await evaluate("document.getElementById('viewTransform').style.transform");
    await touch('touchStart', [{ x, y, id: 4 }]);
    await touch('touchMove', [{ x: layout.surface.x + layout.surface.width - 3, y, id: 4 }]);
    await sleep(120);
    const panAfter = await evaluate("document.getElementById('viewTransform').style.transform");
    await touch('touchEnd', []);
    if (panBefore === panAfter) throw new Error('zoomed mobile edge drag did not pan the desktop');
    const keyboardRect = await evaluate(`(() => {
      const r = document.getElementById('keyboardButton').getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    await touch('touchStart', [{ ...keyboardRect, id: 3 }]);
    await touch('touchEnd', []);
    const keyboardOpen = await evaluate(`document.activeElement?.id === 'typeText'
      && !document.getElementById('keyboardBar').hidden`);
    if (!keyboardOpen) throw new Error('mobile keyboard control did not focus the typing field');
    mobileResult = { viewport: `${layout.viewport.width}x${layout.viewport.height}`,
      surface: `${layout.surface.width}x${layout.surface.height}`, pinch: true,
      edgeFollow: true, directMode: true, keyboard: true };
  }
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
  const postStop = opened?.error ? null : await evaluate(`(async () => {
    const auth = window.__desktopSmokeAuth, id = window.__desktopSmokeRequestId;
    const response = await fetch('/desktop/requests/' + encodeURIComponent(id) + '/cursor', {
      headers: { Authorization: 'Bearer ' + auth.token,
        'X-Instar-Operator-Session': auth.operatorSessionToken } });
    return { localInputOff: document.getElementById('control').hidden
      && !document.body.classList.contains('desktop-live'),
      serverRefused: response.status === 403 || response.status === 404 };
  })()`);
  if (opened?.error) throw new Error(`desktop open failed: ${opened.error}`);
  if (!opened?.width || !opened?.height || opened.width < 640 || opened.height < 480
    || (!anyGeometry && (opened.width !== 1920 || opened.height !== 1080))) {
    throw new Error(`desktop geometry wrong: ${opened?.width}x${opened?.height}`);
  }
  if (!stopped?.blank || !/stopped/i.test(stopped.status)) throw new Error('Stop did not blank and revoke');
  if (!postStop?.localInputOff || !postStop?.serverRefused) {
    throw new Error(`post-Stop input was not refused: ${JSON.stringify(postStop)}`);
  }
  console.log(JSON.stringify({ machine: opened.machine, geometry: `${opened.width}x${opened.height}`,
    codec: opened.codec, stopped: true, postStopRefused: true,
    ...(cursorResult ? { cursor: cursorResult.moved } : {}),
    ...(wheelResult ? { wheel: true } : {}),
    ...(mobileResult ? { mobile: mobileResult } : {}) }));
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
