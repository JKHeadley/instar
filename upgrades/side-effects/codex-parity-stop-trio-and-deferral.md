# Side-Effects Review: Codex parity P1 — correct Stop trio + deferral-detector on PreToolUse (Codex-aware)

## Change
From the APPROVED master spec (`docs/specs/codex-full-parity-fixes.md`, P1):

1. **`installCodexHooks.ts` — fix the Codex Stop review trio.** Codex `Stop` now wires
   `response-review + claim-intercept-response + scope-coherence-checkpoint`, MIRRORING
   the Claude Stop trio (`settings-template.json`). Previously it wrongly wired
   `response-review + deferral-detector + scope-coherence` — it had dropped
   `claim-intercept-response` (the anti-confabulation Stop hook) and substituted
   `deferral-detector`, a PreToolUse hook whose `tool_name==='Bash'` guard makes it a
   silent no-op on a Stop payload (PROVEN dead via payload replay, ledger §1).
2. **`installCodexHooks.ts` — deferral-detector moved to Codex `PreToolUse`** (where it
   lives on Claude), joining dangerous-command-guard + external-operation-gate +
   grounding-before-messaging.
3. **`PostUpdateMigrator.getDeferralDetectorHook()` — Codex-aware payload.** The script
   now accepts `tool_name` ∈ {`Bash`, `exec_command`} and reads
   `tool_input.command || tool_input.cmd` — the same fix class already applied to
   dangerous-command-guard and grounding-before-messaging. Previously Claude-only.
4. **`codexHookContractCanary.ts` — corrected invariant lock.** Now asserts the correct
   Stop trio (with claim-intercept-response), asserts deferral-detector is on PreToolUse,
   and FAILS if deferral-detector ever appears on Stop again (locks out the regression).
   The canary previously asserted the WRONG trio — it had encoded the bug as correct.

## Why
- The Stop trio must match Claude's so Codex agents get the same end-of-turn review
  (coherence + anti-confabulation + scope). deferral-detector on Stop did nothing; the
  real anti-confabulation hook (claim-intercept-response) was absent.
- deferral-detector on PreToolUse + Codex-aware means it actually inspects Codex shell
  (`exec_command`) messaging commands, not just Claude `Bash` — so its false-blocker /
  orphan-TODO checklist fires on Codex too.

## Scope / blast radius
- `claim-intercept-response.js` is already installed for Codex agents (PostUpdateMigrator
  hook-install set + on codey on disk), so wiring it onto Stop references an installed
  script (no dangling reference; `validateHookReferences` guards this).
- Migration parity: `migrateHooks` re-runs `installCodexHooks` for codex-cli agents
  (always-overwrite for instar-owned groups), so existing Codex agents pick up the
  corrected wiring on update. deferral-detector.js is always-overwrite, so existing
  agents get the Codex-aware payload reading too. NOTE: rewriting hooks.json changes the
  hashes → Codex marks them "needs review" until trusted; the trust-activation gap is
  P0 (separate fix). This change makes the wiring CORRECT; P0 makes it ACTIVE.
- Claude agents unaffected — the deferral-detector payload change is purely additive
  (still reads Bash/command; now ALSO exec_command/cmd).

## Signal vs Authority
- Unchanged. All three Stop hooks remain low-context signal emitters that POST to the
  server's review endpoints for the authoritative decision; deferral-detector still only
  injects a checklist (`decision:'approve'` + additionalContext), never blocks.

## Over-block / autonomy risk
- None added. scope-coherence retains its self-throttle; claim-intercept-response and
  response-review behave on Codex as on Claude (PENDING the payload-field confirmation —
  see "Known follow-up").

## Known follow-up (tracked) <!-- tracked: codex-full-parity -->
- response-review.js and claim-intercept-response.js both read `input.last_assistant_message`
  on Stop. Whether Codex's Stop payload populates that exact field is being confirmed by
  capturing a real Codex Stop payload (next P1 commit). If Codex names it differently,
  those two get the same multi-field-accept treatment. The WIRING here is correct
  regardless; this is about the two scripts' payload-field reads.

## Rollback
- Revert the installCodexHooks Stop/PreToolUse arrays, the canary edits, and the
  deferral-detector generator edit. No data migration, no config change.

## Tests
- `installCodexHooks.test.ts`: trio assertion updated to claim-intercept-response; +1 test
  that deferral-detector is on PreToolUse and NOT Stop. 9 green.
- `codexHookContractCanary.test.ts`: invariant assertions updated (+ deferralOnPreToolUse). 6 green.
- `deferral-detector-orphan-todo.test.ts`: +2 Codex `exec_command`/`cmd` cases (fires on
  orphan-TODO; ignores clean). 16 green. tsc clean.
- Live test-as-self: batched with the rest of the build before merge.

## Publish
- Feature branch `echo/codex-parity-audit` (rebased onto JKHeadley/main before PR). Patch release.
