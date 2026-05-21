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
