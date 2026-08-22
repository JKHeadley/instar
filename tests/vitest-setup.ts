// Global vitest setup. Runs once before any test file loads.
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
