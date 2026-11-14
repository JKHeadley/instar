// E2E-PAIRING: EXEMPT — ships dark (monitoring.bootHealthBeacon.enabled, default
// off) and adds NO persistent AgentServer route; it is a transient boot-time
// listener that is closed before the real server binds. The module + the critical
// port-handoff are covered by tests/unit/BootHealthBeacon.test.ts; a full-boot e2e
// can't cleanly reproduce the heavy-boot timing window, so live wiring is verified
// at the canary rollout step (flag on, observe /health during a real boot on Echo),
// which is the documented next step in the post-mortem plan.
import http from 'node:http';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';

/**
 * BootHealthBeacon — a minimal HTTP listener that answers `/health` with 200
 * *during* the server's heavy boot, before the real AgentServer binds its port.
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
      if (req.method === 'GET' && (url === '/health' || url === '/health/')) {
        this.healthAnswers += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', phase: 'booting' }));
        return;
      }
      // Everything else is not ready yet — the real server isn't up.
      this.notReadyAnswers += 1;
      res.writeHead(503, { 'content-type': 'application/json', 'retry-after': '5' });
      res.end(JSON.stringify({ status: 'warming', phase: 'booting' }));
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
