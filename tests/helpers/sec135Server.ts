/**
 * SEC-135 test helper: a real AgentServer with a recommended-services ledger and a configured owner,
 * so the confirm page mints tokens and answers through the production wiring (ctx.publicPin).
 *
 * Stranger requests use the tunnel's own name with a cf-connecting-ip (the real client) or a Host that
 * is not one of the agent's names (an unattributable loopback caller), never plain localhost. The
 * machine itself is Host 127.0.0.1:<port>.
 */
import crypto from 'node:crypto';
import request from 'supertest';
import { AgentServer } from '../../src/server/AgentServer.js';
import { RecommendedServicesLedger } from '../../src/recommended/RecommendedServicesLedger.js';
import { createTempProject, createMockSessionManager, type TempProject } from './setup.js';
import type { InstarConfig } from '../../src/core/types.js';
import type { MachineKeyLookup, MachineSigner } from '../../src/core/AppRecordSignatures.js';

export const SEC135_AUTH = 'sec135-auth-token';
export const SEC135_PIN = '246810';
export const SEC135_PORT = 4042;
export const SEC135_TUNNEL_HOST = 'sec135.trycloudflare.test';
export const SEC135_SERVICE = 'bitwarden';

const { privateKey } = crypto.generateKeyPairSync('ed25519');
const signer: MachineSigner = {
  machineId: () => 'm_sec135', signerKeyHash: () => 'h',
  sign: (p: string) => ({ machineId: 'm_sec135', signerKeyHash: 'h', sig: crypto.sign(null, Buffer.from(p), privateKey).toString('base64') }) as ReturnType<MachineSigner['sign']>,
};

export interface Sec135Boot {
  project: TempProject;
  server: AgentServer;
  app: ReturnType<AgentServer['getApp']>;
}

export function bootSec135(opts: { approvalLinks?: boolean; throttle?: Record<string, number>; developmentAgent?: boolean; project?: TempProject } = {}): Sec135Boot {
  // Passing a project reuses its state directory: a restart (durable counters survive, the throttle does not).
  const project = opts.project ?? createTempProject();
  const config = {
    projectName: 'sec135', projectDir: project.dir, stateDir: project.stateDir, port: SEC135_PORT,
    authToken: SEC135_AUTH, dashboardPin: SEC135_PIN, developmentAgent: opts.developmentAgent ?? true,
    security: {
      pinThrottle: { enabled: true, windowMs: 600_000, softFailures: 3, ...(opts.throttle ?? {}) },
      ...(opts.approvalLinks === undefined ? {} : { approvalLinks: { enabled: opts.approvalLinks } }),
    },
    sessions: { tmuxPath: '/usr/bin/tmux', claudePath: '/usr/bin/claude', projectDir: project.dir, maxSessions: 3, protectedSessions: [], completionPatterns: [] },
    scheduler: { jobsFile: '', enabled: false, maxParallelJobs: 2, quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 } },
    users: [], messaging: [],
    monitoring: { quotaTracking: false, memoryMonitoring: false, healthCheckIntervalMs: 30000, promptGate: { ownerId: 777 } },
  } as unknown as InstarConfig;
  const ledger = new RecommendedServicesLedger({ stateDir: project.stateDir, signer, keyLookup: (() => ({ status: 'unknown' })) as unknown as MachineKeyLookup });
  const sm = createMockSessionManager() as unknown as { on?: unknown };
  sm.on = () => undefined;
  const server = new AgentServer({
    config, sessionManager: sm, state: project.state,
    tunnel: { url: `https://${SEC135_TUNNEL_HOST}` },
    recommendedServicesLedger: ledger,
  } as never);
  return { project, server, app: server.getApp() };
}

type App = Sec135Boot['app'];
const CONFIRM = `/recommended-services/${SEC135_SERVICE}/confirm`;

/** A stranger over the tunnel: the real client is cf-connecting-ip. */
export const strangerGet = (app: App, ip: string) => request(app).get(CONFIRM)
  .set('Host', SEC135_TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https');
export const strangerPost = (app: App, ip: string) => request(app).post(CONFIRM)
  .set('Host', SEC135_TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https').set('X-Instar-Request', '1');
export const strangerUnlock = (app: App, ip: string) => request(app).post('/dashboard/unlock')
  .set('Host', SEC135_TUNNEL_HOST).set('cf-connecting-ip', ip).set('x-forwarded-proto', 'https');
/** The machine itself. */
export const localGet = (app: App) => request(app).get(CONFIRM).set('Host', `127.0.0.1:${SEC135_PORT}`);
export const localPost = (app: App) => request(app).post(CONFIRM).set('Host', `127.0.0.1:${SEC135_PORT}`).set('X-Instar-Request', '1');
export const localUnlock = (app: App) => request(app).post('/dashboard/unlock').set('Host', `127.0.0.1:${SEC135_PORT}`);

/** Unlocks once over the tunnel and returns the remembered-browser cookie. */
export async function markerCookie(app: App, ip = '198.51.100.200'): Promise<string> {
  const res = await strangerUnlock(app, ip).send({ pin: SEC135_PIN });
  if (res.status !== 200) throw new Error(`unlock for a marker failed: ${res.status}`);
  const cookie = String((res.headers['set-cookie'] as unknown as string[] | undefined)?.[0] ?? '').split(';')[0];
  if (!cookie.startsWith('instar_pin_ok=')) throw new Error('no marker cookie');
  return cookie;
}

/** Opens a confirm page as a stranger and returns its token. */
export async function strangerToken(app: App, ip = '192.0.2.1'): Promise<string> {
  const res = await strangerGet(app, ip);
  if (res.status !== 200 || !res.body.token) throw new Error(`confirm page did not open: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.token as string;
}

/** A body asking for the copied secret names: repeatable on one token, changes nothing. */
export const namesBody = (token: string, pin: string) => ({ token, pin, answer: 'names', reason: 'none', shutdown: false });

/** Drains the strangers' public aggregate with wrong sign-in PINs from distinct networks. */
export async function drainAggregate(app: App, n: number): Promise<void> {
  for (let i = 0; i < n; i++) await strangerUnlock(app, `203.0.${100 + i}.1`).send({ pin: '000000' });
}
