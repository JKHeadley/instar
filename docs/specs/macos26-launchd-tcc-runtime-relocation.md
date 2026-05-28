---
title: macOS 26 launchd-TCC runtime relocation + peer-independent escalation + reboot-persistent updater coalesce
date: 2026-05-27
author: echo
approved: true
approved-by: Justin
approved-via: Telegram topic 5447 ("approved" at 2026-05-28, after reading the convergence report + the two material-change disclosures; proceeding with recommended defaults on all four open questions)
eli16-overview: macos26-launchd-tcc-runtime-relocation.eli16.md
related-specs:
  - boot-wrapper-plist-coherence.md
  - silently-stopped-trio.md
review-convergence: "2026-05-28T07:05:59.019Z"
review-iterations: 4
review-completed-at: "2026-05-28T07:05:59.019Z"
review-report: "docs/specs/reports/macos26-launchd-tcc-runtime-relocation-convergence.md"
---

# Spec — macOS 26 launchd-TCC runtime relocation

**Date:** 2026-05-27 (PDT)
**Author:** echo
**Status:** converged (4 iterations, 2026-05-28) — awaiting user approval

## Triggering incident

The b2lead-insights agent (macOS 26.5 / Darwin 25.5.0, project at `~/Documents/Projects/b2lead-insights/`) went silent for ~2 hours after a reboot. launchd `posix_spawn` of `.instar/bin/node` returned `Operation not permitted` (EPERM, exit 78 / EX_CONFIG) on every retry — on macOS 26.x the kernel enforces TCC on the spawn path and launchd has no key to ~/Documents. Node never executed; the `.err` log was 0 bytes because the plist points `StandardErrorPath` into the same locked folder. Every in-process self-heal was moot. The fleet watchdog detected the crash-loop but had no way to page the user (single-agent machine; no healthy peer; the watchdog is itself TCC-blind to Documents). The local Scout (a TCC-consented Claude Code session) recovered it manually.

## Verified root cause (file:line, `main` @ v1.3.46)

- `src/commands/setup.ts:1624-1625` — plist `ProgramArguments = [<projectDir>/.instar/bin/node, …]`; TCC-protected for Documents projects.
- `src/commands/setup.ts:1640-1649` — plist `WorkingDirectory = projectDir`, `StandardOutPath`/`StandardErrorPath` under `<projectDir>/.instar/logs/` → 0-byte logs on 26.
- `src/commands/setup.ts:1065,1217,1620` — stale comment "user-installed node is not subject to TCC."
- `src/templates/scripts/instar-watchdog.sh:285` — `escalate_via_peer` requires a healthy peer; `:649` — no exit-78 branch.
- `src/core/Config.ts:603-606` — `stateDir = join(projectDir,'.instar')`; **890 `config.stateDir` consumers + 42 direct `join(projectDir,'.instar',…)` recomputes** (grep-verified).
- `src/core/PostUpdateMigrator.ts:725-728` — `migrateAsync()` runs `this.migrate()` + `migrateParityRenderings()` only. It does **NOT** call `runPendingSteps()`; **zero `registerStep` callers exist in `src/`** (grep-verified) — the step engine is dormant. `migrate()`-body methods read `this.config.projectDir`/`projectName` directly (35 uses). → §1 uses a `migrate()`-body method, not the dormant engine.
- `~/Documents` and `~/Library` are the **same APFS volume** (`/dev/disk3s5`, `df`-verified) → relocation is an atomic `rename()`, not a copy.
- No macOS-version / FDA / Documents-trap / EX_CONFIG handling anywhere in `src/` (grep-verified).

**Why Echo is immune.** Echo runs from `~/.instar/agents/echo/` — not TCC-protected.

---

## The central constraint

**No always-on background process can escape TCC.** The server, lifeline, fleet watchdog, and in-process migrator are all launchd-spawned and lack a TCC key to ~/Documents on macOS 26. Therefore a dead, not-yet-relocated agent cannot relocate itself with zero touch — the OS forbids it. The only contexts with a key are interactive/consented: an `instar setup`/`update`/`relocate` run from a foreground shell, and the local Claude Code (Scout) session (whose SessionStart hook runs inside that consent).

### Honest outcome matrix

The escalation credential (§3) lets the watchdog page autonomously — **but only once it has been armed**, which happens at `setup`/`relocate` (consented) or on any healthy boot of an agent that can read its own config (a relocated or non-TCC agent — an unrelocated Documents agent on macOS 26 *cannot* heal-boot, so "healthy boot arms it" only ever applies to already-safe agents). This is the irreducible OS limit: a credential cannot be armed from a TCC-blind launchd boot of an unrelocated agent, because writing it requires reading the token from the locked config.

| Agent state | Outcome |
|---|---|
| **New install** (any location) | Relocated + credential armed at `setup` (consented). Immune from birth; future deaths page autonomously. Zero touch ever. |
| **Existing, alive, in a TCC folder** | Relocates on next **interactive** `instar update` (the launchd auto-update tick alone cannot — it surfaces "run `instar update` once to finish moving to a safe location"). Once relocated, every healthy boot arms the credential, so any **future** death pages autonomously. |
| **Existing, already dead, in a TCC folder, that has NEVER run with this fix** (b2lead today) | **No autonomous page is possible** — the credential was never armed and the token is unreadable from any background context. The watchdog surfaces a local `osascript` toast (best-effort, on-machine only) and the page is delivered by the first **consented** context that runs (a Scout/Claude session's SessionStart hook — which is how b2lead was actually found — or a peer agent if one exists). Recovery needs **exactly one** consented action — click Allow on the FDA prompt (§5) **or** run `instar relocate` once — which also arms the credential, so every death **after** that pages autonomously. |

The fix makes the page **autonomous for any agent armed by a prior healthy/consented run**, the recovery **one-time**, and the agent **self-healing thereafter**. It does **not** claim to retroactively reach an agent that died before the fix ever ran — that is the one case TCC genuinely forbids, and the spec says so rather than overclaiming (this was the round-2/round-3 convergence correction).

---

## 1. Scope A — Runtime relocation (consented-context only)

**Files:** new `src/core/InstarRuntimeRoot.ts`; `src/core/Config.ts` (symlink-follow + boot-arg resolver + consistency assertion); `src/commands/setup.ts` (`installMacOSLaunchAgent`, `installBootWrapper`, `ensureStableNodeSymlink` made runtime-root-aware); `src/core/PostUpdateMigrator.ts` (new `migrateRuntimeRoot()` **method**, called from `migrate()`); new `src/commands/relocate.ts` + registration in `src/cli.ts`; `src/commands/server.ts` + `src/commands/listener.ts` (boot `--runtime-root` parse + consistency assertion).

### Runtime root

`instarRuntimeRoot(projectName, projectDir)` → `~/Library/Application Support/instar/<projectName>-<shortHash(projectDir)>/` (macOS) / `~/.local/share/instar/<…>/` (Linux). The hash suffix prevents projectName collisions. **The hash is computed once at first relocation and persisted in `relocate.json`; subsequent boots read the stored root and never recompute** (resolves NEW-6: a projectDir-string change can't orphan live state). The root holds the **entire** `.instar/` tree (bin, instar-boot.cjs, shadow-install, state, config.json, logs, watchdog-state, lifeline.lock, listener.sock, secrets, autonomous, caches, machine-identity, threadline store, migrator ledger) — not an enumerated subset.

### Pointer — two distinct layers (resolves NEW-3/NEW-4/adversarial NEW-H1)

The spec deliberately separates two mechanisms that serve two different process contexts:

1. **Boot entrypoint (launchd-spawned, TCC-blind):** the plist passes an **absolute** `--runtime-root <root>` arg and uses absolute artifact paths: `ProgramArguments = [<root>/bin/node, <root>/instar-boot.cjs, lifeline, start, --dir <projectDir>, --runtime-root <root>]`; `StandardOutPath`/`StandardErrorPath` → `<root>/logs/`; `WorkingDirectory = <root>` (fixes the 0-byte-log / HIGH-4 symptom). This path **never reads anything under Documents** — not even the `.instar` symlink (a `readlink` under Documents EPERMs on 26). The server/lifeline parse `--runtime-root` and set their state dir to it directly.
2. **Consented-context callsites (Scout, interactive CLI — have a TCC key):** `<projectDir>/.instar` is a **whole-directory symlink → root**. The 890 `config.stateDir` consumers and 42 direct recomputes follow it transparently with **zero code change** when run from a consented context. Per-subdir/per-file symlinks are rejected — `installBootWrapper`/`ensureStableNodeSymlink` do write+unlink+rewrite (setup.ts:981-983, 1067-1089, verified) which would clobber per-file symlinks and silently un-relocate the agent; those two functions are additionally made runtime-root-aware so existing boot-wrapper migrations don't write back into Documents.

**Consistency invariant (resolves NEW-4).** The relocation writes the symlink target and the plist `--runtime-root` from the same value in one step. On every boot, the entrypoint asserts `realpath(<projectDir>/.instar) === <--runtime-root>` **only if it can read the symlink without a Documents traversal** (it generally won't try — it trusts `--runtime-root`); the consented-context assertion (in `instar doctor`) checks both and **fails loud** on disagreement. A Tier-1 test covers the disagreement case.

**The funnel layering (resolves NEW-3, lessons H4).** Two layers, not one conflated `resolveRuntimeRoot()`:
- *loadConfig layer:* `<projectDir>/.instar` symlink-follow is transparent — **no resolver needed** for the 890 read callsites (the symlink target is in Library, readable from consented contexts).
- *boot-argv layer:* only the server/lifeline entrypoint parses `--runtime-root` / `INSTAR_RUNTIME_ROOT` and sets `config.stateDir` to it before reading config — because the boot context must not touch the Documents symlink.
- *structural enforcement:* a CI gate `tests/unit/no-raw-instar-path-joins.test.ts` fails on **new** `join(…, '.instar', …)` outside an **explicit allowlist** (resolves NEW-5). Allowlist = the config-bootstrap in `Config.ts`, the boot-wrapper string emitter in `setup.ts`, agent-dir resolution (`resolveAgentDir`/`standaloneAgentsDir`), and `InstarRuntimeRoot.ts` itself — the verified-legitimate `.instar`-join sites. The gate snapshots the current legitimate set and only flags additions.

### `migrateRuntimeRoot()` — a `migrate()`-body method (resolves NEW-1/NEW-2)

Implemented as a method invoked from `migrate()` (like `migrateParityRenderings`), NOT via the dormant `registerStep` engine (which `migrateAsync` never calls — verified). It reads `this.config.projectDir`/`projectName` directly. The whole migration block is already gated **once per version change** by `installedVersion !== lastMigrated` (`server.ts:2258`, verified) — so this runs on a version bump, NOT every tick; do NOT wire it into a per-tick/hot loop. The relocate.json short-circuit below is belt-and-suspenders on top of that gate:

1. **Idempotency short-circuit (MUST be first — resolves integration NEW-R1):** if `relocate.json` exists in the stored runtime root with `completed === true && schemaVersion === current`, return immediately — **before** the execution-context probe in step 3. This guarantees an already-relocated agent re-running `migrate()` from a launchd/TCC-blind auto-update context never attempts a move (it reads `relocate.json` from the Library root, which is readable). A Tier-1 test asserts this exact path: already-relocated agent + launchd/EPERM-on-Documents context → short-circuits, no move attempted.
2. **Detection gate:** macOS 26+ AND the launchd spawn path resolves under ANY TCC-protected location (`~/Documents`, `~/Desktop`, `~/Downloads`, `~/Library/Mobile Documents/…iCloud`, external/network volumes — derived from the plist `ProgramArguments[0]`, not a 3-folder allowlist). Linux and already-safe agents (Echo) never relocate.
3. **Execution-context guard (resolves the central flaw):** probe `fs.access(<projectDir>/.instar/config.json, R_OK)` + a real read. **If EPERM** (launchd-spawned, TCC-blind) → write `~/.instar/relocate-blocked/<bundleId>.json`, append a `relocate-needed` escalation to the spool (§3), return. No partial move. Explicit, tested branch. **If readable** (consented) → proceed.
4. **Disk + transactional move (same-volume fast path):**
   - Build the new root in `…/<root>.partial-<pid>/`.
   - **Move `shadow-install/` via atomic `rename()`** (same APFS volume — verified). Cross-volume fallback only: copy + verify + (if the copy is incomplete) re-run `npm install --prefer-offline` **pinned to the existing lockfile** (resolves NEW-H2; offline-tolerant; never a fresh unpinned resolve). `statfs` precheck sizes the **actual** bytes to be moved/copied (not a fixed 1.5× of the wrong artifact).
   - Move/copy the small artifacts (boot wrapper, node symlink target string, state, config, logs).
   - **Stale-`.partial` sweep:** on entry, delete any orphaned `…<root>.partial-*` from a crashed prior attempt (resolves NEW-H2 retryability).
5. **Verify** the new root: `bin/node --version` runs, `config.json` parses, `shadow-install/node_modules/instar/package.json` resolves **and its entrypoint loads** (not just exists — adversarial M3).
6. **Atomic `rename()`** `.partial` → final root.
7. Replace `<projectDir>/.instar` with a whole-dir symlink → root; the original `.instar` contents were *moved* (not copied) in step 4, so **exactly one live copy** of state/config exists (no dual-writer split-brain). A lightweight `<projectDir>/.instar.pre-relocate.manifest.json` (list of moved paths, not the data) is left for audit.
8. **Activation — stage-only is the PRIMARY path (resolves integration NEW-R3).** Relocation most commonly runs from the launchd-spawned auto-updater (`UpdateChecker.migrateAsync` / `server.ts` boot), so the launchd case is the common case, not the exception. **When running launchd-spawned: stage only** — write the new plist; do NOT `bootstrap`/`bootout` the running label from within the very process launchd spawned from the old definition (that risks a double-load / port-race that `registerAgent` resolves by `process.exit(1)`). The new root is adopted on the **next natural launchd respawn**. The consistency window (old plist still points at the old path, new symlink+root in place) is covered by the boot assertion (§"Consistency invariant"): the next spawn either uses the new plist's `--runtime-root` (good) or, if it's still the old plist, the old absolute paths still resolve (the move left a symlink, and the boot asserts `--runtime-root` matches). The live zero-window `bootstrap`-new-then-`bootout`-old swap is performed **only** from the consented `instar relocate`/`setup` CLI, where the process doing the swap is NOT the one launchd manages. In practice the launchd-spawned relocation rides along with the auto-updater's own server restart (which provides the respawn that adopts the new plist), so the staged window is normally seconds; but to keep it observable rather than silent (integration NEW-R4), `diagnose-down`/`instar doctor` surfaces a `staged-not-yet-adopted` state when the staged plist's `--runtime-root` differs from the running process's, so a never-restarting healthy server that staged but hasn't adopted is visible.
9. Write `relocate.json` (`schemaVersion`, `completed: true`, `runtimeRoot`, `projectDirHash`, timestamp) **last**, in the **runtime root** (Library — resolves NEW-M2; the launchd boot process can write/delete there).
10. **Cleanup:** there are no large originals to clean (they were moved, not copied). The audit manifest is removed by the next `instar relocate`/`doctor`/SessionStart consented run (NOT by the launchd boot process, which is TCC-blind to the Documents-resident manifest — resolves NEW-M2).

**Failure containment (resolves NEW-H2).** Any verify failure → delete `.partial`, leave `.instar` untouched (the move steps are not yet committed — they happen into `.partial`), restore the original plist, write `relocate-blocked`, escalate. **A failed relocate on macOS 26 leaves the agent in its prior (dead-or-alive) state and is itself an escalation-worthy terminal state**; `instar relocate` is idempotent and safely retryable. The spec does NOT claim "never worse" beyond "never left in a half-moved state" — an already-dead agent that fails to relocate stays dead-but-loudly-paged, not silently.

---

## 2. Scope B — Fleet watchdog: exit-78 + runtime-root resolution

**Files:** `src/templates/scripts/instar-watchdog.sh`.

**Runtime-root resolution (resolves HIGH-5 + adversarial NEW-H1).** `get_project_dir`/`try_self_heal`/`probe_server_identity`/`check_stale_lifeline_signal` derive the runtime root **only from the plist `--runtime-root` arg / `StandardErrorPath`** — never by `readlink`-ing `<projectDir>/.instar` (that EPERMs on 26 for both the locked dir and the relocated symlink). The "fall back to `$project_dir/.instar`" clause is **removed**. For agents with no `--runtime-root` (pre-relocation), the watchdog reads only what it can (plist + `launchctl`) and routes to the spool (§3) rather than attempting a Documents read.

**Exit-78 classifier (resolves adversarial H2, lessons H3, state-detection L5).**
- **PRIMARY (deterministic):** `LastExitStatus == 78` (from `launchctl list`) AND `ProgramArguments[0]` path under a TCC location (from the plist). Classifies `tcc-spawn-blocked` with no `log show` needed.
- **CORROBORATING (soft, never required):** `timeout 8 log show … --last 5m` substring match; classification holds when it's empty or the wording changed.
- **L5 hardening:** canary synthesizing a known launchd-EPERM signature + classifier assertion; `state-detector-registry` entry; documented deterministic-vs-soft rationale.
- **Cost control:** classification cached on `(label, LastExitStatus, plist-mtime)`; `log show` bounded + gated behind the cheap `launchctl list` check.

---

## 3. Scope C — Autonomous, peer-independent escalation

**Files:** `src/templates/scripts/instar-watchdog.sh`; new escalation-credential write in `src/commands/setup.ts` + `src/commands/server.ts` (every healthy boot); `src/templates/hooks/instar/session-start.sh` (spool drain); `src/core/Config.ts` (credential read helper).

Round-2 proved that "drain via the next consented context" leaves a **silent-forever hole** for the headline case (dead, headless, single-agent machine — no consented context ever runs autonomously; adversarial NEW-C1). To deliver the "never silent" guarantee the watchdog needs an autonomous Telegram path that does **not** read the locked Documents config.

### Escalation credential (minimal, per-agent, outside Documents)

The rejected design was an **aggregate** file holding every agent's token. This design stores a **minimal per-agent** credential — `{ ownerTopicId, botToken }` only:
- **Robust default:** a per-agent file `~/.instar/registry/<bundleId>.json` — **0600 in a 0700 dir**, created mode-at-open (umask-safe) + atomic temp+rename, containing only `{ ownerTopicId, botToken }`. `~/.instar/` is outside any TCC folder, so the launchd-spawned watchdog can **always read it** (the read side has no TCC or lock uncertainty — this is why it's the default, not the fallback). Its protection against the Luna leak class is **structural, not guidance** (resolves lessons advisory): `~/.instar/registry/` is a machine-level path **outside any project git tree**, so the Luna vector (a token file swept into a *project* repo) cannot apply; on top of that, a coded default excludes it from instar's own backup system (the mechanism that actually created Luna's `.bak`), and 0700/0600 perms gate at-rest access. (A project `.gitignore` is irrelevant here — the path was never in a project tree; the real protections are out-of-tree placement + backup-exclusion + perms.) This is the per-agent scoping the security review accepted ("a single leak is one token"), NOT the rejected aggregate.
- **Optional hardening (OQ):** the login Keychain as a per-agent generic-password item. More secure at rest, but a launchd-spawned non-Aqua watchdog reading it after a headless reboot may hit a **locked keychain** — exactly the post-reboot window the b2lead incident occupies. Whether the watchdog can read it without an interactive unlock is an **explicit Open Question** (OQ3), verified on a real machine before Keychain becomes the default; until then the 0600 file is authoritative.

**Who can arm it (resolves adversarial NEW-C1'/NEW-H3 — the credential write needs the token, which lives in the config).** The credential is written by **any context that can read the config**: `setup`/`relocate`/`doctor`/the consented SessionStart hook (all have a TCC key), OR a **healthy server boot** — but note a healthy boot only happens for an agent that is *already* relocated or non-TCC (an unrelocated Documents agent on macOS 26 cannot heal-boot at all), so a healthy boot reads config from Library/safe location and arms the credential fine. The credential is **never** required to be written from a TCC-blind launchd boot of an *unrelocated* agent — that context can't read the token and (correctly) doesn't try. Consequence, stated honestly in the outcome matrix: an agent that has never run with this fix has **no armed credential**, so its first death cannot be autonomously paged; the first consented run both recovers it and arms it for the future. Token rotation: the healthy-boot rewrite re-syncs from config, so a rotated token propagates within one healthy boot — **except on a crash-looping (never-healthy-boot) agent, where the credential stays stale until a consented `instar doctor` re-sync** (acknowledged limit, adversarial M3).

### Delivery

The watchdog, on a classified outage, reads the per-agent credential (Keychain/file — readable on 26) and `curl`s Telegram directly. **Token via `curl -K -` on stdin, never argv** (security C1). It checks `ok:true`; on failure it leaves the spool entry and honors `retry_after`. This works for **relocated AND not-yet-relocated** agents alike — the credential is independent of the Documents config. The healthy-peer path and a local `osascript` toast remain as additional best-effort tiers.

### Dedup / cadence (resolves scalability M1, lessons M1/N1)

One-shot **per outage episode**, keyed on a STABLE id (`label + first-detected-down epoch`). The **first-detected-down marker AND the spool live in `~/.instar/`** (machine-level, outside TCC — resolves NEW-M1; the watchdog can always write there even when the agent's own state dir is locked). Escalating cadence: immediate, +15m, +1h, hourly cap. Direct-notify, peer-notify, AND the `osascript` toast are all bound to the **same** episode key (resolves N1) and are mutually exclusive with the peer path (wired as the `else` of `escalate_via_peer`'s no-peer branch). Integration test: N ticks during one outage → exactly one delivered page.

---

## 4. Scope D — Discovery: never an unexplained "NOT RUNNING"

**Files:** `src/templates/hooks/instar/session-start.sh`; new `src/commands/doctor.ts` (`diagnose-down`) + `src/cli.ts` registration; `src/server/routes.ts`.

`diagnose-down` (also `instar doctor`) checks launchd load state + `LastExitStatus`; if exit-78, the bounded/cached `log show` corroboration; whether relocation completed (`relocate.json`); the symlink↔`--runtime-root` consistency assertion (§1); composes `{ cause, remediation }` over `tcc-spawn-blocked | shadow-install-missing | config-unreadable | relocate-blocked | relocate-needs-network (cross-volume copy+install requires connectivity) | symlink-arg-mismatch | staged-not-yet-adopted (relocation staged, awaiting next respawn) | unknown`.

The SessionStart hook (consented) calls this when the server is down, writes `<root>/state/down-diagnosis.json` (0600; `log show` excerpts **redacted to the matched EPERM signature only** — security M1/M2), and injects a **concise, transient** diagnosis into session context (NOT into AGENT.md/CLAUDE.md — L1). It also **drains the §3 spool** (the consented context CAN read a not-yet-relocated agent's config to send any page that the watchdog credential path couldn't). User-facing copy is plain-English (B1): "my startup files are in a folder macOS now locks — run `instar relocate` once, or grant Full Disk Access," never "EX_CONFIG / posix_spawn 0x1." Sidecar cleared on healthy boot.

---

## 5. Scope E — FDA-trigger interactive bootstrap (probe-first)

**Files:** `src/commands/setup.ts`; new `src/commands/fda-bootstrap.ts`.

FDA is per-binary and persists across spawns; once `/opt/homebrew/bin/node` has it, launchd-spawned node inherits it. The prompt fires when an interactive foreground process triggers a protected access. **Probe first, then speak:**
1. **Probe FIRST** from the consented setup process: spawn a child node that reads a real **project-source** path under the TCC folder — `<projectDir>/package.json`, NOT the relocated `config.json` (which is now in Library and would test the wrong boundary → false grant; adversarial H4). Observe: prompt-fired-and-granted / denied-no-prompt / already-granted.
2. **Then select copy by result.** Only print "macOS will now ask you to grant Full Disk Access to node" if the probe confirms a prompt fires; else print System-Settings deep-link steps. Never describe unobserved OS behavior.
3. **Threat model (security H4):** FDA grants that node binary read access to ALL protected data (Documents, Mail, Messages, Safari, other containers, Time Machine) for **every** script run with it, and follows the auto-updating Homebrew node. E is **opt-in with an explicit broad-scope warning**; "move the project out of a protected folder" is presented as the cleaner alternative. E is never the smooth default.
4. **Empirical gate (OQ1):** whether macOS 26.5 fires the prompt from a CLI is verified on a real 26.5 box before E's prompt-firing copy ships. Until then E ships in guided-System-Settings mode only; the probe makes it fail-safe regardless.

---

## Testing (all three tiers)

**Tier 1 unit:**
- `InstarRuntimeRoot.test.ts` — per-OS path; hash computed-once-then-read-from-`relocate.json`; unwritable-Library fallback.
- `Config.runtimeRoot.test.ts` — symlink-follow (consented) vs `--runtime-root` arg (boot) layering; **symlink-target ≠ --runtime-root disagreement fails loud** (NEW-4).
- `no-raw-instar-path-joins.test.ts` — CI gate with the explicit allowlist; asserts a NEW raw join fails and an allowlisted one passes.
- `AutoUpdater.test.ts` — pendingCoalesce persistence; boot reconciliation advances only when shadow install is **loadable**; CAS latch prevents re-apply in a crash-loop.
- `instar-watchdog.test.sh` (bats) — exit-78 classified from `LastExitStatus`+path **with `log show` empty**; root derived from plist only (no `$project_dir/.instar` readlink); credential read (Keychain mock + file fallback); token never in argv; dedup one-shot per episode (N ticks → 1 page); osascript bound to same episode key.
- `PostUpdateMigrator.runtimeRoot.test.ts` — EPERM-source branch (no partial move, writes blocked-marker + spool); same-volume `rename` fast path; cross-volume copy+verify; stale-`.partial` sweep; verify-then-activate ordering; sentinel-written-last-in-Library; idempotency.
- `escalation-credential.test.ts` — written at setup + healthy boot; minimal fields only; 0600/0700; rotation re-sync.

**Tier 2 integration:**
- setup → install → simulated reboot → boot: plist points at Library, agent boots, logs land in Library.
- **Armed-agent future-death case** (an agent relocated + credential-armed by a prior healthy/consented run, that later dies): watchdog single-agent + pre-written escalation credential → autonomous direct Telegram (mock HTTPS) with `ok:true` check. Assert the page IS delivered autonomously. (This is the steady-state win — NOT the b2lead-before-fix case.)
- **Genuine b2lead-before-fix case** (unrelocated, dead, NO armed credential): assert NO autonomous Telegram page is attempted (none possible — matrix row 3); assert the watchdog fires the `osascript` toast + writes the spool entry, and that the first consented SessionStart-hook drain (consented mock, can read the Documents config) delivers the page. The test must NOT assert silent auto-recovery, and must NOT assert an autonomous page for this never-armed case ("tests can encode the bug as correct" lesson).
- AutoUpdater coalesce → mid-window reboot → apply on boot.

**Tier 3 e2e (b2lead reproduction):**
- Fixture agent in a Documents-style path behind a synthetic TCC-blocking shim, with NO armed credential (the true b2lead-before-fix state). PRE: launchd spawn fails; in-process migrator hits EPERM and does NOT partial-move; **NO autonomous Telegram page is attempted** (none is possible — matrix row 3); the watchdog fires the `osascript` toast + writes a spool entry. Then a simulated consented SessionStart drain delivers the page (this is the honest outcome — delivery via a consented context, NOT silent auto-recovery and NOT an autonomous page; adversarial C3/C1). THEN consented `instar relocate` → agent boots from Library AND arms the credential, after which a *subsequent* simulated death pages autonomously (the armed path).
- A consumer reading **through** the Documents-resident `.instar` symlink from a **consented** context succeeds under the TCC shim (lessons N3); the same read from a **launchd** context is never attempted (boot uses `--runtime-root`).
- SessionStart hook with synthetic down state → concise diagnosis in context + sidecar + spool drained.

## Migration parity

- `PostUpdateMigrator.migrateRuntimeRoot()` — `migrate()`-body method (actually runs), EPERM-guarded, idempotent, transactional.
- `migrateEscalationCredential()` — writes the per-agent credential for existing agents on update + every healthy boot.
- `migrateFleetWatchdog()` — re-writes `instar-watchdog.sh` (exit-78 + plist-only root resolution + credential read + spool + dedup).
- `migrateSessionStartHook()` — spool drain + down-diagnosis injection.
- `installBootWrapper`/`ensureStableNodeSymlink` made runtime-root-aware (so existing boot-wrapper-coherence migrations don't un-relocate).
- CLAUDE.md template (`generateClaudeMd()`): a SHORT "Boot Resilience" pointer (L1) — detail in `/capabilities` + `instar doctor`.

## Security summary

- No aggregate token file. Per-agent credential = minimal `{ownerTopicId, botToken}`; authoritative store is a 0600 file in a 0700 dir (umask-safe create, atomic rename) under `~/.instar/registry/`, outside any TCC folder and outside any project git tree, with a **structural** own-backup exclusion + 0700/0600 perms (not guidance); Keychain is optional hardening (OQ3). Token never in argv (`curl -K -` stdin); token shape validated before use; rotation re-synced on healthy boot (stale on a never-healthy-boot agent until consented re-sync).
- Boot path never traverses a Documents-resident symlink (absolute `--runtime-root`). Move/relocate steps are realpath-containment-checked and `lstat`-guarded (no symlink escape / TOCTOU).
- `log show` predicate label validated `^ai\.instar\.[A-Za-z0-9._-]+$`; captured output allowlisted to the EPERM signature before landing in a sidecar/context.
- `launchctl`/plist interpolations quoted + label/path allowlist-validated before bootstrap/bootout.
- FDA grant opt-in with explicit broad-scope warning; "move project out of protected folder" offered as cleaner path.

## Recovery-of-last-resort note (lessons N2)

After relocation, exactly one live copy of state/config exists (the runtime root) — the deliberate anti-split-brain choice. If the Library runtime root later becomes corrupt/unreadable (e.g. volume issue), the only recovery is re-`instar setup` (which re-scaffolds config/state). This tradeoff is on the record; the audit manifest (§1.7) records what was moved for forensic reconstruction.

## Open questions (for the user, at re-approval)

1. **FDA-prompt-from-CLI on macOS 26.5** — needs an empirical check on a real 26.5 box (b2lead's). Until verified, E ships guided-System-Settings-only behind the runtime probe. **Ask:** OK to ship E in guided mode first and enable the auto-prompt copy only after the probe is confirmed on a 26.5 machine?
2. **Escalation credential at rest** — a minimal per-agent `{ownerTopicId, botToken}` stored outside Documents (0600 file default, outside any project git tree, structural backup-exclusion + perms). **Ask:** confirm you're OK with this. It's what makes the autonomous page possible; without it a single-agent headless machine has no autonomous page at all. This walks back the round-1 "no new secret file" — convergence proved that design couldn't page the b2lead case. (Per-agent, not the rejected aggregate; reviewers confirmed it doesn't reopen the Luna leak class because it lives outside the project's git tree.)
3. **Keychain as optional hardening** — whether a launchd-spawned non-Aqua watchdog can read a login-Keychain item after a headless reboot (locked-keychain window) is unverified. The 0600 file is the authoritative default; Keychain is offered as later hardening gated on this check. **Ask:** fine to defer Keychain to a verification-gated follow-up, or do you want it resolved in this PR?
4. **Cross-volume relocation** — when `~/Documents` and `~/Library` are on different volumes (FileVault external/network homes, some MDM fleets), relocation can't atomic-`rename()` and falls back to copy + offline-`npm install`, which needs connectivity and is surfaced as the `relocate-needs-network` cause. **Ask:** do any of your real target machines have a split Documents/Library volume layout? (If none do, this path is defensive-only.)

## No-deferrals attestation

A–E ship in one PR. Two narrowly-scoped items are verification/hardening gates, NOT recurrence-risking deferrals (the silent-death recurrence is prevented by A–D, which ship unconditionally): **OQ1** — E's auto-prompt copy variant is probe-gated (E still ships, in guided mode); **OQ3** — Keychain is optional hardening on top of the authoritative 0600-file credential (the credential ships, as a file). Both are fail-safe: the feature works without the gated variant. OQ2 (credential at rest) and OQ4 (cross-volume) are resolved in-spec. The deferral scanner traces any "later/follow-up" wording to OQ1/OQ3 only; neither re-creates the incident class.
