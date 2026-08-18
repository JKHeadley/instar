// safe-git-allow: test fixture cleanup uses fs.rmSync on tmp dirs only.
/**
 * Unit tests — the stand-down PreToolUse guard hook and its settings wiring.
 *
 * Spec: docs/specs/duplicate-session-standdown.md §"Enforcement half 1"
 *
 * The hook is a GENERATED script that runs in its own process on every tool
 * call, so these tests execute the real generated body with `node` rather than
 * asserting on the template string. What they pin:
 *  - the allowlist is exactly the four observation-local tools, and an UNKNOWN
 *    tool name (a tool that does not exist yet) is treated as mutating;
 *  - the marker fast path short-circuits with ZERO HTTP;
 *  - every uncertainty fails OPEN (no session env, feature off, no marker,
 *    server down, malformed input);
 *  - the block message interpolates ONLY the server's machine id.
 *
 * And the anti-drift contract: init.ts AND PostUpdateMigrator both consume the
 * SAME ensure function, so a new agent and an existing agent cannot diverge.
 */

import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile, execFileSync } from 'node:child_process';
import * as http from 'node:http';
import { PostUpdateMigrator } from '../../src/core/PostUpdateMigrator.js';
import { StandDownRegistry } from '../../src/core/StandDownRegistry.js';
import {
  INSTAR_WILDCARD_PRETOOLUSE_HOOKS,
  INSTAR_WILDCARD_PRETOOLUSE_FILENAMES,
  ensureInstarWildcardPreToolUseHooks,
  type SettingsMatcherEntry,
} from '../../src/core/instarSettingsHooks.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

let hookPath: string;
let projectDir: string;

/**
 * Run the hook exactly as Claude Code would: JSON on stdin, env for identity.
 *
 * ASYNC deliberately. An earlier version used execFileSync, which blocks this
 * process's event loop — so the in-process stub server below could never accept
 * the hook's request and every verdict test "passed" by timing out into the
 * fail-open path. A test that passes because the thing under test never ran is
 * worse than no test.
 */
function runHook(input: object, env: Record<string, string>): Promise<{ code: number; stderr: string }> {
  return new Promise((resolve) => {
    const child = execFile(
      'node', [hookPath],
      { env: { ...process.env, INSTAR_AGENT_HOME: projectDir, CLAUDE_PROJECT_DIR: projectDir, ...env }, encoding: 'utf-8', timeout: 15_000 },
      (err, _stdout, stderr) => {
        const code = err ? ((err as { code?: number }).code ?? -1) : 0;
        resolve({ code, stderr: stderr ?? '' });
      },
    );
    child.stdin?.end(JSON.stringify(input));
  });
}

function writeConfig(cfg: object): void {
  fs.mkdirSync(path.join(projectDir, '.instar'), { recursive: true });
  fs.writeFileSync(path.join(projectDir, '.instar', 'config.json'), JSON.stringify(cfg), 'utf-8');
}

/** The marker is written where the REGISTRY writes it — derived from the
 *  registry itself, never hand-written. A hand-written fixture path is how 24
 *  green tests covered a path production never wrote to. */
function markerPathFor(agentHome: string): string {
  return new StandDownRegistry({ stateDir: path.join(agentHome, '.instar') }).markerPath;
}

function writeMarker(sessions: string[]): void {
  const target = markerPathFor(projectDir);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, JSON.stringify({ sessions }), 'utf-8');
}

beforeAll(() => {
  // Extract the REAL generated hook body — never a hand-copied duplicate.
  const migrator = new PostUpdateMigrator({ projectDir: repoRoot } as never);
  const body = (migrator as unknown as { getStandDownGuardHook(): string }).getStandDownGuardHook();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-hook-'));
  hookPath = path.join(dir, 'standdown-guard.js');
  fs.writeFileSync(hookPath, body, { mode: 0o755 });
});

beforeEach(() => {
  projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-proj-'));
  // Feature ON, marker listing our session, but NO server: the default fixture
  // is "everything says block except the authority", which fails OPEN.
  writeConfig({ port: 59999, authToken: 't', monitoring: { standDown: { enabled: true } } });
  writeMarker(['topic-1']);
});
afterEach(() => { try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* best effort */ } });

const ENV = { INSTAR_SESSION_NAME: 'topic-1', INSTAR_AUTH_TOKEN: 'real-token-value' };

describe('standdown-guard hook — path agreement with the registry', () => {
  it('reads the marker from EXACTLY the path StandDownRegistry writes it to', () => {
    // The single most consequential thing to pin. The first version of the hook
    // dropped the `.instar` segment (`<home>/state/...` instead of
    // `<home>/.instar/state/...`), so the read always ENOENT'd, the hook exited
    // 0, and the tool muzzle could not fire AT ALL in production — with every
    // hook test green, because the fixtures wrote to the same wrong path.
    // Comparing against the registry's own computed path is the only assertion
    // that cannot drift with the fixtures.
    const home = '/tmp/agent-home-fixture';
    const registryPath = new StandDownRegistry({ stateDir: path.join(home, '.instar') }).markerPath;
    const body = fs.readFileSync(hookPath, 'utf-8');
    const segments = /pathMod\.join\(agentHome, ([^)]*)'standdown-active\.json'\)/.exec(body);
    expect(segments).not.toBeNull();
    const hookPathForHome = path.join(home, ...segments![1].split(',').map((t) => t.trim().replace(/^'|',?$/g, '')).filter(Boolean), 'standdown-active.json');
    expect(hookPathForHome).toBe(registryPath);
  });
});

describe('standdown-guard hook — allowlist', () => {
  it.each(['Read', 'Glob', 'Grep', 'TodoWrite'])('never blocks the observation-local tool %s', async (tool) => {
    expect((await runHook({ tool_name: tool }, ENV)).code).toBe(0);
  });

  it('does NOT allowlist file mutation, subagents, or egress', () => {
    // These MUST be absent from the allowlist: an unmatched Write could rewrite
    // the guard script itself, a Task spawns new work (and would block drain
    // forever), and WebFetch is egress.
    const body = fs.readFileSync(hookPath, 'utf-8');
    const allowlist = /var ALLOWLIST = \[(.*?)\]/s.exec(body)?.[1] ?? '';
    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'WebFetch', 'WebSearch', 'Bash']) {
      expect(allowlist).not.toContain(`'${tool}'`);
    }
  });
});

describe('standdown-guard hook — fail-open on every uncertainty', () => {
  it('exits 0 with no INSTAR_SESSION_NAME (headless one-shots are out of reach)', async () => {
    expect((await runHook({ tool_name: 'Bash' }, {})).code).toBe(0);
  });

  it('exits 0 when the feature is explicitly disabled, even on a dev agent', async () => {
    // An explicit false must win over the dev-agent gate — no per-call chatter
    // when the operator deliberately turned it off.
    writeConfig({ port: 59999, developmentAgent: true, monitoring: { standDown: { enabled: false } } });
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 when no config is readable', async () => {
    fs.rmSync(path.join(projectDir, '.instar', 'config.json'));
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 when the marker file is absent (the steady state for every session)', async () => {
    fs.rmSync(markerPathFor(projectDir));
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 when the marker does not list THIS session (no HTTP is even attempted)', async () => {
    writeMarker(['some-other-session']);
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 when the marker is torn/corrupt', async () => {
    fs.writeFileSync(markerPathFor(projectDir), '{"sessions":[', 'utf-8');
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 when the server is unreachable (a broken guard never freezes a session)', async () => {
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('exits 0 on malformed stdin', () => {
    const r = (() => {
      try {
        execFileSync('node', [hookPath], { input: 'not json', env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...ENV }, encoding: 'utf-8', timeout: 15_000 });
        return 0;
      } catch (e) { return (e as { status?: number }).status ?? -1; }
    })();
    expect(r).toBe(0);
  });
});

describe('standdown-guard hook — the authoritative verdict', () => {
  let server: http.Server;
  let port: number;
  let seen: Array<Record<string, unknown>>;
  let respond: (body: object) => object;
  const EXPECTED_TOKEN = 'real-token-value';

  beforeEach(async () => {
    seen = [];
    respond = () => ({ verdict: 'allow' });
    server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (c) => { data += c; });
      req.on('end', () => {
        // The stub ENFORCES the bearer. A stub that ignores Authorization cannot
        // see the failure this exists to catch: the hook once sent
        // `Bearer [object Object]` (config holds the externalized-secret MARKER,
        // not the token) and every call 401'd into the fail-open path — a muzzle
        // that could never fire once, in production, with green tests.
        if (req.headers.authorization !== `Bearer ${EXPECTED_TOKEN}`) {
          seen.push({ url: req.url, unauthorized: true, sent: req.headers.authorization });
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: 'Missing or invalid Authorization header' }));
          return;
        }
        const parsed = JSON.parse(data || '{}');
        seen.push({ url: req.url, ...parsed });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(respond(parsed)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
    // The config holds the externalized-secret MARKER, exactly as it does on a
    // real install after secret externalization — never a plaintext token.
    writeConfig({ port, authToken: { secret: true }, monitoring: { standDown: { enabled: true } } });
  });
  afterEach(async () => { await new Promise<void>((r) => server.close(() => r())); });

  it('blocks (exit 2) on a block verdict and names ONLY the machine id', async () => {
    respond = () => ({ verdict: 'block', ownerMachineId: 'laptop-a' });
    const r = await runHook({ tool_name: 'Bash' }, ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('standing down');
    expect(r.stderr).toContain('laptop-a');
    // One-turn-actionable and truthful: it must NOT tell the session to finish
    // its current step while blocking the steps.
    expect(r.stderr).toContain('remain idle');
    expect(r.stderr).not.toMatch(/finish your current step/i);
  });

  it('allows on a dry-run (would-block) verdict — observe-only blocks nothing', async () => {
    respond = () => ({ verdict: 'allow', wouldBlock: true, reason: 'dry-run' });
    expect((await runHook({ tool_name: 'Bash' }, ENV)).code).toBe(0);
  });

  it('sends the session name and tool so the server can key its verdict + audit', async () => {
    respond = () => ({ verdict: 'allow' });
    await runHook({ tool_name: 'Edit' }, ENV);
    expect(seen[0]).toMatchObject({ url: '/standdown/evaluate', sessionName: 'topic-1', tool: 'Edit' });
  });

  it('blocks an UNKNOWN future tool name — unknown is mutating, not observation', async () => {
    respond = () => ({ verdict: 'block', ownerMachineId: 'laptop-a' });
    expect((await runHook({ tool_name: 'SomeToolInventedNextYear' }, ENV)).code).toBe(2);
    expect(seen[0]).toMatchObject({ tool: 'SomeToolInventedNextYear' });
  });

  it('resolves agent-scoped files from INSTAR_AGENT_HOME, not CLAUDE_PROJECT_DIR', async () => {
    // The worktree case, and the discriminating assertion: a worktree checkout
    // has no .instar/config.json and no state/, so a guard that resolved those
    // from CLAUDE_PROJECT_DIR silently no-opped for exactly the sessions doing
    // mutating work. Proven by whether the evaluate request ARRIVES — both
    // outcomes exit 0 (fail-open), so exit code alone proves nothing.
    respond = () => ({ verdict: 'allow' });
    const worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'standdown-worktree-'));
    try {
      const run = (env: Record<string, string>) => new Promise<void>((resolve) => {
        const child = execFile('node', [hookPath], { env: { ...process.env, ...env }, encoding: 'utf-8', timeout: 15_000 }, () => resolve());
        child.stdin?.end(JSON.stringify({ tool_name: 'Bash' }));
      });
      // Project dir = the worktree, agent home UNSET → dies at the config gate.
      await run({ CLAUDE_PROJECT_DIR: worktree, INSTAR_SESSION_NAME: 'topic-1', INSTAR_AUTH_TOKEN: EXPECTED_TOKEN });
      expect(seen).toHaveLength(0);
      // Same worktree project dir, agent home SET → config + marker resolve and
      // the authoritative call is made.
      await run({ CLAUDE_PROJECT_DIR: worktree, INSTAR_AGENT_HOME: projectDir, INSTAR_SESSION_NAME: 'topic-1', INSTAR_AUTH_TOKEN: EXPECTED_TOKEN });
      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({ sessionName: 'topic-1', tool: 'Bash' });
    } finally { fs.rmSync(worktree, { recursive: true, force: true }); }
  });

  it('authenticates with INSTAR_AUTH_TOKEN, not the config secret MARKER', async () => {
    // The regression: `'Bearer ' + cfg.authToken` where authToken is the marker
    // object `{secret:true}` stringifies to `Bearer [object Object]`, the route
    // 401s, and the hook fail-opens on EVERY call, forever.
    respond = () => ({ verdict: 'block', ownerMachineId: 'laptop-a' });
    const r = await runHook({ tool_name: 'Bash' }, ENV);
    expect(seen[0]).not.toHaveProperty('unauthorized');
    expect(r.code).toBe(2); // the verdict was actually reached and obeyed
  });

  it('fails OPEN (never blocks) when the token is genuinely wrong', async () => {
    // Fail-open on 401 is correct — a broken credential must not freeze a
    // session — which is precisely why the test above has to exist: this
    // behaviour makes a permanent auth failure invisible.
    respond = () => ({ verdict: 'block', ownerMachineId: 'laptop-a' });
    const r = await runHook({ tool_name: 'Bash' }, { ...ENV, INSTAR_AUTH_TOKEN: 'wrong' });
    expect(seen[0]).toMatchObject({ unauthorized: true });
    expect(r.code).toBe(0);
  });

  it('makes NO request at all for an allowlisted tool', async () => {
    await runHook({ tool_name: 'Read' }, ENV);
    expect(seen).toHaveLength(0);
  });
});

describe('wildcard PreToolUse settings wiring (anti-drift)', () => {
  it('the canonical wildcard set is exactly the stand-down guard', () => {
    expect(INSTAR_WILDCARD_PRETOOLUSE_FILENAMES).toEqual(['standdown-guard.js']);
    expect(INSTAR_WILDCARD_PRETOOLUSE_HOOKS[0].blocking).toBe(true);
    // Shorter than the lease guard's 6s: this fires on EVERY tool call.
    expect(INSTAR_WILDCARD_PRETOOLUSE_HOOKS[0].timeout).toBe(2000);
  });

  it('creates the `*` matcher when absent and is idempotent', () => {
    const preToolUse: SettingsMatcherEntry[] = [{ matcher: 'Bash', hooks: [] }];
    expect(ensureInstarWildcardPreToolUseHooks(preToolUse)).toEqual(['standdown-guard.js']);
    expect(preToolUse.find((e) => e.matcher === '*')?.hooks).toHaveLength(1);
    expect(ensureInstarWildcardPreToolUseHooks(preToolUse)).toEqual([]);
  });

  it('preserves hand-curated entries in an existing `*` matcher', () => {
    const preToolUse: SettingsMatcherEntry[] = [{ matcher: '*', hooks: [{ type: 'command', command: 'echo mine' }] }];
    ensureInstarWildcardPreToolUseHooks(preToolUse);
    const hooks = preToolUse[0].hooks!;
    expect(hooks[0].command).toBe('echo mine');
    expect(hooks[1].command).toContain('standdown-guard.js');
  });

  it('BOTH the new-agent path and the existing-agent path consume the shared ensure function', () => {
    // The dark-guardrail gap was "the list lived in two places that drifted".
    // This is what makes drift impossible rather than merely unlikely.
    const initSrc = fs.readFileSync(path.join(repoRoot, 'src/commands/init.ts'), 'utf-8');
    const migratorSrc = fs.readFileSync(path.join(repoRoot, 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(initSrc).toContain('ensureInstarWildcardPreToolUseHooks');
    expect(migratorSrc).toContain('ensureInstarWildcardPreToolUseHooks');
  });

  it('the migrator installs the guard SCRIPT as well as the settings entry', () => {
    // A settings entry pointing at a script that was never written is a hook that
    // fails on every tool call; both halves have to ship together.
    const migratorSrc = fs.readFileSync(path.join(repoRoot, 'src/core/PostUpdateMigrator.ts'), 'utf-8');
    expect(migratorSrc).toContain("'standdown-guard.js'), this.getStandDownGuardHook()");
  });
});
