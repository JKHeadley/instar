# Side effects — `instar join --dir`

## What changes at runtime

`instar join <git-url> --code <code>` now honors an optional `--dir <path>` and
clones/joins the mesh into that directory. Previously the git-URL branch of
`joinMesh` forced the clone target to `<cwd>/<repo-name>` and **ignored**
`--dir` entirely (the directory-targeting half of the §1.3 init→join confusion
flagged in MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC).

The decision is a new pure, exported `resolveJoinDir(repoUrl, options)` in
`src/utils/joinDir.ts`:
- git URL + `--dir` → the resolved `--dir` (NEW).
- git URL + no `--dir` → `<cwd>/<repo-name>` (historical default, UNCHANGED).
- non-git (tunnel) URL + `--dir` → the resolved `--dir`.
- non-git URL + no `--dir` → `process.cwd()` (UNCHANGED).

## Who is affected

- **Operators running `instar join` WITHOUT `--dir`:** ZERO change. Every
  no-`--dir` path is byte-identical to the prior behavior (git URL still lands
  at `<cwd>/<repo-name>`; tunnel/local still uses `process.cwd()`).
- **Operators (or orchestrators) passing `--dir`:** the join now lands at the
  chosen directory. This is what unblocks an automated harness from joining a
  mesh into a specific throwaway home (e.g. the future Track-E two-machine
  `test-as-self` bring-up).

## Blast radius

- 3 source files: `src/utils/joinDir.ts` (new pure module),
  `src/commands/machine.ts` (uses `resolveJoinDir`; removed the inline
  `let projectDir`/`path.resolve(repoName)` override + a now-redundant `repoName`
  local), `src/cli.ts` (adds the `-d, --dir` option to the `join` command).
- No config, no schema, no `.instar`-installed file, no migration: this is a CLI
  flag + source logic, picked up by existing agents on the normal dist update.

## Failure modes considered

- **Breaking an existing join?** No — `--dir` is optional and every absent-`--dir`
  path is byte-identical to before. The pure unit tests assert both the new
  (git+dir → dir) and unchanged (git+no-dir → cwd/repoName; tunnel+no-dir → cwd)
  branches.
- **Targeting a wrong/dangerous dir?** `--dir` is operator-supplied and resolved
  with `path.resolve`; `joinMesh` still loads config from the resolved dir and
  fails loudly ("Not an instar project") if it isn't a valid instar home, exactly
  as before. No deletion or overwrite is introduced.
- **`--dir` collides with an existing clone?** Unchanged behavior: if the target
  dir already exists, `joinMesh` logs "Using existing repo" and proceeds (the
  `fs.existsSync(projectDir)` branch), now reporting the actual `projectDir`.

## Tests

`tests/unit/joinDir.test.ts` (12 tests): both sides of the decision boundary —
git/SSH/tunnel URLs × `--dir`/no-`--dir`, relative-`--dir` resolves to absolute,
and `isGitCloneUrl` discrimination. `tsc --noEmit` clean.

## Decision-point inventory

- `resolveJoinDir(repoUrl, options)` — modified — deterministically chooses the
  local destination from an explicit operator option or the historical default.
  This is an enumerable path-selection invariant, not a judgment call.

## 1. Over-block

No new block/allow surface. Existing validation and clone failures remain owned
by `joinMesh`; the destination helper only selects the path they receive.

## 2. Under-block

The helper does not decide whether an existing destination is semantically the
right mesh checkout. That remains the existing `joinMesh` validation path and is
unchanged by this fix.

## 3. Level-of-abstraction fit

The path calculation is a pure utility and now lives in `src/utils/joinDir.ts`.
Keeping it outside `src/commands/` also prevents the documentation inventory
from misclassifying the helper as a user-facing CLI command. `machine.ts`
continues to own clone/join orchestration.

## 4. Signal vs authority compliance

Required reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).

- [x] No — this change has no judgment-based block/allow surface.

The branch selection is mechanical: an explicit `--dir` wins; otherwise the
historical default wins. No detector or heuristic is granted authority.

## 4b. Judgment-point check

No competing-signals decision point is introduced. The domain is fully
enumerable from URL class and presence or absence of the explicit directory
option.

## 5. Interactions

- **Shadowing:** none; the helper replaces the prior inline target calculation.
- **Double-fire:** none; it is called once per `joinMesh` invocation.
- **Races:** none; the helper is pure and holds no state.
- **Feedback loops:** none.

PR #662 supplies the independently useful throwaway-harness correction that can
consume this directory targeting; neither PR duplicates the other's behavior.

## 6. External surfaces

The only external surface is the optional `-d`/`--dir` CLI flag. Calls without
it retain their prior destination. There is no schema, database, network
protocol, dashboard, or external-service change.

## 6b. Operator-surface quality

No dashboard or approval surface is touched. The CLI option is plain-language
and optional; no raw internal identifier is exposed as primary content.

## 7. Multi-machine posture

Machine-local by design: a join destination is a filesystem path on the machine
being enrolled and therefore should differ per machine. Mesh identity and keys
continue through the existing join protocol. This change emits no user-facing
notice, adds no durable state of its own, and generates no URL.

## 8. Rollback cost

Pure code rollback: revert the helper/flag wiring and ship a patch. No migration,
state repair, or cleanup is required; operators using `--dir` would temporarily
return to the old ignored-option behavior.

## Conclusion

The fix is bounded and non-breaking. The side-effects review caused one
standards adaptation: the pure helper now lives in `src/utils`, which preserves
the CLI documentation inventory's meaning while keeping the logic independently
testable. Clear to ship after the current gates pass.

## Second-pass review

Not required: this change does not touch messaging, session lifecycle,
recovery, trust, or a gate/sentinel/watchdog.

## Class-Closure Declaration

No agent-authored prompt, hook, config, skill, or standards defect — not
applicable.
