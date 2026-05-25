# Arm the Full Response-Review Stack End-to-End

- **Status:** DRAFT — `approved: false` (awaiting Justin's ratification per the instar-dev gate)
- **Authors:** Echo (pen-holder), with converged design input from instar-codey (thread `33fbbe35-065b-4024-88bf-acb4779480e6`)
- **Date:** 2026-05-25
- **Related:** `docs/specs/context-death-pitfall-prevention.md` (approved parent — UnjustifiedStopGate), `docs/specs/built-but-dark-liveness-reconciler.md`, `docs/specs/codex-full-parity-fixes.md`, MEMORY `project_fresh_session_gate_unwired`, `project_codex_full_parity`, `feedback_codex_hooks_need_managed_install`
- **ELI16 companion:** `docs/specs/arm-the-full-response-review-stack.eli16.md`

---

## 1. Problem

The response-review safety gate — the Stop-hook path that is supposed to catch
unjustified self-termination ("let's continue in a fresh session"), unsupported
claims, and tone violations before a reply ships — **can be silently dark even
when every individual layer reports healthy in isolation.** This is the same
class of failure as the unwired UnjustifiedStopGate and the Codex hook-trust
gap: a guard that looks installed but never actually fires.

The root insight, agreed across the thread, is that **a guard can be dark via
multiple independent entry paths**, and a per-layer "looks fine" is not
liveness. The stack has four layers, each independently darkenable:

| Layer | What makes it dark | Where (verified on `JKHeadley/main` @ v1.2.80) |
|-------|--------------------|------------------------------------------------|
| **L1 — Host hook (Claude)** | `response-review.js` is written to disk and listed as a managed hook, but **never registered in `settings.json` `Stop[]`**, so the host never invokes it. | `PostUpdateMigrator.ts:1766` writes the file; `:1885` lists it as managed; the only `Stop[].unshift` is the autonomous hook at `:2258`. No migration adds response-review to Claude's `Stop[]`. |
| **L1 — Host hook (Codex)** | The Stop slot carries `enabled = false` in `~/.codex/config.toml [hooks.state]` on a **matching** `trusted_hash`. The arm driver's rule F3 deliberately never re-enables a user-disabled hook, so it stays dark across every update with no self-heal. | `codexHookArm.ts:16` (F3: "never silently re-enable a user-disabled hook"); readback returns `status: 'partial'` forever (`:130`). |
| **L2 — Config** | `responseReview.enabled` is falsy → the hook `process.exit(0)`s before it ever calls the server. Default-off. | `response-review.js:33-38` |
| **L3 — Runtime gate** | The `CoherenceGate` is only constructed when `config.responseReview?.enabled && sharedIntelligence` are both present; otherwise `/review/evaluate` returns `501`. | `server.ts:7311` (construction condition); `routes.ts:13131-13134` (501 when `!ctx.responseReviewGate`). Truth source: `CapabilityIndex.ts:553` reports `enabled: !!ctx.responseReviewGate`. |

Because each layer is checked independently today, an operator (or a CI lint, or
the agent itself) can confirm "the hook file is on disk" / "the config flag is
true" / "the gate route exists" and conclude the guard is healthy — while the
chain is actually broken at a different link. **No single existing check asserts
the chain is live end-to-end.**

**The server floor (L2 + L3) is dark fleet-wide, not Codex-specific.** Confirmed
on two independent installs as of 2026-05-25: `echo` (Claude engine —
`responseReview` absent from `.instar/config.json`, `/capabilities` reports
`response-review enabled:false`, authenticated `POST /review/evaluate` → `501`)
and `codey` (Codex engine — identical: no `responseReview` block,
`enabled:false`, `501`). This separation matters for the fix: the **host layer
(L1) carries the two-engine dark-mode split** (Codex present-but-trust-disabled
vs Claude absent-from-Stop), while the **server floor (L2/L3) is one shared fix**
that lights up both engines at once.

### 1.1 The two host-layer dark modes are different and must be named separately

This is a deliberate anti-overfit requirement (codey, msg 2). The fix must not be
shaped around one live repro:

- **Codex: present-but-trust-disabled.** The slot exists and is hashed/trusted,
  but `enabled = false` persists. This is the live `codey` fixture
  (thread 33fbbe35): `trusted_hash = sha256:3e20…` **plus** `enabled = false`.
- **Claude: absent-from-Stop.** The slot is simply not in `settings.json`
  `Stop[]` at all — a migration-parity gap for existing agents.

A fix that only closes one of these leaves the other dark.

### 1.2 Mode A vs Mode B (origin of the Codex disable)

Two candidate origins for the persistent `enabled = false`, to be split by a
clean-room repro rather than dirty-system archaeology (consensus, msg 1 & 3):

- **Mode A — explicit disable.** A human review-disable, or a tmux trust-driver
  mis-keystroke on a changed-hook re-prompt, wrote `enabled = false` once. It is
  honored persistently because the stored `trusted_hash` still matches the
  current hook body.
- **Mode B — drift auto-quarantine.** Codex auto-writes `enabled = false`
  whenever a hook's body changes and its hash no longer matches the stored
  `trusted_hash`. If true, **every instar edit to a managed Stop hook silently
  darks the guard fleet-wide** until re-armed — a severe regression vector,
  because `response-review.js` is the most-edited Stop hook and re-prompts most
  often.

The decisive experiment (owned by codey, who must not race instar against
concurrent `config.toml` writes): with `stop:0:0` trusted+enabled, mutate
`response-review.js` content to change its hash, relaunch Codex interactively,
and capture `config.toml stop:0:0` **before any keystroke**.

- If Codex auto-writes `enabled = false` on the drifted hook → **Mode B
  confirmed** → re-stamping `trusted_hash` atomically with every body rewrite is
  not migration hygiene, it is **required to preserve safety-guard continuity
  across updates** (codey, msg 1).
- If not → **Mode A** → audit the tmux trust-driver keystroke state machine and
  add an arming canary.

**Provenance is explicitly an open non-claim (codey, msg 3).** We do **not**
assert that the instar installer wrote `enabled = false`. The only direct
evidence is the live `~/.codex/config.toml`, which was surgically remediated at
2026-05-25 15:14:24 PDT — so its mtime now proves only the manual-fix point, not
the original write. Birth time is 2026-05-25 12:55:49 PDT, and no
backup/history file under `~/.codex` preserves the pre-fix transition; Codex does
not log `[hooks.state]` writes to session JSONL (the hash hits found there are
transcript echoes, not authoritative state transitions). The spec therefore
phrases cause as: *"observed state is consistent with a Codex-native
trust/disable decision or hook toggle; direct provenance is unavailable."* The
fix does not depend on resolving this — R4's pinned-slot reassertion makes an
explicit disable non-persistent **regardless of who wrote it**.

**The fix below is mandatory regardless of which mode is proven.** The repro
only sharpens the *re-stamping* requirement (§3, R2).

### 1.3 The four states and the dependency order

codey's canonical taxonomy (msg 2) names four *states* the stack can be in, which
the §1 table's dark modes roll up into:

1. **Host-hook-dark** — `Stop[]` lacks the managed response-review hook (Claude
   absent-from-Stop), or the hook is present but disabled in host trust state
   (Codex present-but-`enabled=false`).
2. **Server-config-dark** — `.instar/config.json` has no `responseReview` block
   *or* `responseReview.enabled` is false. **Absence and explicit-false collapse
   into one bucket.**
3. **Server-intelligence-dark** — config enables review, but no
   `IntelligenceProvider` is available, so `responseReviewGate` is never
   constructed and `/review/evaluate` returns `501`.
4. **Live** — host hook armed + config enabled + `!!ctx.responseReviewGate` true
   / `/review/evaluate` returns a real verdict.

**Dependency order is server floor first, harness second** (msg 2). Arming the
host hook into a `501` floor (states 2/3 still dark) forces a bad fail-open /
fail-closed choice with nothing real underneath. The fix therefore lights L2/L3
*before* (or atomically with) arming L1 — never L1 alone. This is why P6a
host-arming is necessary but insufficient (§R3): a green host hook on a dark
floor is a no-op gate.

---

## 2. Goals & non-goals

**Goals**

1. Make the response-review stack live end-to-end on both engines, for new *and*
   existing agents (migration parity).
2. Replace per-layer "looks installed" checks with a **layered liveness model**
   that fails closed if any layer is dark.
3. Treat `response-review` / UnjustifiedStopGate as an **org-policy-pinned safety
   slot**: not individually revocable by an interactive hook prompt, and
   self-reasserting if found disabled at boot — with an audit trail.
4. Ship a test matrix that asserts each layer *and* the chain, and that cannot be
   satisfied by a single green layer.

**Non-goals**

- Re-designing the review *logic* (CoherenceGate / MessagingToneGate semantics).
  This spec arms and verifies the existing pipeline; the separate
  `feature-activation-coherence` work owns whether CoherenceGate should merge
  into MessagingToneGate.
- Touching the live `codey` fixture. It is preserved as evidence until Justin
  explicitly asks for remediation (consensus, msg 3).
- Cracking the `trusted_hash` algorithm or doing further rollout-log archaeology
  (established unfindable by design — rollout JSONL does not log `[hooks.state]`
  writes).

---

## 3. Requirements

### R1 — Install/render must populate hook trust for managed safety hooks

On `init` and on every render/migration, managed Instar Stop hooks (at minimum
the org-pinned safety slots in §R4) must be installed **and armed**:

- **Claude:** registered in `settings.json` `Stop[]` (not merely written to
  `.instar/hooks/instar/`). This closes the L1 "absent-from-Stop" mode.
- **Codex:** populated in `config.toml [hooks.state]` with a `trusted_hash` that
  matches the rendered body, so the hook is trusted+enabled without an
  interactive prompt the autonomous agent can't click.

### R2 — Body rewrites must re-stamp `trusted_hash` atomically

Any migration/render that rewrites a managed hook body must re-stamp the Codex
`trusted_hash` **atomically with the new body write** (same operation, no window
where the body is new but the hash is stale).

- **The hash is computed over the final render bytes, never a template
  intermediate (codey, msg 2).** If the renderer normalizes shebangs, applies
  `chmod`, substitutes paths, rewrites line endings, or injects wrapper content,
  `trusted_hash` must be stamped *after* all of those transforms — over the exact
  bytes Codex will execute. Stamping from the pre-render template produces a hash
  that never matches the on-disk executable, which is itself a dark-guard vector.
- This yields a crisp four-part artifact-identity invariant that the verifier
  (R3) and tests (§4.3) assert as a single chain: **managed hook body ≡
  executable file on disk ≡ config `trusted_hash` ≡ observed execution** — all
  four describe the same artifact, or the slot is dark.
- If the Mode B repro confirms drift auto-quarantine, this requirement is the
  primary defense: it prevents every instar hook edit from silently darking the
  guard.
- This supersedes F3's blanket "never re-enable" *for safety slots only* (see
  R4): a disable that rides an instar-caused hash drift is not a user choice and
  must be re-armed.

### R3 — Verification asserts config state AND observed execution

A "healthy" verdict requires the **layered health model** (codey, msg 2), all
three layers green:

1. **Host hook state.** Codex: slot present, trusted, and `enabled != false`,
   with execution observably *attempted* (not just installed). Claude: present in
   `settings.json` `Stop[]`.
2. **Config state.** `responseReview.enabled === true` so `response-review.js`
   does not `exit(0)` before calling the server (`response-review.js:37`).
3. **Runtime gate state.** `ctx.responseReviewGate` actually constructed —
   probed via the capability-index truth source (`CapabilityIndex.ts:553`) and a
   `/review/evaluate` **non-501** response (`routes.ts:13131`).

**A partial green at any single layer is not enough.** Config-only success can
still miss a dark host hook; a present host hook with the gate unconstructed
still 501s. The verifier must report which layer is dark, by name.

**`armed-but-dark` is a named, first-class health state — not a pass (codey, msg
2 & 3).** When L1 is green (host hook armed) but L2 or L3 is dark, the health
surface MUST report `armed-but-dark` and treat it as a non-pass. P6a host-arming
/ the Codex trust migrator is **necessary but explicitly insufficient**: a green
trust migration that produces a no-op Stop gate (because the floor is `501`) is a
**failure**, never a green. Overall protection may be reported `live` only when
the host hook is armed **and** the server floor is live too. The runtime-gate leg
(R3.3) must also distinguish `server-config-dark` (flag off) from
`server-intelligence-dark` (flag on but no `IntelligenceProvider`, so the gate
was never constructed) — these are different remediation paths and must not
collapse into one "501" verdict.

### R4 — Org-policy-pinned safety slots

`response-review` / UnjustifiedStopGate are **org-policy-pinned**, not
individually revocable by the interactive hook prompt:

- Finding `enabled = false` on a pinned safety slot at boot is a **boot-time
  incident signal**. The system **reasserts `enabled = true`** and writes an
  **audit-trail entry** stating that a locally-disabled state was overridden by
  managed safety policy.
- For **non-pinned** managed hooks, local disablement is allowed but surfaced as
  **drift** (not auto-overridden) — consistent with the built-but-dark
  reconciler's "explained vs unexplained" model.

This is the P6a repro in miniature (codey, msg 3): the exact Stop gate meant to
prevent unjustified termination can be locally self-disabled through Codex UI
state and then silently remain disabled across sessions. Pinning closes that.

### R5 — Migration parity

Per the Migration Parity Standard, existing agents must receive R1–R4 on update,
not just new agents via `init`:

- `migrateSettings()` adds `response-review.js` to Claude `Stop[]` if missing.
- The Codex arm path stamps + verifies on every `PostUpdateMigrator` run.
- Migration must **stamp first-party safety hooks and config together, then
  verify runtime liveness** (codey, msg 2). A migration that flips the config
  flag but leaves the host hook unarmed (or vice-versa) is a partial green and
  must be treated as a failure, with the dark layer named.

### R6 — Interim behavior: fail-open with an explicit dark-state signal

There is a window where the host hook is armed (L1 green) but the server floor is
still dark (`/review/evaluate` → `501`). Arming the hook into a `501` endpoint
forces a fail-open / fail-closed choice, and **both naive options are wrong**:
fail-closed would block every reply the moment the floor is dark (a denial-of-
service on the agent's own voice); silent fail-open would re-create exactly the
dark-guard class this spec exists to kill.

The required interim behavior (codey, msg 2) is **fail-open with an explicit
dark-state signal, never silent success**:

- The hook does **not** block delivery when the floor is `501` (fail-open, so a
  dark floor can never gag the agent).
- It **emits an explicit `armed-but-dark` signal** to the verdict/health surface
  (R3) on every such pass — so the dark floor is loud and attributable, not an
  invisible no-op. A reply that shipped without real review must be observably
  marked as such, not indistinguishable from a reply that passed review.
- This is consistent with `feedback_signal_vs_authority`: the hook (a brittle,
  low-context filter) *signals* the dark state; only the migrator/boot path
  (R4/R5) has the *authority* to re-arm the floor.

---

## 4. Test matrix

Two **independent** assertions per managed Stop slot (codey, msg 3). Neither can
substitute for the other:

### 4.1 Host hook layer (slot-arm validation)

- **Codex:** the slot is trusted and armed, with execution **observably
  attempted**. A disabled slot is a **failure even if the Instar review feature
  would pass in isolation.** Assert `enabled != false` on pinned slots and a
  `trusted_hash` matching the current rendered body.
- **Claude:** the slot is present in `settings.json` `Stop[]`.

### 4.2 Instar review layer (hook behavior)

- When the hook executes and `responseReview.enabled === true`, it routes to
  `/review/evaluate` and honors a `block` verdict (`exit 2`,
  `response-review.js:101`).
- When `responseReview.enabled === false`, the hook exits cleanly (`exit 0`)
  **without** evaluation.
- This distinction lives **inside the hook-behavior tests** and is **not a
  substitute for slot-arm validation** (4.1).

### 4.3 Re-stamp continuity (Mode B guard)

- Rewrite a managed safety-hook body; assert the Codex `trusted_hash` is
  re-stamped atomically and the slot remains armed (`enabled != false`) after the
  rewrite. This is the regression test for the drift-quarantine vector.

### 4.4 Boot-time reassertion (R4)

- Seed `enabled = false` on a pinned safety slot; boot; assert the slot is
  reasserted to `enabled = true` and an audit-trail entry records the override.
- Seed `enabled = false` on a **non-pinned** hook; boot; assert it is **not**
  overridden but is surfaced as drift.

### 4.5 End-to-end chain — the reversible self-test (the one that matters)

Mirroring the Phase-1 "feature is alive" E2E standard, the acceptance gate is a
**reversible self-test that is spec-owned and reproducible, not an ad-hoc local
flip** (codey, msg 2 & 3). It drives a real review through the full chain on each
engine and asserts a `block` verdict actually prevents delivery. A green here with
any single layer dark is impossible by construction — that is the point.

The procedure, in order, with restore as a first-class step:

1. **Baseline.** Capture the starting state on the target install: host `Stop[]` /
   `[hooks.state]`, `responseReview.enabled`, and the `/review/evaluate` status
   code (expected `501` from a dark floor). This is the rollback anchor.
2. **Enable the server floor.** Set `responseReview.enabled = true` and ensure an
   `IntelligenceProvider` is available so `responseReviewGate` constructs; confirm
   `/review/evaluate` now returns a real (non-`501`) verdict.
3. **Arm the harness.** Register/trust the host hook (Claude `Stop[]`; Codex
   `trusted_hash` + `enabled != false`) — server floor first, harness second
   (§1.3).
4. **Trigger a real Stop.** Drive an actual reply that should be caught (e.g. an
   unjustified self-termination or an unsupported claim) through a genuine Stop
   event — not a synthetic hook invocation.
5. **Assert produced AND consumed.** A non-`501` review verdict is produced *and*
   the hook consumes it — a `block` verdict actually prevents delivery
   (`response-review.js` `exit 2`). Assert both legs; produced-but-ignored is a
   failure.
6. **Restore.** Return every mutated surface to the captured baseline. The test
   leaves no residue — this is what makes it safe to own in the suite and to run
   against a live install (including the test-as-self gate,
   `feedback_test_as_self_standard`).

This procedure is the canonical E2E for both engines and is referenced by R3/R5
as the liveness oracle. It must not be replaced by a config-only or
hook-only assertion (§4.1–4.2), which by construction cannot prove the chain.

---

## 5. Open items (gate to ratification)

1. **Mode A vs Mode B** — pending codey's clean-room repro (the config.toml diffs
   before/after a hash-drifting body edit). Determines whether R2's re-stamping
   is "hygiene" or "required safety continuity." The evidence package to capture
   (codey, msg 2), so the diffs prove execution-truth and not merely config-trust:
   - initial `config.toml [hooks.state]` + hook file bytes after first
     install/render;
   - `config.toml` + hook file bytes after the body rewrite/migration path;
   - the verification result showing whether **execution actually happened**, not
     just whether config trust is present (the R3 layer-3 leg);
   - any event/log line that proves a flow *attempted* `enabled = false`, if the
     clean repro catches it. (Absence here is expected and acceptable — rollout
     JSONL does not log `[hooks.state]` writes; see §2 non-goals. If clean-room
     does not reproduce explicit disable, the fix-spec still closes the class: the
     R4 pinned-slot allowlist rejection plus drift self-heal make explicit disable
     non-persistent regardless of provenance.)
2. **Full `[hooks.state]` block** from codey (all of `stop:0:0/0:1/0:2` +
   `pre_tool_use` entries) to confirm whether firing siblings have `enabled`
   absent vs explicit-true — validates the "omitted-when-trusted" model.
3. **Justin's ratification** (`approved: true`) — required before any `src/`
   change per the instar-dev gate.
4. **External cross-model round** (`/ultrareview`) recommended as the final
   convergence pass before ratify, per `feedback_external_crossmodel_catches_what_internal_misses`.
5. **Reconciler coupling** — this spec's R3 layered-liveness check is the natural
   data source for the built-but-dark Liveness Reconciler's "DARK" detection on
   safety slots; confirm whether to expose R3 as a `/liveness`-consumable probe.

---

## 6. Side-effects review (to be completed before ratification)

Per the side-effects review gate, before any code lands this spec must ship with
an artifact covering: over/under-block risk (does reasserting `enabled=true`
ever override a *legitimate* user disable on a pinned slot — and is that
acceptable for a safety slot?), level-of-abstraction fit (arm logic in
PostUpdateMigrator vs a dedicated arming sentinel), signal-vs-authority (the
verifier detects+names dark layers; only the migrator/boot path has authority to
re-arm), interactions (with F3, with the autonomous Stop hook ordering, with the
reconciler, and with R6's fail-open-while-dark window — confirm the
`armed-but-dark` signal cannot itself become a noise source that violates
`feedback_notifications_near_silent`), and rollback cost.
