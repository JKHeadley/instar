/** Live Remote Desktop reading (CMT-033). Reads the dashboard PIN from stdin, opens the
 * named machine, times the first picture, measures delay from single scroll steps to the
 * next picture and the picture rate during a scroll burst, prints only numbers, and
 * always presses Stop. Scroll steps alternate down and up so the page ends where it began.
 * --view-only skips every input and measures only first picture, idle rate and drops. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import { SafeFsExecutor } from '../dist/core/SafeFsExecutor.js';

const url = process.argv[2];
const landscape = process.argv.includes('--landscape');
const mobile = process.argv.includes('--mobile') || landscape;
const viewOnly = process.argv.includes('--view-only');
const wheel = false;
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
    window.__pics = []; window.__statuses = []; window.__unlockAt = null;
    document.addEventListener('click', e => { if (e.target && e.target.id === 'unlockButton') window.__unlockAt = performance.now(); }, true);
    const draw = CanvasRenderingContext2D.prototype.drawImage;
    CanvasRenderingContext2D.prototype.drawImage = function (...a) {
      if (this.canvas && this.canvas.id === 'videoCanvas') window.__pics.push(performance.now());
      return draw.apply(this, a);
    };
    document.addEventListener('load', e => { if (e.target && e.target.id === 'screen') window.__pics.push(performance.now()); }, true);
    window.__desktopSmokeInjected = true;
    // Which video format the session really used, and why: the browser's own H.264 answer,
    // the format the page asked for, and what the decoder did. A start-up fallback shows
    // only in the status line, so watch it from the first moment. The request reply names
    // no format, so the decoder counts tell the two fallbacks apart: no decode at all means
    // the server sent JPEG; decodes with no picture means this browser could not decode.
    window.__video = { h264Supported: null, requested: null,
      decoder: { created: 0, configured: 0, decodes: 0, outputs: 0, errors: [] } };
    if (window.VideoDecoder) {
      const Native = window.VideoDecoder;
      const d = window.__video.decoder;
      window.VideoDecoder = class extends Native {
        constructor(init) {
          super({ output: frame => { d.outputs++; init.output(frame); },
            error: e => { if (d.errors.length < 5) d.errors.push(String(e?.name || '') + ': ' + String(e?.message || e).slice(0, 120)); init.error(e); } });
          d.created++;
        }
        configure(config) { d.configured++; return super.configure(config); }
        decode(chunk) { d.decodes++; return super.decode(chunk); }
      };
      if (typeof Native.isConfigSupported === 'function') window.VideoDecoder.isConfigSupported = Native.isConfigSupported.bind(Native);
    }
    if (window.VideoDecoder?.isConfigSupported) {
      const supported = VideoDecoder.isConfigSupported.bind(VideoDecoder);
      VideoDecoder.isConfigSupported = async config => {
        const answer = await supported(config);
        if (String(config?.codec || '').startsWith('avc1')) window.__video.h264Supported = !!answer?.supported;
        return answer;
      };
    } else {
      window.__video.h264Supported = false;
    }
    document.addEventListener('DOMContentLoaded', () => {
      const s = document.getElementById('status');
      if (!s) return;
      let last = s.textContent || '';
      new MutationObserver(() => { const now = s.textContent || ''; if (now !== last) { window.__statuses.push(now); last = now; } })
        .observe(s, { childList: true, characterData: true, subtree: true });
    });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (...args) => {
      const response = await originalFetch(...args);
      const path = typeof args[0] === 'string' ? args[0] : args[0]?.url;
      // The page's own credentials, so the driver can read the session's server-side status.
      const h = args[1]?.headers;
      if (typeof path === 'string' && path.startsWith('/desktop/') && h?.Authorization) {
        window.__desktopHeaders = { Authorization: h.Authorization, 'X-Instar-Operator-Session': h['X-Instar-Operator-Session'] };
      }
      if (path === '/dashboard/unlock' || path === '/desktop/requests') {
        try {
          const value = await response.clone().json();
          if (path === '/dashboard/unlock') window.__desktopSmokeAuth = value;
          else if (args[1]?.method === 'POST') {
            window.__desktopSmokeRequestId = value.requestId;
            try { window.__video.requested = JSON.parse(String(args[1].body)).videoCodec ?? null; } catch { /* body not JSON */ }
          }
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

  if (opened?.error) throw new Error(`desktop open failed: ${opened.error} (status: ${JSON.stringify(opened.status ?? null)})`);
  // The status line is watched from page load (see the injected script), so a start-up fallback is kept.
  const firstPictureMs = await evaluate(`(window.__unlockAt !== null && window.__pics.length) ? Math.round(window.__pics[0] - window.__unlockAt) : null`);
  const pct = (v, f) => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b); return Math.round(s[Math.max(0, Math.ceil(f * s.length) - 1)]); };
  // Idle picture rate: 10 s with no input.
  const idleStart = await evaluate('performance.now()');
  await sleep(10_000);
  const idleCount = await evaluate(`window.__pics.filter(t => t >= ${idleStart}).length`);
  let delays = [], unanswered = 0, burst = null;
  if (!viewOnly) {
    const center = await evaluate(`(() => { const r = document.getElementById('surface').getBoundingClientRect();
      window.__wheelAt = []; document.addEventListener('wheel', e => window.__wheelAt.push(e.timeStamp), true);
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (let i = 0; i < 20; i++) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0,
        deltaY: i % 2 ? -120 : 120, pointerType: 'mouse' });
      await sleep(1_500);
      const r = await evaluate(`(() => { const t = window.__wheelAt.at(-1); const p = window.__pics.find(x => x > t);
        return { t, p: p ?? null }; })()`);
      if (r.p !== null && r.p - r.t <= 1_500) delays.push(r.p - r.t); else unanswered++;
    }
    // Smoothness: 3 s of continuous scrolling, 30 steps down then 30 up, one every 50 ms.
    const b0 = await evaluate('performance.now()');
    for (let i = 0; i < 60; i++) {
      await call('Input.dispatchMouseEvent', { type: 'mouseWheel', x: center.x, y: center.y, deltaX: 0,
        deltaY: i < 30 ? 40 : -40, pointerType: 'mouse' });
      await sleep(50);
    }
    await sleep(500);
    const b1 = await evaluate('performance.now()');
    const pics = await evaluate(`window.__pics.filter(t => t >= ${b0} && t <= ${b1})`);
    const gaps = pics.slice(1).map((t, i) => t - pics[i]);
    burst = { seconds: Math.round((b1 - b0) / 100) / 10, pictures: pics.length,
      picturesPerSecond: Math.round(pics.length / ((b1 - b0) / 1000) * 10) / 10, gapP95Ms: pct(gaps, 0.95), gapMaxMs: gaps.length ? Math.round(Math.max(...gaps)) : null };
  }
  const statuses = await evaluate('window.__statuses');
  // Decoder counts at the end of the run, and the server's own view of the session
  // (its video format and, where the server records it, why it left H.264), read before Stop.
  // The server sets videoCodec only at request or resume: a viewer fallback mid-session still reads h264 there.
  const video = (await evaluate('window.__video')) || { missing: true };
  video.server = await evaluate(`(async () => { try {
    const r = await fetch('/desktop/requests/' + encodeURIComponent(window.__desktopSmokeRequestId), { cache: 'no-store', credentials: 'same-origin', headers: window.__desktopHeaders || {} });
    const v = await r.json(); return { httpStatus: r.status, videoCodec: v.videoCodec ?? null, videoDowngrade: v.videoDowngrade ?? null };
  } catch (e) { return { error: String(e && e.message || e).slice(0, 120) }; } })()`);
  stopAttempted = true;
  const stopped = await evaluate(`(async () => { document.getElementById('stopButton')?.click();
    for (let i = 0; i < 100; i++) { const s = document.getElementById('status')?.textContent || '';
      if (/stopped/i.test(s)) return s; await new Promise(r => setTimeout(r, 100)); }
    return document.getElementById('status')?.textContent; })()`);
  console.log(JSON.stringify({ machine: opened.machine, geometry: `${opened.width}x${opened.height}`, codec: opened.codec, video,
    viewOnly, firstPictureMsFromPin: firstPictureMs, idlePicturesPerSecond: Math.round(idleCount / 10 * 10) / 10,
    delay: viewOnly ? null : { samples: delays.length, unanswered, typicalMs: pct(delays, 0.5), worstMs: pct(delays, 0.95) },
    burst, statusChanges: statuses, stopped: /stopped/i.test(stopped || '') }, null, 1));
} finally {
  if (evaluate && !stopAttempted) {
    try { await evaluate("document.getElementById('stopButton')?.click(); true"); await sleep(300); }
    catch { /* Closing the browser also ends its socket. */ }
  }
  try { socket?.close(); } catch { /* browser may already be gone */ }
  chrome.kill('SIGTERM');
  await sleep(300);
  SafeFsExecutor.safeRmSync(profile, { recursive: true, force: true,
    operation: 'desktop-live-reading:temporary-browser-profile-cleanup' });
}
