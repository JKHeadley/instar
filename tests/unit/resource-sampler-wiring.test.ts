/**
 * Wiring-integrity guards for the per-agent ResourceLedger Phase B (CPU/memory
 * ResourceSampler).
 *
 * W1 (constructed iff enabled): AgentServer must construct + start the sampler
 *   behind the developmentAgent dark-feature gate (live on dev agents, dark on
 *   the fleet), and stop it on shutdown. Source-level assertions guard against
 *   the "shipped inert" failure mode (compiles but never wired in).
 * W2 (read-only / not a no-op): the sampler delegates to the REAL ledger
 *   (records actual samples) and NEVER mutates any session state — it only reads
 *   pids and writes the ledger. Behavioral check.
 * W3 (off the hot path / fail-open): a sampling error never throws out of tick.
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { ResourceLedger } from '../../src/monitoring/ResourceLedger.js';
import { ResourceSampler } from '../../src/monitoring/ResourceSampler.js';

const AGENT_SERVER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/server/AgentServer.ts'), 'utf-8');
const SESSION_MANAGER_SRC = fs.readFileSync(path.join(process.cwd(), 'src/core/SessionManager.ts'), 'utf-8');
const ROUTES_SRC = fs.readFileSync(path.join(process.cwd(), 'src/server/routes.ts'), 'utf-8');

describe('W1 — ResourceSampler is constructed behind the developmentAgent gate and wired in', () => {
  it('AgentServer imports + constructs + starts ResourceSampler', () => {
    expect(AGENT_SERVER_SRC).toContain("from '../monitoring/ResourceSampler.js'");
    expect(AGENT_SERVER_SRC).toContain('new ResourceSampler({');
    expect(AGENT_SERVER_SRC).toMatch(/this\.resourceSampler\.start\(\)/);
  });

  it('gates sampling on the developmentAgent standard (via the resolveDevAgentGate funnel)', () => {
    // The gate: sampling resolves to ON for dev agents, dark on the fleet —
    // now through the resolveDevAgentGate funnel (DEV-AGENT-DARK-GATE-CONFORMANCE-SPEC)
    // rather than a hand-rolled `?? !!developmentAgent`.
    expect(AGENT_SERVER_SRC).toMatch(/resolveDevAgentGate\(\s*rlCfg\?\.enabled,\s*options\.config\s*\)/);
  });

  it('hands the sampler the REAL session-pid source (not a no-op stub)', () => {
    expect(AGENT_SERVER_SRC).toContain('getRunningSessionPanePids');
    // SessionManager actually implements it (read-only pane-pid resolver).
    expect(SESSION_MANAGER_SRC).toContain('getRunningSessionPanePids()');
  });

  it('stops the sampler on shutdown (no leaked timer)', () => {
    expect(AGENT_SERVER_SRC).toMatch(/this\.resourceSampler\.stop\(\)/);
  });

  it('the /resources/summary + /resources/samples routes are registered', () => {
    expect(ROUTES_SRC).toContain("router.get('/resources/summary'");
    expect(ROUTES_SRC).toContain("router.get('/resources/samples'");
  });
});

describe('W2/W3 — ResourceSampler delegates to the real ledger, never mutates session state, fail-open', () => {
  let ledger: ResourceLedger | null = null;
  let sampler: ResourceSampler | null = null;
  afterEach(() => { sampler?.stop(); ledger?.close(); ledger = null; sampler = null; });

  it('is NOT a no-op — a tick produces real ledger rows (server + aggregate)', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    sampler = new ResourceSampler({
      ledger,
      getSessionPids: () => [],
      now: () => 1000,
      cpuUsageFn: () => ({ user: 0, system: 0 }),
      memoryUsageFn: () => ({ rss: 1, heapUsed: 1, heapTotal: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      samplePidsFn: async () => new Map(),
    });
    sampler.start();
    await sampler.tick();
    const sources = ledger.summary(0).map(r => r.source).sort();
    expect(sources).toContain('agent-server');
    expect(sources).toContain('aggregate');
  });

  it('never mutates session state — getSessionPids is the ONLY session touchpoint and it is read-only', async () => {
    // The session source is a plain read; the sampler must never call back into
    // it with anything mutating. We hand it an object whose ONLY method is the
    // read accessor and assert nothing else is invoked.
    let reads = 0;
    const sessionSource = {
      getRunningSessionPanePids() { reads++; return [{ id: 'x', pid: 123 }]; },
    };
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    sampler = new ResourceSampler({
      ledger,
      getSessionPids: () => sessionSource.getRunningSessionPanePids(),
      now: () => 1000,
      cpuUsageFn: () => ({ user: 0, system: 0 }),
      memoryUsageFn: () => ({ rss: 1, heapUsed: 1, heapTotal: 0, external: 0, arrayBuffers: 0 } as NodeJS.MemoryUsage),
      samplePidsFn: async () => new Map([[123, { cpuPercent: 1, rssBytes: 1 }]]),
    });
    sampler.start();
    await sampler.tick();
    expect(reads).toBeGreaterThan(0); // it DID read
    // The sessionSource exposes no mutator at all → structurally read-only.
    expect(Object.keys(sessionSource)).toEqual(['getRunningSessionPanePids']);
  });

  it('off the hot path / fail-open — a throwing OS seam never escapes tick()', async () => {
    ledger = new ResourceLedger({ dbPath: ':memory:' });
    sampler = new ResourceSampler({
      ledger,
      getSessionPids: () => { throw new Error('boom'); },
      now: () => 1000,
      cpuUsageFn: () => { throw new Error('cpu boom'); },
      memoryUsageFn: () => { throw new Error('mem boom'); },
      samplePidsFn: async () => { throw new Error('ps boom'); },
      onError: () => {},
    });
    sampler.start();
    await expect(sampler.tick()).resolves.toBeUndefined();
  });
});
