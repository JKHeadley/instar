# Side-Effects Review — Playwright Profile Registry + Account-Access Awareness

Spec: `docs/specs/playwright-profile-registry.md` (converged 2 iterations, approved).
Tier: **2** (new feature: new store, 8 routes, migration parity, session-start hook,
config + dev-gate, agent awareness; risk floor raised by new-capability + identity-touch
+ fleet-rollout signals — Tier 2 matches).

## Phase 1 — Principle check (signal vs authority)

Does this change involve a decision point that gates information flow / blocks actions /
constrains agent behavior? **No blocking authority.** The feature is a
data + awareness + selection + tool layer:
- The boot block is an explicitly-ADVISORY signal (`<playwright-profiles>` envelope,
  "background signal, not authority — verify before acting"); login state is
  `lastAsserted`, never asserted as fact (D11).
- `activate` is a TOOL the agent invokes; it does NOT bypass any external-operation /
  coherence gate — switching the browser profile is not authorization to act as that
  identity (D12 + the activate clause).
- The only gates are the dev-agent dark gate + the `activate` `dryRun` — both ROLLOUT
  controls, not behavioral authority.

No brittle check holds blocking authority. Compliant with `docs/signal-vs-authority.md`.

## Phase 2 — Build location

Fresh worktree `.worktrees/playwright-profile-registry`, branch
`echo/playwright-profile-registry` off `JKHeadley/main` @461ceec0e (package.json
v1.3.579). `git remote -v`: JKHeadley = canonical. Identity set to
`Instar Agent (echo)` / `echo@instar.local`.

## The 8 questions

### 1. Over-block (what legitimate inputs does this reject that it shouldn't?)
- `userDataDir` jail (D9) rejects any path outside the agent home, `-`-prefixed, or
  NUL-bearing. A legitimate profile dir is always inside the agent home (the worktree
  convention / sandbox-stable home), so this rejects nothing legitimate. A user who
  genuinely wanted a profile outside the home would be rejected — intentional (the jail
  is the security boundary; out-of-home profiles are exactly the cross-agent-theft /
  sandbox-revocation hazard).
- Ref-validation fails CLOSED when the vault is unreadable (D17): a legitimate assign is
  rejected (409) while the vault is decrypt-failed/absent. Intentional — better to
  refuse than record an unvalidated ref. The vault being unreadable is itself an
  incident the operator should resolve first.

### 2. Under-block (what failure modes does this still miss?)
- The registry cannot observe a dead browser cookie — `lastAsserted: true` can be stale.
  MITIGATED by D11 (rendered staleness age + advisory framing + "verify before
  privileged action"), not eliminated. This is by design: the registry is a signal, not
  a liveness oracle. The agent must re-verify in-browser.
- `owner: agent|operator` is a self-asserted label, not a verified principal (D12 note):
  a poisoned/mistaken write could mislabel. MITIGATED by the audit log (attributable),
  the advisory framing, and the real act-as defense being the un-bypassed
  external-op/coherence gate — the label is a hint, never an authorization.

### 3. Level-of-abstraction fit
Correct layer. It mirrors the proven `BootSelfKnowledge` boot-block pattern + the
`CommitmentTracker` CAS pattern + the `credentialRepointing` dryRun convention. The
login keystrokes are deliberately NOT here (D8 — a non-deterministic interactive action
belongs in the agent, not a deterministic route). A smarter gate does not already own
this; it feeds awareness, it does not duplicate one.

### 4. Signal vs authority compliance
Compliant (see Phase 1). The boot block is advisory; `activate` does not gate behavior;
the dev-gate + dryRun are rollout controls. No brittle blocking authority added.

### 5. Interactions (shadowing / double-fire / races)
- `activate`'s session refresh + the MCP-health auto-refresh (`mcp-health-autorefresh.sh`)
  could both target playwright. MITIGATED: the auto-refresh has a hard once-per-(session,
  failed-set) loop-guard (verified at PostUpdateMigrator.ts:8442+); `activate`'s
  already-active fast path (no write/no refresh when the target dir is already set) +
  the per-session activate cooldown/window breaker prevent a restart storm (D19).
- Concurrent writes to `state/playwright-profiles.json`: single-writer CAS `mutate()`
  (D14) — no lost update (NOT bare `writeConfigAtomic`).
- The shared `resolvePlaywrightMcpConfig()` is the SINGLE source-of-truth for both seed
  and activate (F2) — the two paths cannot drift on "where the playwright arg lives."
- The boot fetch is added adjacent to the self-knowledge fetch in `getSessionStartHook()`
  — same fail-open shape; it cannot block boot (D22).

### 6. External surfaces
- New HTTP routes (`/playwright-profiles/*`) — Bearer-authed, whole-feature dev-gated
  (503 on fleet). Visible to the operating agent only.
- A new always-injected boot block — kept COMPACT (≤800 bytes, pointer-not-payload, D21)
  to respect the boot-bloat lesson (L1); full detail behind the route.
- The plaintext `state/playwright-profiles.json` lists account IDENTITIES + vault key
  NAMES (never values) — an at-rest access MAP. Documented honestly in the
  agent-awareness section (same posture as `SelfKnowledgeTree`/operationalFacts).
- `activate` (only when `dryRun:false`) mutates the playwright MCP config file +
  restarts the session — agent-initiated, audited, reversible.

### 7. Multi-machine posture
**Machine-local BY DESIGN** (D6). A browser profile's logged-in session lives in cookies
on one machine's disk and cannot be moved by copying metadata. The state file, routes,
and boot block describe only the machine serving the request; the boot block reads LOCAL
state even after a topic transfer. No replication, no proxied-on-read, no generated URLs
crossing a machine boundary, no user-facing notices needing one-voice gating. Registry
state does not strand on topic transfer (it correctly does not travel). The cross-machine
"which machine holds profile X" read is tracked as a follow-up
(<!-- tracked: CMT-1554-pwprofile-crossmachine-holder-view -->), not silently assumed.

### 8. Rollback cost
Cheap. Dark on the fleet by construction (dev-gated → all routes 503, session-start
injects nothing, state file inert). On a dev agent: `playwrightRegistry.enabled: false`.
`activate`'s config edit (only when `dryRun:false`) is reversed by activating `default`
(restores the no-arg built-in profile) or a one-line manual revert. No data migration,
no destructive state. The seeded default profile + `dryRun:true` config default are
additive. Back-out = flip the flag (no hot-fix release needed for the dark default).

## Verification

- `npx tsc --noEmit` → clean (exit 0).
- New tests: unit 47 + integration 14 + e2e 3 = 64, all green; `devGatedFeatures-wiring`
  82 green (picks up the new entry); ratchet/capability suites (no-silent-fallbacks,
  no-silent-llm-fallback, CapabilityIndex, capability-registry-generator,
  lint-dev-agent-dark-gate, PostUpdateMigrator-guardsCapabilitySection) all green.
- `node scripts/lint-dev-agent-dark-gate.js` → clean. `node scripts/lint-guard-manifest.js`
  → clean (request-driven feature, no manifest entry needed).

## Phase 5 — Second-pass review (independent)

**Concur with the review** — the implementation matches the artifact's claims and is
sound. Independently verified against the code (file:line):
1. activate (routes.ts:16933-17002): write+refresh gated behind `dryRun` default-true;
   already-active fast path skips both; per-session 30s cooldown + 5/5min breaker
   (:16758-16775) on the real-switch path only; rewrites only `mcpServers.playwright.args`
   + schedules a refresh, makes no authorization claim → cannot grant act-as. No storm.
2. No secret values: `listVaultNames` → `secretKeyPaths` (names only); audit log + boot
   block never carry values/refs-values. Invariant holds end-to-end.
3. Signal vs authority: boot block advisory; operator accounts marked "act-as only when
   authorized"; staleness rendered; no code consumes the block as authority.
4. Fail-closed/open: assign fails closed when vault names null; corrupt file → CRUD
   throws, never overwrites; block fails open; boot hook `curl -sf --max-time 4`,
   non-2xx/empty injects nothing.
5. CAS: genuine single-writer `mutate()` (statSig before/after + retry).
6. dev-gate: all 8 routes 503 on fleet; flag read fresh per request; `enabled` omitted;
   strip-false migration + DEV_GATED_FEATURES entry present.
7. sanitize: every rendered boot field through `sanitizeForBlock` (escapes `<`/`>`,
   strips control chars); envelope breakout impossible.
8. New risks: none material (reads call one-time idempotent ensureSeeded — no storm;
   audit-log re-sanitize advisory documented, not yet a live surface).
No hole in the activate restart path or the no-value invariant.
