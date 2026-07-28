/**
 * Job-level MCP access scoping (`mcpAccess: 'none' | 'project'`).
 *
 * Context: every job session is a headless one-shot `claude -p` spawn that
 * inherits the FULL project .mcp.json — playwright, auth-required remote
 * servers, the lot — even though the shipped built-in jobs are bash/curl-only.
 * That's pure MCP boot cost on every spawn (health-check runs every 5 min)
 * plus the auth-required-remote-MCP headless hang hazard documented in
 * docs/specs/LOOP-SESSION-NO-MCP-SPEC.md (the mentor-loop 4.5-min stall).
 *
 * The fix reuses the existing `disableProjectMcp` spawn plumbing (already
 * battle-tested by the mentor autonomous-fix loop) and exposes it per-job:
 *
 *   frontmatter `mcpAccess: none`
 *     → InstallBuiltinJobs derives manifest.mcpAccess
 *     → validateManifest enforces the closed two-value set
 *     → manifestToJobDefinition carries it onto the JobDefinition
 *     → JobScheduler.spawnJobSession passes disableProjectMcp: true
 *     → claudeHeadlessExtraFlags emits --strict-mcp-config --mcp-config '{}'
 *
 * Both sides of every boundary: absent/'project' → byte-for-byte legacy
 * behavior (no flag); invalid values fail loud at validateManifest.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { StateManager } from '../../../src/core/StateManager.js';
import { SessionManager } from '../../../src/core/SessionManager.js';
import { JobScheduler } from '../../../src/scheduler/JobScheduler.js';
import { SafeFsExecutor } from '../../../src/core/SafeFsExecutor.js';
import { validateManifest } from '../../../src/scheduler/AgentMdJobLoader.js';
import { buildPerSlugManifest } from '../../../src/scheduler/buildPerSlugManifest.js';
import { installBuiltinJobs } from '../../../src/scheduler/InstallBuiltinJobs.js';
import { loadJobs } from '../../../src/scheduler/JobLoader.js';
import type {
  JobDefinition,
  JobSchedulerConfig,
  SessionManagerConfig,
} from '../../../src/core/types.js';

// ── validateManifest: the closed two-value set ─────────────────────────────

function baseManifest(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    slug: 'mcp-test',
    origin: 'instar',
    schedule: '*/5 * * * *',
    priority: 'low',
    expectedDurationMinutes: 1,
    enabled: true,
    execute: { type: 'agentmd' },
    ...extra,
  };
}

describe('validateManifest mcpAccess (closed set)', () => {
  it('accepts "none"', () => {
    const m = validateManifest(baseManifest({ mcpAccess: 'none' }), 'mcp-test');
    expect(m.mcpAccess).toBe('none');
  });

  it('accepts "project"', () => {
    const m = validateManifest(baseManifest({ mcpAccess: 'project' }), 'mcp-test');
    expect(m.mcpAccess).toBe('project');
  });

  it('accepts absent (legacy manifests stay valid)', () => {
    const m = validateManifest(baseManifest(), 'mcp-test');
    expect(m.mcpAccess).toBeUndefined();
  });

  it('rejects values outside the set, loudly naming the field', () => {
    expect(() => validateManifest(baseManifest({ mcpAccess: 'all' }), 'mcp-test'))
      .toThrow(/"mcpAccess" must be "project" or "none"/);
    expect(() => validateManifest(baseManifest({ mcpAccess: true }), 'mcp-test'))
      .toThrow(/mcpAccess/);
  });
});

// ── buildPerSlugManifest: the single typed constructor carries it ──────────

describe('buildPerSlugManifest mcpAccess pass-through', () => {
  const required = {
    slug: 's',
    origin: 'instar' as const,
    schedule: '*/5 * * * *',
    priority: 'low' as const,
    expectedDurationMinutes: 1,
    enabled: true,
    execute: { type: 'agentmd' as const },
  };

  it('carries mcpAccess when provided', () => {
    expect(buildPerSlugManifest({ ...required, mcpAccess: 'none' }).mcpAccess).toBe('none');
    expect(buildPerSlugManifest({ ...required, mcpAccess: 'project' }).mcpAccess).toBe('project');
  });

  it('omits the key entirely when undefined (no "mcpAccess": undefined in JSON)', () => {
    const m = buildPerSlugManifest(required);
    expect('mcpAccess' in m).toBe(false);
  });
});

// ── InstallBuiltinJobs: frontmatter → manifest derivation ──────────────────

describe('installBuiltinJobs mcpAccess derivation', () => {
  let workspace: string;
  let agentStateDir: string;
  let packageRoot: string;
  let templatesDir: string;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mcpaccess-'));
    agentStateDir = path.join(workspace, 'agent', '.instar');
    packageRoot = path.join(workspace, 'pkg');
    templatesDir = path.join(packageRoot, 'src', 'scaffold', 'templates', 'jobs', 'instar');
    fs.mkdirSync(templatesDir, { recursive: true });
    fs.mkdirSync(agentStateDir, { recursive: true });
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(workspace, {
      recursive: true, force: true,
      operation: 'job-mcp-access.test cleanup',
    });
  });

  function writeTemplate(slug: string, fmExtra: string) {
    fs.writeFileSync(
      path.join(templatesDir, `${slug}.md`),
      `---\nname: ${slug}\ndescription: d\nschedule: "*/5 * * * *"\npriority: low\nexpectedDurationMinutes: 1\nmodel: haiku\nenabled: true\ntoolAllowlist: "*"\nunrestrictedTools: true\n${fmExtra}---\nbody\n`,
      'utf-8',
    );
  }

  function readManifest(slug: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(
      path.join(agentStateDir, 'jobs', 'schedule', `${slug}.json`), 'utf-8',
    ));
  }

  it('derives mcpAccess: none from frontmatter into the manifest', () => {
    writeTemplate('no-mcp-job', 'mcpAccess: none\n');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toContain('no-mcp-job');
    expect(readManifest('no-mcp-job').mcpAccess).toBe('none');
  });

  it('omits mcpAccess when frontmatter does not declare it (legacy default)', () => {
    writeTemplate('legacy-job', '');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toContain('legacy-job');
    expect('mcpAccess' in readManifest('legacy-job')).toBe(false);
  });

  it('treats an out-of-set frontmatter value as undeclared (fail-safe to legacy)', () => {
    writeTemplate('typo-job', 'mcpAccess: nope\n');
    const report = installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    expect(report.installed).toContain('typo-job');
    expect('mcpAccess' in readManifest('typo-job')).toBe(false);
  });

  it('round-trips through the loader: manifest mcpAccess lands on the JobDefinition', () => {
    writeTemplate('rt-job', 'mcpAccess: none\n');
    installBuiltinJobs({ agentStateDir, packageRoot, port: 4042 });
    const jobs = loadJobs(path.join(agentStateDir, 'jobs.json'));
    const rt = jobs.find(j => j.slug === 'rt-job');
    expect(rt).toBeDefined();
    expect(rt!.mcpAccess).toBe('none');
    // And the frontmatter key does not trip the closed-set whitelist guard.
    expect(rt!.frontmatter?.mcpAccess).toBe('none');
  });
});

// ── JobScheduler: spawn-time plumbing (the decision boundary) ──────────────

describe('JobScheduler mcpAccess spawn plumbing', () => {
  let stateDir: string;
  let state: StateManager;
  let sessionManager: SessionManager;
  let scheduler: JobScheduler;
  let spawnSpy: ReturnType<typeof vi.fn>;

  const schedulerConfig: JobSchedulerConfig = {
    jobsFile: '',
    enabled: true,
    maxParallelJobs: 1,
    quotaThresholds: { normal: 50, elevated: 70, critical: 85, shutdown: 95 },
  };

  beforeEach(() => {
    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-mcpspawn-'));
    fs.mkdirSync(path.join(stateDir, 'state', 'sessions'), { recursive: true });
    fs.mkdirSync(path.join(stateDir, 'state', 'jobs'), { recursive: true });
    state = new StateManager(stateDir);

    const sessionConfig: SessionManagerConfig = {
      tmuxPath: '/usr/bin/tmux',
      claudePath: '/usr/bin/claude',
      projectDir: stateDir,
      maxSessions: 10,
      protectedSessions: [],
      completionPatterns: [],
    };
    sessionManager = new SessionManager(sessionConfig, state);

    spawnSpy = vi.fn().mockResolvedValue({
      id: 'stub', name: 'stub', status: 'running', tmuxSession: 'stub-tmux',
      startedAt: new Date().toISOString(),
    });
    (sessionManager as unknown as { spawnSession: typeof spawnSpy }).spawnSession = spawnSpy;

    scheduler = new JobScheduler(schedulerConfig, sessionManager, state, stateDir);
  });

  afterEach(() => {
    SafeFsExecutor.safeRmSync(stateDir, {
      recursive: true, force: true,
      operation: 'tests/unit/scheduler/job-mcp-access.test.ts:afterEach',
    });
  });

  function makeJob(mcpAccess?: 'project' | 'none'): JobDefinition {
    return {
      slug: `mcp-${mcpAccess ?? 'absent'}`,
      name: 'M',
      description: 'M',
      schedule: '*/5 * * * *',
      priority: 'low',
      expectedDurationMinutes: 1,
      model: 'haiku',
      enabled: true,
      execute: { type: 'prompt', value: 'do the thing' },
      ...(mcpAccess !== undefined ? { mcpAccess } : {}),
    };
  }

  async function trigger(job: JobDefinition): Promise<{ disableProjectMcp?: boolean }> {
    (scheduler as unknown as { jobs: JobDefinition[] }).jobs = [job];
    await scheduler.triggerJob(job.slug, 'test');
    await new Promise(r => setImmediate(r));
    const call = spawnSpy.mock.calls[0]?.[0] as { disableProjectMcp?: boolean };
    return { disableProjectMcp: call?.disableProjectMcp };
  }

  it("mcpAccess: 'none' → spawnSession receives disableProjectMcp: true", async () => {
    const { disableProjectMcp } = await trigger(makeJob('none'));
    expect(disableProjectMcp).toBe(true);
  });

  it("mcpAccess: 'project' → disableProjectMcp stays undefined (legacy spawn)", async () => {
    const { disableProjectMcp } = await trigger(makeJob('project'));
    expect(disableProjectMcp).toBeUndefined();
  });

  it('mcpAccess absent → disableProjectMcp stays undefined (legacy spawn)', async () => {
    const { disableProjectMcp } = await trigger(makeJob());
    expect(disableProjectMcp).toBeUndefined();
  });
});

// ── Shipped templates: the 14 utility built-ins actually declare it ────────

describe('shipped utility templates declare mcpAccess: none', () => {
  const REAL_TEMPLATES_DIR = path.join(process.cwd(), 'src', 'scaffold', 'templates', 'jobs', 'instar');
  const EXPECTED_NONE = [
    'health-check',
    'commitment-detection',
    'correction-analyzer',
    'release-readiness-check',
  ];
  // Orchestration jobs deliberately keep project MCP this slice — they drive
  // sessions/mentees and we do not change the apprenticeship machinery here.
  const EXPECTED_UNCHANGED = ['mentor-onboarding', 'overseer-guardian', 'evolution-proposal-implement'];

  it.each(EXPECTED_NONE)('%s declares mcpAccess: none', (slug) => {
    const t = fs.readFileSync(path.join(REAL_TEMPLATES_DIR, `${slug}.md`), 'utf-8');
    expect(t).toMatch(/^mcpAccess: none$/m);
  });

  it.each(EXPECTED_UNCHANGED)('%s does NOT declare mcpAccess (orchestration family unchanged)', (slug) => {
    const t = fs.readFileSync(path.join(REAL_TEMPLATES_DIR, `${slug}.md`), 'utf-8');
    expect(t).not.toMatch(/mcpAccess/);
  });
});
