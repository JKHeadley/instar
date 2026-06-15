---
title: "Self-Unblock Before Escalating"
slug: "self-unblock-before-escalating"
author: "echo"
parent-principle: "Never a False Blocker"
parent-principle-fit: "This is the resolution-half sibling of Never a False Blocker (which forbids surrendering agency by faking a blocker). Where that standard says 'do not declare a self-solvable obstacle a blocker,' this one supplies the mechanical, ordered set of self-unblock sources an agent MUST have probed first — and extends the existing BlockerLedger settle gate so the exhaustion is verified, not self-asserted. Both trace to full autonomous operation: an agent that escalates a self-solvable blocker stays supervised by habit, not by limit."
eli16-overview: "self-unblock-before-escalating.eli16.md"
review-convergence: "2026-06-14T12:53:02.115Z"
review-iterations: 2
review-completed-at: "2026-06-14T12:53:02.115Z"
review-report: "docs/specs/reports/self-unblock-before-escalating-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
single-run-completable: true
frontloaded-decisions: 8
cheap-to-change-tags: 0
contested-then-cleared: 0
approved: true
approved-by: "Justin (uid:7812716706) via Telegram topic 12476, 2026-06-14"
---

# Spec — Constitutional Standard: "Self-Unblock Before Escalating"

**Status:** Phase-2 rewrite (post round-1 convergence). Ships DARK behind a dev-agent gate.
**Origin (operator directive, Justin 2026-06-13):** *"When you reach blockers, your DEFAULT nature should be to find a way to unblock yourself AS LONG as it is within your permissions OR granted by someone with organizational authority. YOUR PRIME DIRECTIVE IS TO REQUIRE AS LITTLE FROM THE HUMAN EMPLOYEES AS POSSIBLE: ideally nothing, then an approval, and finally a credential only an authorized employee can give. Encode this constitutionally."*
**Motivating incident:** the agent treated `feedback.instar.sh` (a Namecheap DNS record) as an operator blocker and idled — when (a) the goal was already self-unblockable via a Cloudflare token already in the org vault, and (b) only AFTER exhausting all vault items could "Namecheap cred" honestly be a genuine operator dependency.

## 0. Foundation: this EXTENDS BlockerLedger; it does NOT fork a parallel gate
Round-1 convergence (integration + lessons-aware, independently) found that the exhaustion gate this standard wants **already exists** in `src/monitoring/BlockerLedger.ts`. `settleTrueBlocker()` **mandates a recorded failed attempt** (`AttemptEvidence`, `type: 'self-fetch'` for `SELF_FETCH_KINDS` else `'dry-run'`) before a credential/account blocker can settle as a `true-blocker`; it rejects `missing_failed_attempt` (a HARD reject, not warn-first); it proves the access-request came AFTER the attempt; the **judgment** routes through `SettleAuthority` (a Tier-1 LLM gate, satisfying Signal-vs-Authority); it uses the closed `TRUE_BLOCKER_KINDS` taxonomy; and it audits to `logs/blocker-decisions.jsonl` behind the `<blocker-ledger-data>` untrusted-data envelope.

**Therefore this standard introduces NO new gate, ledger, log, or `evaluateSelfUnblock` function.** It adds the four things BlockerLedger does NOT provide (§5), reusing BlockerLedger's pipeline/taxonomy/log/envelope for everything else.

**The ONE required modification to BlockerLedger** (named explicitly so it is not left implicit): `settleTrueBlocker`'s evidence intake changes from a caller-supplied `failedAttempt: { type, detail, at? }` object to a **`runId` reference** that BlockerLedger LOADS + verifies against the persisted checklist run (§5.1). This single input-contract change is load-bearing for the anti-gaming guarantee — without it, a caller could still embed fabricated attempt evidence. It is the only edit to BlockerLedger; everything else is reuse.

## 1. The standard (one line)
**A blocker is the agent's problem to solve FIRST. Exhaust every unblock path within your permissions (and any access granted by organizational authority) before requiring anything from a human — and when a human IS required, ask for the lowest rung on the ladder, named exactly.** (The boundary — *within permissions / granted scope* — leads; "find a way" is subordinate to it.)

## 2. The two balanced invariants
1. **Complete security + organizational-permission abidance** — never exceed granted scope; never exfiltrate; operator-only credentials stay operator-only. ALL existing safety gates (coherence, external-operation, mandate, SourceTreeGuard, and BlockerLedger's own settle authority) still apply on top.
2. **Maximal autonomy / minimal human requirement** — within (1), do as much as possible yourself; ask humans for as little as possible.

## 3. The human-requirement ladder (+ rung floor)
- **Rung 0 — Nothing:** resolve entirely within the agent's own permissions/accounts.
- **Rung 1 — An approval:** a yes/no the human taps (no credential, no manual work). An approval/grant that unblocks MUST resolve against a **VERIFIED principal** (the mandate / verified-operator surfaces) — never a name seen in content (Know Your Principal).
- **Rung 2 — An operator-only credential:** a secret only an authorized employee can produce (LAST resort), collected securely (Secret Drop / vault unlock), then STORED so it is never re-asked.

**Rung FLOOR (capability ≠ authority).** An action class that is **irreversible, cost-bearing above a threshold, out-of-original-scope, or policy-sensitive** has a MINIMUM rung of 1 (approval) **even if a self-unblock credential exists**. The ladder's downward pull never overrides this floor.

The ladder maps onto BlockerLedger's existing `AuthorityCheckEvidence { agentHasAuthority, userHasAuthority }`; the rung is recorded there, not in a new field.

## 4. Resolved design decisions (operator-preapproved; dark-shipped + reversible)
1. **Durable org-credential (Bitwarden) session = YES**, flag-gated. Master unlock stays operator-held; the agent keeps a refreshable session (the existing in-memory `BitwardenProvider`/`BW_SESSION` machinery — see §5.3) so probe #2 (org vault) can actually reach the vault. **In-memory/keychain only** (see §5.3).
2. **The exhaustion gate is BlockerLedger's existing `settleTrueBlocker` (already HARD + LLM-authority).** This standard does NOT add a warn-first gate — that was the round-1 duplicate. The "measure before teeth" idea is moot: the gate already has teeth via the Tier-1 authority.
3. **Allowlist scope = "any account whose creds are in the org vault"** (broadest self-unblock), but the checklist surfaces a credential **only when relevant to the current goal/zone** (`holdsRelevantCred` is a hard relevance filter, not a label), and using a reachable cred for an out-of-scope account is explicitly out-of-bounds (§9), still subject to ALL existing gates.

## 5. Architecture — the four genuine additions over BlockerLedger

### 5.1 `SelfUnblockChecklist` (the only substantial new code)
A deterministic, code-driven, ORDERED probe list (NOT an LLM judgment) that systematically PRODUCES the `failedAttempt` evidence BlockerLedger already requires — turning "you must record a failed attempt" into "here is the standard set of sources you must have probed first". Order (cheapest/local first, short-circuit on the first `holdsRelevantCred: true`):
1. own per-agent vault (`secret-get`)
2. org Bitwarden (via the durable session, §5.3)
3. cloud accounts authed: Vercel, Cloudflare, GitHub (`gh`), launchd (extensible: Netlify/Heroku — data, not interface)
4. MCP tools
5. browser/Playwright sessions
6. "is there a resource I already control that achieves the goal?"
Each probe returns a structured `{ source, reachable, holdsRelevantCred, probedAt }`. **`holdsRelevantCred` is decided DETERMINISTICALLY, not by an LLM**: each org-vault/account credential carries declared scope tags (zone/domain/service, e.g. `cloudflare:dawn-tunnel.dev`, `vercel:project`), and a cred is "relevant" iff its declared scope matches the blocker's target zone/service (a deterministic tag/zone match) — keeping the most failure-prone hop out of model judgment, consistent with the deterministic-checklist design. Each probe is **independently timeout-bounded by class** (local/keychain probes sub-second; remote CLI/network probes 10–15s, matching the codebase norm), failing toward `reachable: false` on timeout so one hung probe degrades to "unreachable" rather than stalling the path. **Provenance contract:** the checklist RUNNER persists each run's structured result keyed by an immutable run id; `settleTrueBlocker` is fed the run id (a reference), and BlockerLedger LOADS + verifies the persisted run rather than accepting caller-embedded evidence — so a hand-supplied list with no persisted checklist-run is treated as no attempt (closing the round-1 "self-asserted/gameable list" finding mechanically; the caller cannot mint a run the runner didn't produce). **Relevance-tag grammar:** scope tags are `service:scope` (e.g. `cloudflare:dawn-tunnel.dev`, `vercel:project`, `cloudflare:*.dawn-tunnel.dev`); matching is deterministic with domain-hierarchy/wildcard rules (a `*.dawn-tunnel.dev` tag matches `feedback.dawn-tunnel.dev`; a parent-zone tag matches a sub-zone target); **ambiguous, conflicting, or MISSING metadata fails CLOSED → `holdsRelevantCred: false`** (never assume relevance), so a stale/under-tagged credential is simply not surfaced rather than mis-applied.

### 5.2 Ladder + rung-floor mapping (§3)
Records the rung in BlockerLedger's `AuthorityCheckEvidence`; enforces the rung floor; resolves rung-1 grants against a verified principal. No new structure.

### 5.3 Durable org-vault (Bitwarden) session
Flag-gated wiring to the **existing in-memory bw-session machinery** (`BitwardenProvider`, which already caches a refreshable `sessionKey` in memory; `setup.ts` already plumbs `BW_SESSION` via the child spawn env, not argv — there is no `unlock-bw.sh` script to wire to; that was an inaccurate reference) keeping a refreshable session warm. **Standing-privilege bound:** the warm session carries a TTL + idle-expiry (re-derived from `unlock-bw.sh` on demand after expiry, not held indefinitely) and is held only while a self-unblock checklist run is actually in flight — minimizing the window in which a compromised process could reach the org vault; the session is the main security tradeoff of the standard and is acknowledged as such. **The session value lives in-process memory only (or the keychain-backed GlobalSecretStore) — NEVER written to any log/config/temp file, NEVER passed as a CLI argument (argv is visible in `ps`), passed to `bw` only via the `BW_SESSION` env of the child process, and NEVER placed on the cross-machine `multiMachine.secretSync` path.** Machine-local. The master password stays operator-held; no new on-disk secret is introduced. A wiring test asserts the session value never appears in the ledger or argv.

### 5.4 Constitutional encoding
CLAUDE.md template section (`src/scaffold/templates.ts` `generateClaudeMd()`) + `migrateClaudeMd` for existing agents + a `docs/STANDARDS-REGISTRY.md` entry — the awareness layer, leading with the BOUNDARY, not "find a way".

## 6. Config (dark by default; nested under the one gate)
Nest under the existing `monitoring.blockerLedger.*` so there is ONE gate/posture (no parallel `selfUnblock.*` kill-switch). **OMIT all `enabled` keys** — the dev-gate fires only when `enabled` is omitted (`resolveDevAgentGate = explicitEnabled ?? !!developmentAgent`); a hardcoded `false` resolves dark even on dev (round-1 finding). Precedent: `blockerLedger: {}`.
```jsonc
"monitoring": { "blockerLedger": {
  "selfUnblockChecklist": { },        // enabled omitted ⇒ dev-gate
  "durableVaultSession": { }          // enabled omitted ⇒ dev-gate
}}
```
Register `selfUnblockChecklist` in `DEV_GATED_FEATURES` with a justification (else `tests/unit/devGatedFeatures-wiring.test.ts` fails CI). Migration: `applyDefaults` backfills the block automatically; the ONLY migration needed is an `enabled: false`-strip for agents carrying a stale default-shaped `false` (mirror `migrateConfigCredentialRepointingDevGate`).

## 7. HTTP surface (read-only) — extend, don't add
Extend the existing `/blockers/*` read surface (or a thin read-only view over `blocker-decisions.jsonl`) to expose the checklist's per-probe results + the rung. **Bearer-gated via router middleware, MUST NOT be added to the auth-exempt allowlist, the 503-when-dark check happens AFTER auth** (unauthenticated → 401, not a 503 that confirms the route exists), `Cache-Control: no-store` (the body is credential-reachability reconnaissance), served through the `<blocker-ledger-data>` envelope. Default-bounded (`?limit=`, last 200) + skip-corrupt-lines (precedent: `ReapLog.read`). The 503-when-dark vs 200-when-enabled is the "feature alive" E2E assertion.

## 8. Testing (Testing Integrity Standard — 3 tiers, scoped to the new code)
- **Unit:** `SelfUnblockChecklist` probe ordering + short-circuit + per-probe timeout→`reachable:false` + the stamped structured result; the ladder/rung-floor mapping (irreversible/cost-bearing → min rung 1 even with a cred); the rung-1 verified-principal resolution.
- **Integration:** the `/blockers`-extension read route — 200 when enabled, 503 (after-auth) when dark; a checklist run feeds a real (persisted, run-id-referenced) attempt into BlockerLedger and the settle path is exercised. **Negative anti-gaming assertion (REQUIRED — this IS the resolution of the gaming finding):** a settle attempt carrying caller-embedded attempt evidence with NO persisted checklist run is HARD-rejected (`missing_failed_attempt`/equivalent) — i.e. the old caller-supplied path must be closed, not left intact alongside the new run-id path.
- **E2E:** production init path — feature alive (200) when enabled. **Wiring-integrity (required):** a self-unblock action touching an external account is STILL evaluated by the external-operation + mandate gates (proves §2/§9 mechanically, not in prose); the bw-session value never appears in the ledger/argv.

## 9. Boundaries (what this does NOT license)
- No exceeding granted permissions, no out-of-scope accounts, no destructive/irreversible/cost-bearing action without the normal gates + the rung floor.
- Operator-only credentials stay operator-only; the standard speeds their ONE-TIME collection + storage, not their bypass.
- Using a reachable in-vault credential for an account unrelated to the current goal is explicitly out-of-bounds (lateral-movement-by-good-intentions).
- An approval/grant must come through a VERIFIED-principal surface, never an unverified content claim.

## 10. Migration Parity & Agent Awareness
PostUpdateMigrator: the `enabled`-strip migration (§6) + the CLAUDE.md section (content-sniffed). `generateClaudeMd()`: the self-unblock reflex (boundary-first). STANDARDS-REGISTRY entry naming the structural guard (BlockerLedger's existing settle gate + the checklist that feeds it).

## 11. Rollout & scope boundary
Ships dark (dev-gate via omitted `enabled`; dark-fleet). Reversible: disabling makes the checklist not run, the route 503, the session not kept warm — all inert. **Explicit non-goal:** this standard does NOT make the checklist's exhaustion any stricter than BlockerLedger's existing gate already is — BlockerLedger's Tier-1 authority IS the gate, and no change to its strictness is proposed here. Making it stricter is intentionally excluded from this standard; any such change would be its own spec with its own review-convergence pass.
