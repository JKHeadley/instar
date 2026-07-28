# Side-Effects Review — Doorway/Model Knowledge Registry, increment 2 (deterministic prober + scan-state + diff/debounce/breaker + dark job + §2.7 guard)

**Version / slug:** `doorway-model-registry-inc2`
**Date:** `2026-07-04`
**Author:** `echo`
**Second-pass reviewer:** `recommended` — this increment adds a real BLOCK authority (the §2.7 PreToolUse command-allowlist guard hook, which can `exit 2` and block a Bash call) and touches the `JobScheduler` claim/lease seam. See §1/§2/§4/§5.

## Summary of the change

Second rollout increment of `DOORWAY-MODEL-KNOWLEDGE-REGISTRY-SPEC.md` (§Rollout step 2), landed DARK: the doorway-scan job ships `enabled:false` and nothing runs on a cadence until an operator enables it (step 4). Artifacts:

1. **`scripts/doorway-scan.mjs`** — the deterministic prober (the security spine, §2.0). Owns all network I/O, secret handling, timeouts, size-caps, sanitization, scan-state read/write, diff/debounce/breaker, and the in-process `POST /view` + `POST /attention` delivery. Exports pure helpers for unit tests; `main()` runs only when invoked directly and is a harmless no-op stub in this dark increment.
2. **Machine-local scan-state schema** (`.instar/state/doorway-scan.json`, §1.3) — created lazily; an EXHAUSTIVE `loadScanState()` read-clamp re-validates every field on every load + a coverage test.
3. **Diff / debounce / breaker** (§2.3/§2.6) — asymmetric 2-scan debounce, a `consecutiveCompleteFailures` zero-doors breaker (retry-then-escalate, P22), tone-gate-safe attention body (raw diff → private view; never localhost/token link), and confirmed-delivery baseline advancement (no silent loss, no fresh-state flood).
4. **Dark job template** (`src/scaffold/templates/jobs/instar/doorway-scan.md`, `enabled:false`, tier1/haiku, `toolAllowlist:["Bash"]`) + the new **`perMachineIndependent` job-def flag** threaded `JobDefinition` → `PerSlugManifest` → `buildPerSlugManifest` → `InstallBuiltinJobs` → `manifestToJobDefinition`, honored at `JobScheduler.triggerJob` (skips the global jobSlug claim/lease).
5. **The §2.7 PreToolUse command-allowlist guard** (`doorway-scan-guard.js`) — installed via the always-overwrite `instar/` migration path + registered in `INSTAR_BASH_PRETOOLUSE_HOOKS`. A genuine stateful shell lexer allowing only the sanctioned prober invocation + a host-pinned localhost curl + read-only `test -f`/`cat`/`jq -r`.
6. **Manifest enrichment** — additive per-door `probe{}` + `candidateDoorways[]` (backward-compatible; the freshness lint ignores them).

## Decision-point inventory

- **`doorway-scan-guard.js` (NEW block authority)** — `add` — a PreToolUse Bash hook that can `exit 2` (block). SCOPE resolution fails OPEN; command matching fails CLOSED. Scoped by `INSTAR_JOB_SLUG==='doorway-scan'` (env-first, zero disk I/O off the hot path) → strict no-op in every other session.
- **`JobScheduler.triggerJob` claim/lease seam** — `modify` — a `perMachineIndependent` job now bypasses the claim check + claim-taking. Behavior for every job WITHOUT the flag is byte-identical (regression test).
- **The money gate (`meteredScopeGate`)** — `add` — a fail-closed predicate; refuses all metered spend on the scheduled/dark path. No metered completion is ever ISSUED in this increment (all test paths refuse before issuance).
- No message/dispatch/tone-gate decision point is touched.

---

## 1. Over-block

The §2.7 guard is a block authority, so over-block is the primary risk. Mitigations:
- **Tightly scoped:** the guard is an immediate no-op unless `INSTAR_JOB_SLUG==='doorway-scan'` (a scheduler-set env only the dark doorway-scan job carries). An instar-dev session, an interactive session, and every other job session hit the env-first fast path and ALLOW with zero disk I/O — proven by the subprocess test (a dangerous `cp` under another slug / no slug / a non-Bash tool all return exit 0).
- **Fails OPEN on scope:** any error resolving whether this is the doorway-scan session → ALLOW (exactly like the sibling `pr-hand-lease-guard.js`). A guard bug can never lock out an unrelated session's Bash. Proven (malformed stdin → exit 0).
- **Inside the doorway-scan session, over-block is intentional and bounded:** the guard fails CLOSED, but that session's only legitimate commands are the sanctioned shapes (the job body issues exactly `test -f …` and `node scripts/doorway-scan.mjs --scope free-probes`). A false-refuse there breaks the DARK scan loudly/safely, never widens scope — and the job is off by default, so the blast radius until step 4 is nil.
- The `enabled:false` job means the guard is never even reached on any agent until an operator opts in.

## 2. Under-block

- **Guard under-block (letting a source write through):** the matcher is an ALLOWLIST with a genuine lexer — anything not provably ONE sanctioned simple command is REFUSED, so obfuscation (compounds, substitution, redirects, env-prefix, interpreters, heredocs, `curl -o`, non-localhost curl) is refused by construction, not by a denylist that can miss an idiom. The adversarial subprocess matrix asserts every such primitive REFUSED.
- **Money under-gate (a scheduled run spending):** quadruple-gated + a self-standing scheduled-session refusal that holds even if the guard fails open. `meteredScopeGate` refuses on free-scope / scheduled-session / no-marker / absent-or-nonpositive-budget / unknown-or-stale-price / over-cap — tested on every branch. No completion is issued on any refused path.
- **Scheduler under-block:** `perMachineIndependent` deliberately bypasses the claim — that is the intended behavior for a per-machine-idempotent, cheap, local-only scan (the misuse warning on the flag documents the boundary). No shared/canonical state is mutated on the cadence.

## 3. Level-of-abstraction fit

Correct layers. The prober is a deterministic script (a detector that produces a signal + a maintainer diff), never a runtime authority over routing (canonical is authoritative — §1.1). The guard is a structural PreToolUse enforcer (Structure > Willpower) that replaces a prompt-level "don't edit source" wish. The `perMachineIndependent` flag lives on `JobDefinition` alongside its sibling `writesState`/`resumeOnReap` opt-in flags — the honest place for a per-job scheduling property.

## 4. Signal vs authority compliance

**Required reference:** `docs/signal-vs-authority.md`

- The **prober + diff/breaker** are SIGNAL: they surface a maintainer diff / a deduped escalation to the operator; they never auto-apply to source (enforced structurally by the guard + `toolAllowlist`), never gate a message.
- The **§2.7 guard** is an AUTHORITY, but its veto rests on an OBJECTIVE, decidable shape check (a genuine shell-grammar parse to a single sanctioned simple-command), not brittle inference; it fails OPEN on scope (never blocks the wrong session) and CLOSED on match (a refused command breaks the dark scan safely). This is the same shape as the sibling `pr-hand-lease-guard.js` and the eli16/release-fragment gates: block carried by an objective binary, escape hatch is "run a sanctioned command."
- The **money gate** is an authority over spend, and it is fail-closed by construction (no spend without an explicit manual marker + positive cap + known/fresh price + non-scheduled session).

---

## 5. Interactions

- **Shadowing:** the guard is one more PreToolUse Bash entry appended to `INSTAR_BASH_PRETOOLUSE_HOOKS`; it does not replace or reorder the existing guards, and it is a no-op outside the doorway-scan slug, so it never shadows another guard's decision.
- **Double-fire:** none. The prober is the sole in-process POST actor; the job session runs no data-carrying curl. The scan job is off; when enabled it is `perMachineIndependent` (one run per machine, deliberately — never a duplicated cross-machine side-effect, since it only reads local disk + writes local scan-state).
- **Races:** the scan-state is a single machine-local file written atomically (temp + rename); no cross-process shared mutable state. `perMachineIndependent` removes the claim path entirely, so there is no claim race for this job.
- **Feedback loops:** none. The prober never edits source; the diff is a review artifact. The breaker retries on a widening backoff (never a tight loop) and escalates once (deduped).

## 6. External surfaces

- **Other agents on the machine:** the guard fires fleet-wide on every Bash call but is a strict env-first no-op for all non-doorway-scan sessions (zero disk I/O on that path).
- **Install base:** the job template installs via `InstallBuiltinJobs` (non-destructive install-if-missing, on init + update). The guard hook installs via the always-overwrite `instar/` `migrateHooks()` path + `ensureInstarBashPreToolUseHooks` settings wiring — migrator-only for now (documented gap, matching pr-hand-lease-guard: fires only in the dark job's session, so inert until enabled; a fresh-init agent gets it on first auto-update, well before any operator enables the job). The prober + manifest enrichment ship as source (present on source-carrying agents; absent on pure end-user agents → the prober-presence gate makes the job a silent no-op).
- **External systems (Telegram/Slack/GitHub/Cloudflare):** none in this dark increment (the prober's `POST /attention`/`POST /view` are local + only reached when the job is enabled).
- **Persistent state:** `.instar/state/doorway-scan.json` (machine-local, created lazily on first scan, EXCLUDED from the backup manifest by design — never replicated onto another machine). No writes happen until the job is enabled.
- **Operator surface (Mobile-Complete Operator Actions):** none added in this increment (the `GET /doorways` read surface + CLAUDE.md awareness are increment 3). Not applicable.

## 6b. Operator-surface quality

No operator-facing surface added — not applicable. (When the job is enabled in step 4, its only operator output is a jargon-safe attention item + a private view — both already designed tone-gate-safe.)

---

## 7. Multi-machine posture (Cross-Machine Coherence)

- The **prober + manifest + guard + job template** are git-tracked instar source / built-in templates → byte-identical on every machine by construction. No divergence, no replication path.
- The **live scan-state** is machine-local BY DESIGN (a door's liveness is a physical fact of one disk — the identical posture of the Playwright Profile Registry). It is deliberately EXCLUDED from `BackupManager.includeFiles` — restoring one machine's disk-liveness onto another would be actively false. A `perMachineIndependent` job is the structural expression: each machine runs its own scan and writes its own scan-state; no lease elects a single machine.
- **One-voice / notices:** when enabled, each machine's diff uses a machine-qualified `sourceContext` (`doorway-scan:<machineId>`) so two machines' findings stay DISTINCT rows (never coalesced), and route to the alerts/hub topic (P23) — not a per-machine forum topic.

---

## 8. Rollback cost

DARK increment — **revert-and-patch, near-zero blast radius.**
- Hot-fix: `git revert` the PR. The guard hook is removed on the next migration (always-overwrite path re-writes the hook set; a settings entry pointing at a now-absent hook is a non-blocking error → Bash proceeds). The job template is retired by `InstallBuiltinJobs` when the template disappears (manifest flipped `enabled:false`+retired). The `perMachineIndependent` reverts cleanly (the flag simply disappears; jobs fall back to the claim path). The manifest `probe{}`/`candidateDoorways` are additive and the lint ignores them, so removing them is inert.
- Data migration: none — no scan-state is written while the job is off; a stale scan-state file is regenerable and self-healing (corrupt/old-schema → fresh, additive backfill).
- Agent state repair: none.
- User visibility: none — everything is off by default.
- Kill switch short of revert: the job stays `enabled:false`; the guard is inert outside the (disabled) doorway-scan session.

## Second-pass review

Concur with the review. I independently read the guard hook string in `getDoorwayScanGuardHook()`, the `JobScheduler.triggerJob` staged diff, the `meteredScopeGate`/`main()`/lexer in `scripts/doorway-scan.mjs`, and all three test files. The fail-OPEN-on-scope / fail-CLOSED-on-match claim is TRUE in the code: Region A returns `exit 0` for a non-Bash tool, a non-string command, any JSON-parse error, and — the load-bearing check — any session where `INSTAR_JOB_SLUG !== 'doorway-scan'` (plus an 8s fail-open stdin backstop), so an instar-dev/interactive/other-job session can never be over-blocked; Region B (only reachable inside the doorway-scan session) blocks with `exit 2` on any non-sanctioned command AND on a thrown lexer error. `lexSimpleCommand` is a genuine stateful char-by-char tokenizer (single/double-quote spans, backslash escapes, quote-state tracking — not a substring/regex scan) that refuses every operator/redirection/expansion/substitution/newline and the leading `NAME=` env-prefix; I could not find a source-write or metered-spend primitive that slips through (`node` is admitted only for the exact prober argv, so `node -e` is refused; curl is host-pinned to localhost with output-redirect and non-allowlisted flags refused), and the adversarial subprocess matrix drives the real deployed hook and asserts both directions. The `perMachineIndependent` bypass leaves the no-flag path byte-identical (the flag is falsy for normal jobs, so `claimPath`, `remoteHeld`, and the claim-taking `if/else-if/else` all reduce to the original expressions; the regression test confirms a no-flag job still yields on a remote claim while the pmi job never consults the claim path). The money gate is genuinely fail-closed: the self-standing scheduled-session refusal precedes the marker check, both defaults (`manualMarker=false`, `isScheduledSession=false`) still refuse, `main()` issues no completion and forces `free-probes` on the scheduled/dark path, and every refusal branch is unit-tested. (Note: `grep` for the literal `meteredScopeGate` intermittently returned nothing in this environment, but Read + `sed` both show the full branch-by-branch test suite at lines 223-254 — a tooling quirk, not a missing test.)
