# Side effects — `instar join --dir`

## What changes at runtime

`instar join <git-url> --code <code>` now honors an optional `--dir <path>` and
clones/joins the mesh into that directory. Previously the git-URL branch of
`joinMesh` forced the clone target to `<cwd>/<repo-name>` and **ignored**
`--dir` entirely (the directory-targeting half of the §1.3 init→join confusion
flagged in MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC).

The decision is a new pure, exported `resolveJoinDir(repoUrl, options)` in
`src/commands/joinDir.ts`:
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

- 3 source files: `src/commands/joinDir.ts` (new pure module),
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

## Follow-up (NOT in this change)

The Track-E two-machine `test-as-self` harness (`--join-mesh`/`--code`/
`--teardown` join-mode) that CONSUMES `instar join --dir` is the next PR. This
change is the foundational, independently-useful directory-targeting fix.
