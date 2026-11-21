// Throwaway server: real AgentServer + real TelegramAdapter (never started, so no bot, no network).
// Usage (cwd = an instar tree): tsx serve.ts <home> <port> [--seed <publicKeyB64u> <deviceId>]
import fs from 'node:fs'; import path from 'node:path'; import { monitorEventLoopDelay } from 'node:perf_hooks';
const root = process.cwd(); const imp = (p: string) => import(path.join(root, p));
const [home, portS, mode, pub, deviceId] = process.argv.slice(2); const port = Number(portS);
if (port === 4042 || port < 4190 || port > 4199) throw new Error('throwaway ports 4190-4199 only');
if (!home.includes('pr3609-proof')) throw new Error('throwaway home only');
const { AgentServer } = await imp('src/server/AgentServer.ts'); const { StateManager } = await imp('src/core/StateManager.ts');
const { InitiativeTracker } = await imp('src/core/InitiativeTracker.ts'); const { MachineIdentityManager } = await imp('src/core/MachineIdentity.ts');
const { TelegramAdapter } = await imp('src/messaging/TelegramAdapter.ts'); const { wireReadMarkerStore } = await imp('src/core/ConversationReadMarkersWiring.ts');
const { createMockSessionManager } = await imp('tests/helpers/setup.ts');
const stateDir = path.join(home, '.instar');
for (const d of ['state/sessions', 'state/jobs', 'logs']) fs.mkdirSync(path.join(stateDir, d), { recursive: true });
for (const [f, c] of [['config.json', '{}'], ['users.json', '[]']]) if (!fs.existsSync(path.join(stateDir, f))) fs.writeFileSync(path.join(stateDir, f), c);
const idm = new MachineIdentityManager(stateDir); if (!idm.hasIdentity()) await idm.generateIdentity({ name: 'pr3609 throwaway' });
const config = { projectName: 'pr3609proof', projectDir: home, stateDir, port, host: '127.0.0.1', authToken: 'throwaway-proof-token', developmentAgent: true,
  mobilePairing: { multiRoute: { enabled: false } }, sessions: { claudePath: '/usr/bin/true', maxSessions: 1, defaultMaxDurationMinutes: 30, protectedSessions: [], monitorIntervalMs: 60_000 },
  scheduler: { enabled: false, jobsFile: '', maxParallelJobs: 1 }, messaging: [], monitoring: {}, updates: { autoApply: false, enabled: false }, feedback: { enabled: false, webhookUrl: 'http://127.0.0.1:9/disabled', feedbackFile: path.join(stateDir, 'feedback.json') }, dispatches: { enabled: false, dispatchUrl: 'http://127.0.0.1:9/disabled', dispatchFile: path.join(stateDir, 'dispatches.json') }, tunnel: { enabled: false }, threadline: { ownerName: 'Fixture Owner' }, requestTimeoutMs: 120_000, version: '0.0.0-pr3609-proof' };
const telegram = new TelegramAdapter({ token: 'not-a-real-token', chatId: '-100123' }, stateDir);
const meta = JSON.parse(fs.readFileSync(path.join(home, 'fixture-meta.json'), 'utf8'));
const readMarkers = wireReadMarkerStore({ stateDir, emitter: null, peerStreams: null, ownMachineId: null, report: () => undefined, removalEvidence: () => false });
readMarkers.markCatchUpSettled();
const sm = createMockSessionManager() as any; sm.on = () => undefined; sm.injectMessage = () => true; sm.spawnInteractiveSession = async () => 'proof-session';
const tunnel = { lifecycleState: { lastState: 'stopped', activeProvider: null }, url: null, on: () => undefined };
const server = new AgentServer({ config, sessionManager: sm, state: new StateManager(stateDir), initiativeTracker: new InitiativeTracker(stateDir), tunnel, telegram, readMarkers } as never);
await server.start();
if (mode === '--seed') {
  meta.topics.forEach((id: number, i: number) => { telegram.registerTopicSession(id, `s-${id}`, `${process.env.TOPIC_PREFIX ?? "Fixture project"} ${String(i).padStart(3, "0")}`); if (id % 10 !== 1) telegram.unregisterTopic(id); });
  const svc = server.mobilePairing; const host = `127.0.0.1:${port}`;
  const c = svc.devices.createPending({ deviceName: 'Fixture phone', label: null, publicKey: pub, host, userId: null, role: 'owner' }); if (!c.ok) throw new Error(c.reason);
  const f = (svc.devices as any).read(); f.devices.find((d: any) => d.id === c.device.id).id = deviceId; (svc.devices as any).write(f);
  const at = new Date().toISOString(); if (!svc.keyLedger.recordActivation({ ...c.device, id: deviceId }, 'owner-agent', at)) throw new Error('ledger');
  if (svc.devices.applyConfirm(deviceId, { ok: true, approvedVia: 'owner-agent', approvedAt: at })?.status !== 'active') throw new Error('confirm');
  readMarkers.setBaseline('owner', Date.UTC(2026, 9, 1));
  const idOf = (r: any) => r.eventId ?? `${r.fromUser ? 'in' : 'out'}:${r.messageId}`;
  meta.topics.forEach((id: number, i: number) => { const rows = meta.rows[id]; if (!rows?.length || i % 4 === 3) return;
    const back = i % 4 === 0 ? 0 : i % 4 === 1 ? Math.min(5, rows.length - 1) : Math.floor(rows.length * 0.9) ; const r = rows[Math.max(0, rows.length - 1 - back)];
    readMarkers.advance('owner', `telegram:${id}`, { atMs: r.atMs, id: idOf(r) }); });
  await new Promise((r) => setTimeout(r, 1500)); await server.stop(); await telegram.stop(); console.log('seeded'); process.exit(0);
}
const h = monitorEventLoopDelay({ resolution: 10 }); h.enable();
const { PerformanceObserver } = await import('node:perf_hooks'); let gcMs = 0; new PerformanceObserver((l) => { for (const e of l.getEntries()) gcMs = Math.max(gcMs, Math.round(e.duration)); }).observe({ entryTypes: ['gc'] });
const httpMod = await import('node:http'); const slow: Array<{ d: number; label: string }> = []; const recent: string[] = []; const stalls: Array<{ gapMs: number; recent: string[] }> = [];
const origEmit = httpMod.Server.prototype.emit; (httpMod.Server.prototype as any).emit = function (ev: string, ...args: any[]) { if (ev === 'request') { const t0 = performance.now(); const label = String(args[0]?.url ?? '').replace(/[?].*$/, '').replace(/[0-9]+/g, 'N') + (String(args[0]?.url ?? '').includes('before=') ? '?before' : ''); args[1]?.on?.('finish', () => { const d = Math.round(performance.now() - t0); slow.push({ d, label }); slow.sort((x, y) => y.d - x.d); slow.length = Math.min(slow.length, 8); }); const raw = String(args[0]?.url ?? ''); const q = raw.includes('?') ? '?' + [...new URLSearchParams(raw.split('?')[1]).keys()].join('&') : ''; const u = raw.replace(/[?].*$/, '').replace(/[0-9]+/g, 'N') + q + ' scans=' + ((telegram as any).tailWarmScans ?? '-') + ' gc=' + gcMs; recent.push(u); if (recent.length > 4) recent.shift(); } return (origEmit as any).call(this, ev, ...args); };
let peakRss = process.memoryUsage().rss; let lastBeat = performance.now(); let maxGap = 0; const rssTimer = setInterval(() => { const n = performance.now(); if (n - lastBeat > 400) stalls.push({ gapMs: Math.round(n - lastBeat), recent: [...recent] }); maxGap = Math.max(maxGap, n - lastBeat); lastBeat = n; const r = process.memoryUsage().rss; if (r > peakRss) peakRss = r; }, 10);
fs.writeFileSync(path.join(home, 'ready'), String(process.pid)); console.log('ready');
const done = async () => { h.disable(); clearInterval(rssTimer); fs.writeFileSync(path.join(home, 'event-loop.json'), JSON.stringify({ maxMs: Math.round(Math.max(h.max / 1e6, maxGap)), histMaxMs: Math.round(h.max / 1e6), gapMaxMs: Math.round(maxGap), stalls, slow, p99Ms: Math.round(h.percentile(99) / 1e6), peakRssMb: Math.round(peakRss / 1048576) })); await server.stop(); await telegram.stop(); process.exit(0); };
process.on('SIGTERM', done); process.on('SIGINT', done);
