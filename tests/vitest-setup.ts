// Global vitest setup. Runs once before any test file loads.

import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

//
// Strip git environment overrides inherited from the parent process FIRST.
// When git invokes a hook (e.g. .husky/pre-push runs `npm run test:smoke`),
// it sets GIT_DIR / GIT_WORK_TREE / GIT_INDEX_FILE / GIT_OBJECT_DIRECTORY /
// GIT_COMMON_DIR in the child env, pinning every git command in every
// descendant process to the parent repo regardless of cwd. Tests that spawn
// `git init` / `git commit` in a tmpdir then end up committing into the
// real repo on whichever branch happens to be checked out — exactly the
// failure that produced the "# Test Project" README clobber on main
// (PR #130, PR #277). Clearing these vars here closes the failure class
// for every test, no matter how the test spawns git.
delete process.env.GIT_DIR;
delete process.env.GIT_WORK_TREE;
delete process.env.GIT_INDEX_FILE;
delete process.env.GIT_OBJECT_DIRECTORY;
delete process.env.GIT_COMMON_DIR;

// Strip INSTAR_* environment inherited from a LIVE agent session — the same
// failure class as the git vars above, with a different variable family.
//
// A test that spawns a shipped script (the Telegram/Slack relay scripts, the
// hooks, the CLI) and passes `{ ...process.env }` hands the child the ambient
// `INSTAR_AGENT_HOME`, `INSTAR_AUTH_TOKEN`, `INSTAR_PORT` and friends. Those
// scripts resolve their owning agent from exactly those variables and PREFER
// them over cwd — so when the suite is run from inside a live agent session the
// child silently abandons the test's tmp project and operates on the REAL one.
//
// This is not hypothetical, and it ran for three days before anyone noticed.
// Between 2026-08-19 and 2026-08-21 the relay tests wrote 21 fixture rows into
// the LIVE outbound relay queue, and the drainer delivered 15 of them to a real
// Telegram topic — nine copies of "Your weekly check finished — all clear." and
// six of "hello world", each landing as if the agent had sent it. ("All clear"
// asserts a check ran and passed; none had.) A second topic took six copies of
// "hello from test", five of which exhausted their retries and raised
// delivery-failure escalations. The tests ALSO failed, because they looked for
// their rows in the tmp project — but note the asymmetry: the failure is the
// visible half. A leak like this mutates live state just as happily under a test
// that still passes, which is why the fix belongs here rather than in the tests
// that happened to go red.
//
// Two tests had already tried to defend against this by clearing INSTAR_PORT and
// INSTAR_AUTH_TOKEN by name, each labelled "hermetic vs live-session env".
// Enumerating the dangerous variables is what failed: the harmful one was simply
// not on the list. So the default here is STRIP, with an explicit allowlist for
// the few variables that steer the test RUNNER itself rather than the code under
// test. A test that needs one of these sets it itself, after this file runs.
const INSTAR_ENV_ALLOWLIST = new Set([
  // Host test-runner concurrency bound — the documented kill switch and its cap.
  // Read in globalSetup (which runs before this file), allowlisted so that stays
  // true no matter where the read moves to.
  'INSTAR_HOST_TEST_SEMAPHORE',
  'INSTAR_HOST_TEST_MAX',
]);
for (const key of Object.keys(process.env)) {
  if (key.startsWith('INSTAR_') && !INSTAR_ENV_ALLOWLIST.has(key)) {
    delete process.env[key];
  }
}

// Bind every test's ephemeral server to loopback only.
//
// `server.listen(0)` with no host binds the wildcard address, but test clients
// connect to 127.0.0.1. On macOS and BSD, Node's SO_REUSEADDR lets a wildcard
// socket share a port number with another process's 127.0.0.1 socket, and the
// kernel hands connections to the MORE SPECIFIC socket. So with suites running
// side by side, a test could ask its own fixture a question and get the answer
// from a stranger's server: "expected 401 to be 201", "expected 404 to be 201",
// on files that pass alone. Measured on macOS with 4000 ports held on 127.0.0.1
// by a second process: 2313 of 25000 wildcard servers had their request answered
// by that process; bound to 127.0.0.1, 0 of 6000 were. Two sockets cannot share
// one specific address, so an explicit bind closes the class for every test,
// present or future. An explicit host or a fixed port is left alone.
// Guard: tests/unit/test-setup-loopback-bind.test.ts.
//
// The patch sits on `_listen2`, the step after address resolution, not on
// `listen`: passing a host to `listen` defers the bind by a tick, and many
// callers read `server.address()` straight after `listen(0)`. No address plus
// port 0 reaches here only for an ephemeral bind with no host.
{
  type Listen2 = (address: string | null, port: number, addressType: number, ...rest: unknown[]) => unknown;
  const proto = net.Server.prototype as unknown as { _listen2: Listen2 };
  const realListen2 = proto._listen2;
  proto._listen2 = function bindEphemeralToLoopback(this: net.Server, address, port, addressType, ...rest) {
    return address === null && port === 0
      ? realListen2.call(this, '127.0.0.1', 0, 4, ...rest)
      : realListen2.call(this, address, port, addressType, ...rest);
  };
}

// Force the Codex user-config home onto a per-process temp dir. Every test
// in this process, and every child it spawns with `{ ...process.env }`, then
// reads/writes `$CODEX_HOME/config.toml` HERE and never the operator's real
// `~/.codex/config.toml`.
//
// This is not hypothetical either. On 2026-10-20 ThreadlineBootstrap still
// wrote `[mcp_servers."threadline"]` into the shared Codex config on every
// boot, and tests/e2e/threadline/identity-discovery-wiring.test.ts (which boots
// the Threadline stack in-process) rewrote the operator's REAL ~/.codex/config.toml
// to point at a worktree, a /var/folders temp state dir and `--agent-name
// no-id-agent`. The boot-time write is gone (see src/commands/codex.ts for the
// explicit `instar codex connect <agent>` replacement) — this line is the
// structural guarantee that no test, present or future, can reach the real file
// through CODEX_HOME's default. A test that wants to exercise the default-path
// fallback sets CODEX_HOME itself, after this file runs (the registry
// unit test does exactly that). A test that needs the operator's REAL Codex
// login must opt in explicitly by copying auth.json into its own CODEX_HOME,
// the way tests/e2e/codex-worker-local-api-lifecycle.test.ts already does.
//
// The guard test tests/unit/test-setup-hermetic-codex-home.test.ts fails if
// this ever stops holding.
{
  const tmpCodexHome = fs.mkdtempSync(path.join(os.tmpdir(), 'instar-vitest-codex-home-'));
  process.env.CODEX_HOME = tmpCodexHome;
  // Raw fs.rmSync on purpose (allowlisted in scripts/lint-no-direct-destructive.js):
  // this file runs BEFORE every test module, so importing SafeFsExecutor here
  // would load src/core (and the real node:child_process) into the module
  // cache ahead of any test's vi.mock — which silently un-mocked child_process
  // for GitSync / ProfileCompiler / supervisor-preflight when first tried.
  // The target is this process's own mkdtemp dir under os.tmpdir(), never the
  // source tree.
  process.once('exit', () => {
    try {
      fs.rmSync(tmpCodexHome, { recursive: true, force: true });
    } catch {
      // best-effort cleanup of a temp dir — never fail the run over it
    }
  });
}

// Pre-set git identity env vars so SafeGitExecutor's identity lookup
// doesn't fall through to `git config --global user.name/email` reads via
// execFileSync. Tests that mock execFileSync would otherwise have their
// mock return values consumed by the identity lookup before the actual
// test calls, producing confusing failures like "expected git push to be
// called once, got zero" because the diff-staged check returned the empty
// string from the identity-read mock.
process.env.GIT_AUTHOR_NAME ||= 'Test';
process.env.GIT_AUTHOR_EMAIL ||= 'test@instar.local';
process.env.GIT_COMMITTER_NAME ||= 'Test';
process.env.GIT_COMMITTER_EMAIL ||= 'test@instar.local';
