---
review-convergence: "2026-05-25T09:00:00Z"
review-iterations: 1
review-report: docs/specs/reports/codex-full-parity-fixes-convergence.md
approved: true
approved-by: Justin (Telegram topic 9984, 2026-05-24 23:21 PDT)
eli16-overview: codex-full-parity-fixes.eli16.md
---

<!-- CONVERGENCE: /spec-converge internal 5-reviewer panel run 2026-05-25 (security, adversarial, integration, scalability, lessons-aware). Findings incorporated in §7; report at docs/specs/reports/codex-full-parity-fixes-convergence.md. External GPT/Gemini/Grok need the billed cloud path (not self-runnable) — /ultrareview available to Justin for that layer on the P0 autonomy-safety logic. Justin approved the DIRECTION pre-review (2026-05-24); the convergence HARDENED P0 (hard gates) + corrected two over-claims + fixed asdf C1/C2 in code — within that approval. P0 build + P1/P2 merge are gated on §7 (esp. B1, B2, G1-G5). -->


# Spec: Codex ↔ Claude Full-Parity Fixes (master bundle)

**Status:** DRAFT — internal conformance pass in progress; AWAITING Justin's single approval before any `src/` change.
**Author:** echo · **Date:** 2026-05-25
**Project:** `codex-full-parity` (topic 9984) <!-- tracked: codex-full-parity -->
**Evidence base:** `docs/specs/codex-parity-ledger.md` (durable scoreboard — every claim below is backed by a test-as-self entry there).
**Builds on:** `docs/specs/codex-enforcement-hook-layer.md` (CONVERGED+APPROVED — wired the gates onto Codex at all). This spec fixes the gates that, once wired, **fire but do not do their job** — caught by driving codey (real Codex 0.133) live.

---

## 1. Problem

The enforcement-hook-layer spec wired instar's gates onto Codex. Driving codey live (test-as-self, 2026-05-25) proved that **wiring ≠ working**: several gates are registered but inert, the end-of-turn review trio is structurally wrong, the dashboard mislabels Codex sessions, and — the headline — Codex's hook **trust model** means a freshly-initialized Codex agent has **all gates dead** until a human clicks a trust prompt, which an autonomous agent cannot do. This is the exact "looks installed, does nothing" trap (`Structure > Willpower` failure at the enforcement layer).

This spec bundles every code fix needed to reach genuine parity, prioritized. Each is backed by a reproduced failure (the bug-fix evidence bar), not a hypothesis.

## 2. Fixes (prioritized)

### P0 — Codex hook TRUST/ENABLEMENT (the spine)

**Finding (ledger §1 "trust mechanism"):** Codex 0.133 runs ONLY hooks whose hash matches a `trusted_hash` entry in `~/.codex/config.toml [hooks.state]`. instar writes **no** such entries (grep: none). Proven: a project-trusted probe dir with untrusted hooks did NOT fire even with `--dangerously-bypass-hook-trust`; modifying codey's trusted hooks.json invalidated the hashes → all hooks skipped despite the flag. So the bypass flag does **not** auto-run untrusted hooks in headless `codex exec`. The guards that DO fire on codey fire only because their hashes were trusted earlier by a manual interactive action.

**Implication:** every new Codex agent ships with dark guards. Fleet-wide autonomy + safety gap.

**Independently corroborated by Codex's own UI (2026-05-25, live via codey's dashboard):** Codex's hooks-status table reads `Stop: Installed 3, Active 1, Review 1` (only 1 of the 3 Stop hooks active) with a standing `⚠ 1 hook needs review before it can run · Press t to trust all` banner — Codex itself confirms both the dead Stop trio and the manual-trust requirement.

**G2 GO/NO-GO RESOLVED 2026-05-25 (decisive — supersedes the managed-config recommendation below):**
Investigated Codex 0.133's config-layer schema in the binary. **Managed-config is REJECTED:**
`legacyManagedConfigTomlFromFile` reads `/etc/codex/managed_config.toml` (SYSTEM, machine-wide)
and the binary comment says it "did not quite work out as intended" and is being **phased out in
favor of requirements.toml**; the MDM variant (`MdmManagedPreferences`) is macOS system policy.
All machine-wide → fail gate G1 (no MDM/system tier) and can't be per-agent (G2). **But per-agent
scoping comes free without it:** trust entries in `$CODEX_HOME/config.toml [hooks.state]` are KEYED
BY THE HOOKS.JSON PATH (`<path>:<event>:<group>:<idx>` + trusted_hash). `installCodexHooks` writes
the agent's hooks to its **project** `.codex/hooks.json`, so trusting those entries only affects
that agent's project — the operator's personal Codex (run from a different cwd) never discovers or
runs them. (instar must keep its hooks PROJECT-scoped, never in global `$CODEX_HOME/hooks.json`,
which it does.) **VERDICT: arm the agent's own project hooks via the config.toml trust state
(the proven keystroke path + F1-F3 gates). This is inherently per-agent; no managed-config, no
system/MDM path, operator's personal Codex untouched.** Open micro-question for the build: can the
`trusted_hash` be computed (the binary notes "normalized hook identity should serialize to TOML" —
the hash may be over a TOML normalization, worth one more crack attempt) so instar writes trust
directly without a TUI spawn; else the keystroke path stands.

**Fix direction (the managed-config option below is SUPERSEDED by the G2 verdict above; retained for the record):**

- **(RECOMMENDED) Managed-config hooks.** The codex 0.133 binary has a **managed-config
  layer** distinct from per-project `.codex/hooks.json`: strings `LegacyManagedConfigTomlFromFile`,
  `LegacyManagedConfigTomlFromMdm`, `ManagedHooksRequirementsToml`, `MdmManagedPreferences`,
  `SystemRequirementsToml`, the `--include-managed-config` flag, and the config-layer note
  *"Overridden by legacy managed_config.toml"*. Hook **sources** include `mdm` /
  `legacy_managed_config_file` (vs `project`). Managed/MDM hooks are policy-installed →
  **auto-trusted and not agent-disableable** — exactly the "managed hooks" ideal for safety
  guards (the agent literally can't switch off its own safety, and there's no trust prompt to
  hang an autonomous run). If instar installs its gates as a managed-config requirement, the
  trust + `enabled=false` problems both vanish structurally. OPEN: the exact managed_config.toml
  path Codex reads + the `ManagedHooksRequirementsToml` format need confirming; and crucially
  whether it can be **scoped per-agent** vs forced machine-wide (the enforcement-hook-layer spec
  chose per-agent; MDM/managed config is classically machine/system-level — this is the central
  design decision for the cross-review, and ties to Justin's earlier "per-agent, don't touch the
  operator's personal Codex" call).
- **(b, guaranteed fallback) Automate the interactive trust.** instar already drives tmux +
  send-keys; at install/migrate it spawns a one-time interactive `codex`, waits for the
  "Hooks need review" prompt, sends the "Trust all and continue" keystrokes (PROVEN to work
  2026-05-25 — I drove exactly this on codey), then exits. Guaranteed (it's what a human does).
  Downsides: a real session spawn at install; TUI-automation fragility in production code; and
  trust-all does NOT override an explicit `enabled=false` (response-review on codey is disabled
  by a separate sticky flag — that needs a direct config.toml `enabled=true` write).
- **(c, ruled out for now) Programmatic trusted_hash write.** The `trusted_hash` is NOT a plain
  sha256 of command/script/handler-json (6 serializations tried against 2 known codey pairs,
  none matched) — would require reversing the Rust hashing. Not pursued; (a) is cleaner.
- **(open) Interactive-mode bypass flag.** `--dangerously-bypass-hook-trust` does NOT auto-run
  untrusted hooks in headless `codex exec` (proven). Whether it does in INTERACTIVE mode is
  untested; if it does, the gap narrows to headless workers. Worth a quick live check during
  the build.

**Acceptance:** a freshly-`init`'d Codex agent, with no human interaction, has its
dangerous-command-guard block `rm -rf /` AND its response-review hold an incoherent reply on
the first session. Proven test-as-self on a clean agent.

**Status:** design substantially advanced (manual-arming proven; managed-config path identified
as the clean answer; hash-crack ruled out). The managed-config implementation touches
system/managed config and is the autonomy-SAFETY logic explicitly flagged for `/crossreview`
before build/merge — RECOMMEND Justin triggers it on this P0 now.

### P1 — Fix the Codex Stop-review trio (`installCodexHooks.ts:96`)

**Finding (ledger §1, §2):** Canonical Claude Stop = `response-review, claim-intercept-response, scope-coherence`. Codex installer wires Stop = `response-review, deferral-detector, scope-coherence` — it **dropped claim-intercept-response and inserted deferral-detector** (a PreToolUse hook). The canary (`codexHookContractCanary.ts:140`) asserts the WRONG trio, locking the bug in (test-encodes-the-bug).

**Fix:**
1. `installCodexHooks.ts`: Codex Stop → `response-review, claim-intercept-response, scope-coherence`. Move `deferral-detector` to Codex PreToolUse (where it is on Claude).
2. `codexHookContractCanary.ts`: assert the corrected trio.
3. Migration: PostUpdateMigrator re-runs `installCodexHooks` (always-overwrite for instar-owned groups) so existing Codex agents get the corrected wiring. Tie trust re-registration to P0.

**Evidence the current trio is dead:** ledger §1 — response-review `enabled=false` in trust state; deferral-detector no-ops on Stop (proven payload replay); scope-coherence unregistered (no trust entry).

### P1 — Make deferral-detector Codex-aware (after the move to PreToolUse)

**Finding:** `deferral-detector.js` requires `tool_name === 'Bash'` + `tool_input.command`. PROVEN dead on Codex payloads (Stop payload → no output; `exec_command`/`cmd` payload → no output; Claude `Bash`/`command` payload → full checklist).

**Fix:** accept `tool_name` ∈ {`Bash`, `exec_command`} and read `tool_input.cmd || tool_input.command` — the same pattern already applied to dangerous-command-guard and grounding-before-messaging. Migration via PostUpdateMigrator (always-overwrite instar hook).

### P1 — response-review Codex Stop-payload correctness — ✅ RUNTIME-VERIFIED (B1, no code change)

**Finding:** `response-review.js:45` (and `claim-intercept-response.js:120`) read
`input.last_assistant_message`. The codex 0.133 Rust binary's embedded Stop-hook input
schema *declares* `last_assistant_message`, `hook_event_name`, `stop_hook_active`. **CORRECTED
after convergence review (was over-claimed "RESOLVED"):** schema-declares-the-field ≠
field-is-populated-at-runtime. This is the schema≠runtime trap (`feedback_bug_fix_evidence_bar`,
`feedback_state_detection_robustness`). response-review skips when `message.length < 20`
(response-review.js:48) — so if Codex sends the field empty/truncated on a `codex exec` Stop,
BOTH gates silently no-op and tests stay green over dead enforcement. **Status: code appears
Codex-correct by schema inspection; UNVERIFIED at runtime.** Resolution gate (NOT a footnote):
the P0 live-proof must CAPTURE the actual Codex Stop payload from a real codey run and assert
`last_assistant_message` is non-empty and matches the visible reply, then drive an incoherent
reply → response-review holds it. Until that payload is captured live, this item is OPEN.

### P2 — Dashboard model badge (`SessionManager.ts:821,927`)

**Finding (ledger §4b — GAP CONFIRMED):** codey (`enabledFrameworks:["codex-cli"]`, no Claude) reports sessions as `model:"haiku"/"sonnet"`. `resolveModelForFramework('codex-cli', tier)` maps the tiers to gpt-5.x at launch, but the session record stores the raw tier alias.

**Fix:** record the framework-resolved model on the session (call `resolveModelForFramework(framework, options.model)` when assigning `model`), and/or add a `framework` field to the session record + dashboard badge. Acceptance: codey's Sessions tab shows `gpt-5.2`/`gpt-5.4-mini`/`gpt-5.5`, never a Claude name.

### P2 — asdf binary detection (`Config.ts` `detectFrameworkBinary`)

**Finding (ledger §0):** `detectFrameworkBinary('codex')` misses `~/.asdf/shims/codex` (asdf-managed), so instar can't find a real Codex on any asdf host → agent can't spawn Codex. Cross-cutting portability bug.

**Fix:** add `~/.asdf/shims/<name>` and an `asdf which <name>` probe to the search path. Acceptance: on an asdf-only host, a fresh Codex agent resolves its binary with no manual `frameworkBinaryPaths` override.

### P3 — Port remaining Claude PreToolUse guards to Codex

**Finding (ledger §2):** Codex PreToolUse is missing `slopcheck-guard` and `external-communication-guard` (and, per P1, gains deferral-detector). Candidates; each must first be confirmed stdin-based + not Claude-tool-specific, then made Codex-aware (exec_command/cmd) and wired + trusted (P0).

### P3 — Compaction-recovery redesign for Codex

**Finding (ledger §3):** Codex `PostCompact` carries no `additionalContext` channel (verified 0.133) → identity can't re-inject after compaction. Needs a different mechanism (UserPromptSubmit-ride re-injection, or investigate a systemMessage path). Set aside earlier rather than ship dead weight.

### P3 — external-operation-gate edge cases

**Finding (ledger §1):** gate matches `mcp__<server>__...` (confirmed in rollout logs) but (a) misses Codex native plugin tools (`browser_*`, `apply_patch` — Codex's own sandbox normally covers these) and (b) may pass-through a bare `mcp__playwright__` (empty action). Low priority; handle the empty-action edge, decide whether native browser tools warrant gating.

## 3. Conformance to instar standards

- **Structure > Willpower:** P0/P1 are the whole point — make the guards structurally enforced on Codex, not awareness-only.
- **Signal vs authority:** all gate scripts remain brittle signal emitters; the server-side gate endpoints (already framework-agnostic, live-200 on codey) retain blocking authority. No change to that split.
- **Migration Parity (NON-NEGOTIABLE):** every hook/wiring change ships a PostUpdateMigrator path (instar-owned Codex hooks are always-overwrite); existing Codex agents get the fixes on update, not just new ones.
- **Testing Integrity (3-tier) + test-as-self:** each fix needs unit + integration + E2E AND a live codey proof (drive the real engine, watch the gate do its job), per the Test-as-self standard.
- **No-manual-work:** P0 explicitly rejects "tell the user to click trust" — the fix must make trust programmatic/automatic, else the gap persists.
- **Near-silent:** none of these add user-facing chatter; they restore silent structural enforcement.

## 4. Tracked deferrals

None orphaned. Every item above is in this spec under the `codex-full-parity` project marker. P3 items are explicitly lower-priority but tracked here, not dropped.

## 5. Open questions for Justin / cross-model review

1. P0 fix path: is reverse-engineering the trusted_hash acceptable (version-coupled to Codex), or do we prefer a Codex-CLI trust command / interactive-mode reliance? **Recommend `/crossreview` on P0** — concurrency/supply-chain/precision failure modes are exactly what external models catch.
2. Should P0 also cover the operator's own personal Codex, or stay strictly per-agent (the enforcement-hook-layer spec chose per-agent)?

---

## 7. Convergence review findings (2026-05-25, 5 internal reviewers) — INCORPORATED

Ran `/spec-converge`'s internal panel (security, adversarial, integration, scalability,
lessons-aware) on this spec. External GPT/Gemini/Grok models need the billed cloud path
(not self-runnable here) — `/ultrareview` remains available to Justin for that extra layer.
The panel caught **two over-claims and several real bugs in already-committed P1/P2 code** —
all incorporated below. Resolutions become hard gates on the P0 build + the P1/P2 merge.

### BLOCKING (must resolve before the relevant code merges)

- **B1 — ✅ DONE 2026-05-25 (runtime-verified, no code change).** Captured a REAL Codex 0.133 Stop
  payload live (scratch agent, trusted Stop logger, real `codex exec` turn). Payload keys:
  `session_id, turn_id, transcript_path, cwd, hook_event_name, model, permission_mode,
  stop_hook_active, last_assistant_message`; `last_assistant_message` held the EXACT reply. So
  response-review.js + claim-intercept-response.js genuinely receive the reply at runtime on
  Codex — the schema≠runtime gap is closed, NO code change needed. (was the lessons-aware/adversarial blocking item)
- **B2 — P1-before-P0 dark-guard window.** The P1 migration always-overwrites `.codex/hooks.json`
  → hash change → Codex untrusts every guard until re-armed. If P1 releases before P0's
  auto-arm, existing Codex agents lose WORKING guards (incl. dangerous-command-guard) on update
  — strictly worse than today, on autonomous agents with no human to re-click trust. **Gate:
  P1 and P0 ship as ONE atomic release; AND `migrateHooks`' Codex branch must skip the hooks.json
  rewrite unless a working programmatic re-arm path is present (never overwrite trusted hooks
  without a re-trust path).** Add a migration test asserting trust entries exist for the
  rewritten hashes post-migrate. (×3 reviewers: adversarial, integration, lessons-aware)

### P0 hard gates (managed-config) — all must hold before P0 code merges

- **G1 — NOT the MDM/system tier.** Using `MdmManagedPreferences`/`SystemRequirementsToml` would
  turn an auto-updating npm package into a system-policy authority that installs un-disableable,
  out-of-sandbox-executing code with no human checkpoint. Use only the lowest-privilege,
  user-scoped, user-removable managed variant — or reject managed-config and use the fallback.
- **G2 — Per-agent scoping PROVEN, not assumed.** Hard gate (not "open question"): live-probe
  showing the managed file is read per-agent (per `CODEX_HOME`/config-dir), never machine-global.
  If it can only be machine-global → managed path rejected (it would touch the operator's personal
  Codex + every other project, violating the per-agent decision). 
- **G3 — Operator kill switch a compromised instar can't suppress.** "Agent-can't-disable" must NOT
  become "operator-can't-disable." Guarantee a documented `instar codex untrust-hooks` (or a
  user-deletable file at a user-writable path) + test it.
- **G4 — Content-hash pin + manifest verify.** The managed-install (and the trust-all fallback)
  must verify each instar hook script matches a known-good hash before registering/trusting —
  never blind-trust whatever is on disk (TOCTOU: an attacker dropping a hook in the dir during the
  install window would otherwise get auto-trusted). Tie to the hook-contract canary.
- **G5 — Runtime arming canary (not just schema-string probe).** After install, spawn a throwaway
  `codex exec` that triggers dangerous-command-guard on `rm -rf /` and assert the block ACTUALLY
  fired; run it on a schedule and alert if guards ever stop blocking. The current canary probes
  binary schema strings only — necessary but not sufficient; it would miss a silent managed-config
  format drift that re-darkens the fleet.

### Fallback (automate trust-all keystrokes) — gates

- **F1 — No bypass flags on the trust spawn.** Run it in the most restricted mode (NOT
  `--dangerously-bypass-approvals-and-sandbox`), match the exact prompt string before sending,
  hard-timeout+kill on mismatch (avoid a stray keystroke executing unsandboxed).
- **F2 — Positive verification + idempotency.** After the keystrokes, read back
  `~/.codex/config.toml [hooks.state]` and assert each instar hook has a fresh `trusted_hash` AND
  `enabled != false`. Skip the spawn entirely if hashes are already trusted (don't re-spawn a TUI
  on every patch migration). Guard the shared-config write with atomic write-rename / a lock
  (multiple agents share `~/.codex/config.toml` — last-writer-wins corruption hazard).
- **F3 — `enabled=true` only for never-trusted, not user-disabled.** Distinguish default-off
  (never trusted) from an explicit user `enabled=false`. Auto-enable only the former; surface the
  latter on a pull surface — never silently override a deliberate human disable.

### Real bugs in already-committed code (review-surfaced) <!-- tracked: codex-full-parity -->

- **C1 — asdf `asdf which` fallback is dead under launchd.** `asdf` itself isn't on the stripped
  launchd PATH, so the fallback throws in exactly the headless env that motivated the fix ("looks
  like a fallback, does nothing" anti-pattern). The PRIMARY shim-path existence check (PATH-independent)
  is sound and covers the documented case. FIX: drop the `asdf which` fallback (or resolve `asdf`
  via an absolute path before shelling). + add a test with a stripped PATH asserting the shim path
  still resolves. (integration, scalability)
- **C2 — `detectFrameworkBinary` not memoized → up to 6 subprocesses per `loadConfig`.** `loadConfig`
  calls both detectors and isn't cached; on a Claude-only host `detectCodexPath` falls through every
  candidate and pays `asdf which` + `which` every call. The asdf probe raises the floor cost. FIX:
  module-level memoize (cache positive AND negative results per name). (scalability)
- **C3 — scope-coherence Stop hardening.** It self-throttles (depth threshold + 30-min cooldown +
  never-blocks-headless) so it won't tight-loop, but it lacks the explicit `stop_hook_active`
  re-entry guard that claim-intercept-response has. Add one (cap corrections; immediately approve a
  correction-continuation) as belt-and-suspenders against a cooldown edge case wedging an autonomous
  Codex run. (adversarial)
- **C4 — canary should drift-detect, not hardcode the trio.** The fixed canary swaps one hardcoded
  expected-trio for another. Better: read the actually-installed Codex Stop group from
  config/hooks.json and assert instar's intended trio is present-and-TRUSTED — this also surfaces
  the `enabled=false`/untrusted conditions (B1/F2). (lessons-aware)
- **C5 — model-badge confirmed OK** at both records (headless + interactive); line 822 is the
  launcher INPUT (correctly the tier, resolved inside the builder) — not a bug. Note: forward-only
  (new sessions); persisted live sessions keep their old label until recreated (acceptable). (verified)

### Stop-trio latency (scalability MEDIUM)

- **C6 — ✅ CONFIRMED 2026-05-25 (no code change).** All three Stop hooks are bounded + fail-open:
  response-review (8s AbortController timeout → exit 0 fail-open); claim-intercept-response (NO
  server call — works off local facts/projects files + patterns, fast early-exits); scope-coherence
  (2s `http.get` timeout → resolve(null) fail-safe). Worst-case turn-end add ≈ 10s only if the
  server is slow, and every hook fails OPEN — so "if the server is down, Codex turns complete
  unblocked" holds. They don't all hit the server (claim-intercept is local), so no shared-budget
  change is warranted. C3's re-entry guard further bounds re-blocks.

### §4 correction
The P1-live-proof→P0 coupling (B1/B2) IS a deferral and must be a tracked binding, not prose:
P1 does not merge claiming "fixed" until the P0 armed-agent run captures the live Stop payload.
Bound under `codex-full-parity`. (Corrects the earlier "None orphaned.")
