// E2E-PAIRING: EXEMPT — adds NO persistent AgentServer route; it is a transient
// boot-time listener that is closed before the real server binds. On for every
// agent since 2026-11-16 (monitoring.bootHealthBeacon.enabled: false turns it off).
// The module + the port handoff are covered by tests/unit/BootHealthBeacon.test.ts,
// and the beacon → real-server handoff on one port by
// tests/e2e/listen-early-boot-lifecycle.test.ts.
import http from 'node:http';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import { bootReadiness, BOOT_STATE_HEADER } from './BootReadiness.js';

/**
 * BootHealthBeacon — a minimal HTTP listener that answers *during* the server's
 * heavy boot, before the real AgentServer binds its port.
 *
 * Since 2026-11-16 it binds the SAME host the real server will (0.0.0.0 on a
 * multi-machine agent, so mesh peers reach it, not just localhost) and answers
 * with the typed boot state from BootReadiness: every route, `/health`
 * included, gets a 503 with `Retry-After`, `x-instar-boot-state: starting` and
 * `{ error: "starting", status: "starting", bootReadiness }`. It no longer
 * answers 200 on `/health`: a 200 means "serving" to every other caller, and the
 * supervisor reads the header as "alive, still booting".
 *
 * Earned 2026-06-07 (topic 21816 post-mortem, root cause #1 — "Liveness Before
 * Load"). The server's boot loads large TopicMemory/SemanticMemory and reconciles
 * dozens of sessions BEFORE AgentServer calls `app.listen`, so for ~5-6 min under
 * load nothing answers `/health`. The supervisor then judged the (alive, still-
 * booting) server unresponsive and restarted it → the restart-before-boot loop.
 * The grace bump (#979) widened the supervisor's patience; this is the durable
 * cure: a tiny beacon answers liveness from the very start of boot, so a restart
 * can never loop regardless of grace.
 *
 * Lifecycle: `start()` at the very top of the server boot; `stop()` immediately
 * before AgentServer's `listen` (the handoff). `stop()` fully releases the port —
 * it force-closes lingering connections so the real `listen` cannot hit
 * EADDRINUSE. The handoff gap has no heavy work between, so it is sub-second and
 * the supervisor never observes a hole.
 *
 * Deliberately minimal and dependency-free: it must come up instantly and never
 * itself become a source of boot latency or failure. Any error binding the
 * beacon is non-fatal to boot (the caller logs + proceeds without it).
 */
export class BootHealthBeacon {
  private server?: http.Server;
  private startedAt = 0;
  private healthAnswers = 0;
  private notReadyAnswers = 0;

  constructor(
    private readonly port: number,
    private readonly host: string = '127.0.0.1',
  ) {}

  /** Bind the beacon. Resolves once it is listening. Idempotent. */
  async start(): Promise<void> {
    if (this.server) return;
    const server = http.createServer((req, res) => {
      const url = (req.url || '').split('?')[0];
      const snap = bootReadiness().snapshot();
      // Every route, /health included, answers a typed 503 "starting, retry after N s".
      // A 200 means "serving" to every other caller (install, test-as-self, hooks,
      // PostRestartProof), so the beacon never says 200. The supervisor reads the
      // x-instar-boot-state header as "alive, still booting" (ServerSupervisor.probeHealth).
      if (req.method === 'GET' && (url === '/health' || url === '/health/')) this.healthAnswers += 1;
      else this.notReadyAnswers += 1;
      const retryAfter = snap.retryAfterSeconds ?? 5;
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': String(retryAfter), 'cache-control': 'no-store', [BOOT_STATE_HEADER]: 'starting' });
      res.end(JSON.stringify({
        error: 'starting',
        status: 'starting',
        message: `The server is starting. Retry after ${retryAfter} s.`,
        retryAfterSeconds: retryAfter,
        bootReadiness: snap,
      }));
    });
    // Don't let an idle keep-alive socket hold the port at handoff time.
    server.keepAliveTimeout = 1;
    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err);
      server.once('error', onError);
      server.listen(this.port, this.host, () => {
        server.removeListener('error', onError);
        resolve();
      });
    });
    this.server = server;
    this.startedAt = Date.now();
    bootReadiness().markListeningEarly(this.host);
  }

  /**
   * Close the beacon and fully release the port. Resolves only after the OS has
   * released the listening socket, so the caller can safely `listen` on the same
   * port immediately afterward. Idempotent.
   */
  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = undefined;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // Force any lingering (keep-alive) connections closed so `close` fires
      // promptly instead of waiting on an idle socket. Guarded — the method
      // exists on Node 18.2+; older runtimes simply rely on keepAliveTimeout.
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
    });
    // Recorded at handoff, not at start: the evidence log is wired only once AgentServer exists.
    featureEvidence.record('monitoring.bootHealthBeacon', { kind: 'fired', reason: 'answered through boot and handed over the port', context: { bootPhaseMs: Date.now() - this.startedAt, healthAnswers: this.healthAnswers, notReadyAnswers: this.notReadyAnswers, port: this.port } });
  }

  /** True while the beacon is bound. */
  get active(): boolean {
    return !!this.server;
  }
}
