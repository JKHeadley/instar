import { LOADING_REQUEST_HEADER, LOADING_READ, createLoadingRequestHeaders, createLoadingNativeWitness } from './accountsLoading.mjs';
import { validateParentCase, observeAccountsView, assertAccountsWitness } from './accountsReadiness.mjs';
import { isDeclaredHeaderProbe, RESPONSE_EVIDENCE_HEADER } from './fixtureResponseEvidence.mjs';
/** Private, stdin-only renderer worker. Importing this module never launches a browser. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { createRendererLifetime, createOwnedCleanup } from './rendererLifetime.mjs';
import { randomBytes } from 'node:crypto';
import { PINNED_PLAYWRIGHT, PINNED_AXE, validateRendererConfig, allowsFixtureRequest, browserLaunchOptions, resolvePinnedHeadlessShell, inspectOwnedBrowser, sha256, pngDimensions } from './rendererIdentity.mjs';
import { assertLoadedBundledFonts, observeRendererErrors, finalizeRendererReadiness } from './rendererReadiness.mjs';
const toolRequire = createRequire(new URL('./renderer-toolchain/package.json', import.meta.url));
const save = (filename, bytes) => fs.writeFileSync(filename, bytes, { mode: 0o600, flag: 'wx' });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { if (error.code === 'ESRCH') return false; throw error; } };

export async function runRenderer(rawConfig, control = {}) {
  const startedAt = performance.now();
  const config = validateRendererConfig(rawConfig);
  const parentCase = validateParentCase(control.parentCase);
  // No credential, proxy, shell startup, live-agent HOME or host browser state is inherited.
  const environment = browserLaunchOptions(config, '').env;
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment, { PLAYWRIGHT_BROWSERS_PATH: config.rendererDir, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1' });
  const toolPackage = toolRequire('playwright-core/package.json');
  const axePackage = toolRequire('axe-core/package.json');
  if (toolPackage.version !== PINNED_PLAYWRIGHT || axePackage.version !== PINNED_AXE) throw new Error('Renderer toolchain version mismatch');
  // The installed shell differs from the full Chromium executable. Resolve its actual pinned registry entry.
  const registry = toolRequire('playwright-core/lib/coreBundle').registry.registry;
  const metadata = JSON.parse(fs.readFileSync(path.join(path.dirname(toolRequire.resolve('playwright-core/package.json')), 'browsers.json'), 'utf8'));
  const binary = resolvePinnedHeadlessShell(registry, metadata, config.rendererDir);
  const outputDir = path.join(config.runDir, `renderer-${randomBytes(8).toString('hex')}`);
  fs.mkdirSync(outputDir, { mode: 0o700 });
  fs.mkdirSync(path.join(outputDir, 'responses'), { mode: 0o700 });
  const loadLog = [], responses = [], responseJobs = [], failures = [];
  const manifest = { schema: 'design-renderer-worker/1', status: 'unavailable', toolchain: { playwright: PINNED_PLAYWRIGHT, axe: PINNED_AXE },
    binary, seedNow: config.seedNow, viewport: config.viewport, theme: config.theme, deviceScaleFactor: 1,
    fixtureOrigin: config.fixtureOrigin, parentCase, focusTrace: { status: 'not-measured' }, loadLog, responses };
  const loadingHeaders=createLoadingRequestHeaders(config.fixtureOrigin,parentCase.loading);
  const loadingNative=parentCase.loading ? createLoadingNativeWitness(parentCase.loading) : null;
  const report = event => {
    try { fs.appendFileSync(path.join(outputDir, 'lifetime.jsonl'), JSON.stringify(event) + '\n', { mode: 0o600 }); } catch { manifest.lifecycleLogUnavailable = true; }
    control.report?.(event);
  };
  const lifetime = createRendererLifetime({ startedAt, stepMs: config.stepRemainingMs ?? 20 * 60_000, report });
  control.bind?.(lifetime);
  const owner = createOwnedCleanup({ lifetime, verifyServer: held => inspectOwnedBrowser(held.process(), binary.executablePath, config.runDir), isAlive: alive });
  let server, browser, child, acceptingResponses = true;
  let thrown;
  try {
    const { chromium } = toolRequire('playwright-core');
    server = await lifetime.phase('browser-launch', () => owner.registerLaunch(chromium.launchServer(browserLaunchOptions(config, binary.executablePath))));
    child = server.process();
    manifest.process = { ...inspectOwnedBrowser(child, binary.executablePath, config.runDir), aliveAfterLaunch: alive(child.pid) };
    if (!manifest.process.aliveAfterLaunch) throw new Error('Owned browser process is not alive after launch');
    browser = await lifetime.phase('browser-connect', () => chromium.connect(server.wsEndpoint()));
    const context = await lifetime.phase('context-create', () => browser.newContext({ viewport: config.viewport, deviceScaleFactor: 1, colorScheme: config.theme,
      locale: 'en-US', timezoneId: 'UTC', serviceWorkers: 'block', acceptDownloads: false, reducedMotion: 'reduce' }));
    await lifetime.phase('request-routing', () => context.route('**/*', async route => {
      const url = route.request().url();
      if (lifetime.snapshot().canceled) { await route.abort('blockedbyclient'); return; }
      if (!allowsFixtureRequest(url, config.fixtureOrigin)) { loadLog.push({ kind: 'blocked-request', url }); await route.abort('blockedbyclient'); return; }
      const headers=loadingHeaders(route.request());if(headers[LOADING_REQUEST_HEADER])loadingNative.admit(route.request());
      await route.continue({headers});
    }));
    await lifetime.phase('websocket-routing', () => context.routeWebSocket('**/*', socket => { loadLog.push({ kind: 'blocked-websocket', url: socket.url() }); socket.close({ code: 1008, reason: 'Fixture renderer forbids WebSockets' }); }));
    await lifetime.phase('fresh-storage', () => context.addInitScript(({ origin, nonce, theme }) => {
      if (location.origin === origin) { localStorage.clear(); sessionStorage.clear(); localStorage.setItem('instar_token', nonce); localStorage.setItem('instar_console_theme', theme); }
      const disable = () => {
        if (!document.documentElement) return;
        const style = document.createElement('style'); style.textContent = '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important;scroll-behavior:auto!important}';
        document.documentElement.append(style);
      };
      new MutationObserver(disable).observe(document, { childList: true });
      disable();
    }, { origin: config.fixtureOrigin, nonce: config.bootNonce, theme: config.theme }));
    lifetime.check();
    const page = await lifetime.phase('page-create', () => context.newPage());
    await lifetime.phase('fixed-clock', () => page.clock.setFixedTime(new Date(config.seedNow))); // Native timeouts/intervals keep progressing.
    page.on('requestfailed', req => {loadingNative?.failed(req);loadLog.push({ kind: 'request-failed', url: req.url(), reason: req.failure()?.errorText });});
    observeRendererErrors(page, failures);
    page.on('response', response => {
      loadingNative?.response(response.request());
      if (!acceptingResponses || lifetime.snapshot().canceled) return;
      responseJobs.push((async () => {
        const row = { url: response.url(), status: response.status(), method: response.request().method(), resourceType: response.request().resourceType(), contentType: response.headers()['content-type'] ?? null, contentLength: response.headers()['content-length'] ?? null };
        if(parentCase.loading && row.url===config.fixtureOrigin+LOADING_READ) row.loadingRequestId=response.request().headers()[LOADING_REQUEST_HEADER]??null;
        if (!allowsFixtureRequest(row.url, config.fixtureOrigin)) { failures.push({ kind: 'foreign-response', url: row.url }); return; }
        if (isDeclaredHeaderProbe(row.method, row.url, config.fixtureOrigin)) {
          row.bodyEvidence = { kind: 'awaiting-parent-evidence', responseId: response.headers()[RESPONSE_EVIDENCE_HEADER] ?? null, browserConsumption: 'not-observed' };
          responses.push(row); return;
        }
        try {
          const bytes = await response.body(); row.bytes = bytes.length; row.sha256 = sha256(bytes);
          const filename = path.join(outputDir, 'responses', `${row.sha256}.bin`);
          if (!fs.existsSync(filename)) save(filename, bytes);
          row.file = path.relative(outputDir, filename);
        } catch { row.bodyUnavailable = true; }
        responses.push(row);
      })());
    });
    await lifetime.phase('navigation', () => page.goto(`${config.fixtureOrigin}/dashboard/console/#/capacity/accounts`, { waitUntil: 'domcontentloaded', timeout: 30_000 }));
    // The painted production list exists for busy, empty and current pooled partial-error states.
    await lifetime.phase('accounts-ready', () => page.waitForFunction(observeAccountsView, parentCase.loading ? {loadingOnly:true} : {terminalOnly:true}, { timeout: 30_000 }));
    const fonts = await lifetime.phase('fonts', () => page.evaluate(async () => {
      await Promise.all([document.fonts.load('14px Inter'), document.fonts.load('14px "JetBrains Mono"')]);
      await document.fonts.ready;
      return { inter: document.fonts.check('14px Inter'), mono: document.fonts.check('14px "JetBrains Mono"'),
        faces: [...document.fonts].map(face => ({ family: face.family, status: face.status })) };
    }));
    assertLoadedBundledFonts(fonts);
    manifest.fonts = fonts;
    const axeSource = fs.readFileSync(toolRequire.resolve('axe-core/axe.min.js'), 'utf8');
    manifest.axeSourceSha256 = sha256(Buffer.from(axeSource));
    await lifetime.phase('axe-install', () => page.addScriptTag({ content: axeSource }));
    const accessibility = await lifetime.phase('axe', () => page.evaluate(async () => await globalThis.axe.run(document, { resultTypes: ['violations', 'incomplete', 'passes', 'inapplicable'] })));
    save(path.join(outputDir, 'axe.json'), JSON.stringify(accessibility, null, 2));
    manifest.accessibility = { status: 'measured', file: 'axe.json', sha256: sha256(Buffer.from(JSON.stringify(accessibility, null, 2))), mergeAuthority: false };
    manifest.process.binarySha256BeforeCapture = sha256(fs.readFileSync(manifest.process.spawnfile));
    manifest.process.aliveBeforeCapture = alive(child.pid);
    if (!manifest.process.aliveBeforeCapture || manifest.process.binarySha256BeforeCapture !== binary.sha256) throw new Error('Pinned browser identity changed before capture');
    manifest.readiness = await lifetime.phase('accounts-witness', () => page.evaluate(observeAccountsView));
    assertAccountsWitness(manifest.readiness, { loading: !!parentCase.loading, seedState: parentCase.seedState, viewport: config.viewport, theme: config.theme });
    if(parentCase.loading) manifest.loading={before:await lifetime.phase('loading-before-capture',()=>control.loading('check')),native:{before:loadingNative.observe()}};
    const png = await lifetime.phase('screenshot', () => page.screenshot({ type: 'png', fullPage: false, animations: 'disabled', caret: 'hide' }));
    manifest.process.aliveAfterCapture = alive(child.pid);
    manifest.process.binarySha256AfterCapture = sha256(fs.readFileSync(manifest.process.spawnfile));
    if (!manifest.process.aliveAfterCapture || manifest.process.binarySha256AfterCapture !== binary.sha256) throw new Error('Pinned browser identity changed during capture');
    const dimensions = pngDimensions(png);
    if (dimensions.width !== config.viewport.width || dimensions.height !== config.viewport.height) throw new Error('Actual capture dimensions differ from the standard viewport');
    save(path.join(outputDir, 'capture.png'), png);
    manifest.capture = { file: 'capture.png', bytes: png.length, sha256: sha256(png), ...dimensions };
    if(parentCase.loading){
      manifest.loading.native.after=loadingNative.observe();
      manifest.loading.after=await lifetime.phase('loading-after-capture',()=>control.loading('check'));
      loadingNative.observe();
      const finished=page.waitForResponse(r=>r.url()===config.fixtureOrigin+LOADING_READ && r.request().headers()[LOADING_REQUEST_HEADER]===parentCase.loading.requestId); finished.catch(()=>{});
      await lifetime.phase('loading-release',()=>control.loading('release'));
      await lifetime.phase('loading-response-finish',()=>finished);
      manifest.afterLoading=await lifetime.phase('loading-later-paint',()=>page.waitForFunction(observeAccountsView,{terminalOnly:true},{timeout:20_000}).then(()=>page.evaluate(observeAccountsView)));
    }
    await lifetime.phase('response-body-drain', () => Promise.all(responseJobs));
    manifest.pageFailures = failures;
    if (failures.length) throw new Error('The actual console reported a page failure');
    lifetime.check();
    manifest.status = 'capture-produced';
  } catch (error) { thrown = error; manifest.failure = { kind: 'renderer-unavailable', message: error.message }; }
  finally {
    acceptingResponses = false;
    manifest.cleanup = await owner.cleanup();
    if (child && manifest.process) { manifest.process.aliveAfterClose = alive(child.pid); manifest.process.exitCode = child.exitCode; manifest.process.signalCode = child.signalCode; }
    try { await lifetime.cleanupPhase('final-response-drain', () => finalizeRendererReadiness(manifest, failures, responseJobs)); }
    catch { manifest.status = 'unavailable'; manifest.finalDrainUnconfirmed = true; }
    manifest.lifetime = lifetime.snapshot();
    if (manifest.lifetime.canceled || manifest.cleanup.status === 'cleanup-unconfirmed' || manifest.lifecycleLogUnavailable) manifest.status = 'unavailable';
    lifetime.dispose();
    save(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
    lifetime.record({ kind: 'manifest-written' });
    manifest.lifetime = lifetime.snapshot();
    if (manifest.lifetime.canceled && manifest.status === 'capture-produced') {
      manifest.status = 'unavailable';
      // An unpublished optimistic disposition cannot survive a deadline crossed during filesystem I/O.
      fs.writeFileSync(path.join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
    }
  }
  const result = { manifest: path.join(outputDir, 'manifest.json'), status: manifest.status, cleanup: manifest.cleanup, lifetime: manifest.lifetime };
  if (thrown || manifest.status !== 'capture-produced') { const error = new Error(`Renderer unavailable; private manifest: ${result.manifest}`); error.result = result; throw error; }
  return result;
}

async function main() {
  let active, pendingCancel, completedResult, receivedCase, resolveCase, rejectCase;
  const loadingWaiters=new Map();let loadingSequence=0;
  const loading=action=>new Promise((resolve,reject)=>{const id=++loadingSequence;loadingWaiters.set(id,{resolve,reject});notify({type:'renderer-loading',id,action});});
  const trustedCase = new Promise((resolve, reject) => { resolveCase = resolve; rejectCase = reject; });
  trustedCase.catch(() => {});
  const cancel = reason => { pendingCancel = reason; for(const w of loadingWaiters.values())w.reject(new Error('Loading canceled'));loadingWaiters.clear(); if (active) active.cancel(reason); else { process.stdin.destroy(); rejectCase(new Error('Canceled before parent case admission')); } };
  const notify = message => { if (process.connected) { try { process.send(message, () => {}); } catch { cancel('parent-channel-unavailable'); } } };
  const onMessage = message => {
    if(message?.type==='renderer-loading-result'){const w=loadingWaiters.get(message.id);loadingWaiters.delete(message.id);if(w){if(message.error)w.reject(new Error(message.error));else w.resolve(message.value);}}
    if (message?.type === 'renderer-cancel') cancel('parent-cancel');
    if (message?.type === 'renderer-case') {
      try {
        const value = validateParentCase(message.parentCase);
        if (receivedCase && JSON.stringify(receivedCase) !== JSON.stringify(value)) throw new Error('Parent case changed');
        receivedCase = value; resolveCase(value);
      } catch { cancel('invalid-parent-case'); }
    }
  };
  const term = () => cancel('SIGTERM'), interrupt = () => cancel('SIGINT'), disconnected = () => cancel('parent-disconnected');
  process.on('SIGTERM', term); process.on('SIGINT', interrupt);
  process.on('message', onMessage); process.on('disconnect', disconnected);
  try {
    if (process.argv.length !== 2) throw new Error('Renderer configuration must arrive on stdin only');
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; if (Buffer.byteLength(input) > 16_384) throw new Error('Renderer configuration exceeds its input bound'); }
    const rawConfig = JSON.parse(input); validateRendererConfig(rawConfig);
    const parentCase = await trustedCase;
    const result = await runRenderer(rawConfig, { parentCase, loading, bind: lifetime => { active = lifetime; if (pendingCancel) lifetime.cancel(pendingCancel); }, report: event => notify({ type: 'renderer-event', event }) });
    completedResult = result;
    notify({ type: 'renderer-complete', result });
    process.stdout.write(JSON.stringify(result) + '\n');
  } catch (error) {
    completedResult = error.result ?? { status: 'unavailable', cleanup: { status: active ? 'cleanup-unconfirmed' : 'no-browser-started' } };
    notify({ type: 'renderer-complete', result: completedResult });
    process.stderr.write(error.message + '\n'); process.exitCode = 1;
  } finally {
    if (active && !active.snapshot().canceled) active.dispose();
    // Unconfirmed cleanup keeps the IPC/worker ownership available for parent recovery.
    if (process.connected && ['closed-gracefully', 'closed-forced', 'no-browser-started'].includes(completedResult?.cleanup?.status)) process.disconnect();
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
