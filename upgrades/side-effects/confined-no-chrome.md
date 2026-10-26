# Side-Effects Review — confined Claude sessions start with `--no-chrome`

**Version / slug:** `confined-no-chrome`
**Date:** `2026-10-25`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required — see §4/§5 (one constant CLI flag that removes a startup dialog; no decision surface, nothing loosened)`
**Tier:** `1` — one constant, one added argument, three test pins; a revert fully undoes it.
**Effort:** 0 spec rounds, 0 review rounds, 1 commit. Proportionate.

## Summary of the change

`CLAUDE_CONFINED_PERMISSION_ARGS` (`src/core/credentialEnvNames.ts`) gains `--no-chrome`, Claude
Code's documented "Disable Claude in Chrome integration" flag. `applyClaudeConfinement` splices
this constant into every confined launch (the feedback executor's canary and build sessions, and
the rerouted confined lane), so each of them now starts with the browser integration off.

**Why.** On 2026-10-25 at 15:50 PDT the first executor canary on 1.3.1437 (the fix for the E2BIG
shell failure) passed every runner probe and then failed the whole session half: the confined
Claude session wrote no report and no transcript. Its last screen was Claude Code's startup offer
*"Claude in Chrome extension detected … ❯ No, keep browser tools off / Yes, use my browser"*. The
startup state machine (`confinedStartupDialogs.ts`) knows that dialog and pressed Enter on the
safe default 0.5 s after it had answered the trust dialog; the key did not take (`browser-offer-
not-dismissed` after the dismissal budget), and by design each dialog is answered once. The
executor latched for a day (`failures: 9`).

**Why the flag and not a better dismissal.** A confined session has no browser tools (`--tools`
lists only file and shell tools; no MCP), so the offer is a question with exactly one valid
answer. Removing it at the source is strictly simpler and leaves nothing to time. The state
machine keeps its browser-offer handling as defence in depth for a future Claude Code that ignores
the flag.

**Why it appeared only now.** The offer is per config home: it shows when the login's
`.claude.json` lacks `claudeInChromeDefaultEnabled: false` and the Chrome extension is detected
on the machine. The 12:48 canary ran under a login that had the flag; the 15:50 canary ran under
one that did not (the pool rotates confined sessions across logins). Reproduced live (below).

## Decision-point inventory

None. The flag changes which startup dialogs Claude Code shows; it grants and refuses nothing.

## 1. Over-block

None. The session already cannot reach a browser (no MCP, no web, no browser tools in `--tools`).

## 2. Under-block

If a future Claude Code ignored `--no-chrome`, the offer would reappear and the existing state
machine would answer it as before — the same position as today, no worse. The canary would then
fail honestly (`session-ran-every-probe`) rather than pass.

## 3. Level-of-abstraction fit

The constant is the single place every confined launch's permission/tool arguments come from. The
adapter test (`session-manager-confined-reroute.test.ts`, `applyClaudeConfinement`) pins the exact
argv order including `--no-chrome` before `-p`; the two launch-site tests (reroute lane, confined
spawn) check membership of the flag (Codex review finding 3 corrected this sentence, which had
claimed exact pins at both sites). Putting the flag anywhere else would let one lane drift.

## 4. Signal vs authority compliance

No authority added or changed. (`docs/signal-vs-authority.md`: this is neither a detector nor a
gate.)

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point.

## 5. Interactions

- `applyClaudeConfinement` asserts `dontAsk` is present after the splice; unchanged.
- The startup state machine's `browser-offer` branch becomes unreachable in practice; left in
  place (defence in depth; its tests still pass).
- Headless (`-p`) confined launches receive the flag too; `claude -p` accepts it (CLI help lists
  it as a global option) and never showed the offer anyway.
- No change to the canary verdict, the latch, or the ladder. The current v2 latch (24h, written
  15:50) is cleared through the existing PIN-less lever `POST /feedback-factory/execute/canary-retry`
  once this installs, so the canary runs on the next tick instead of tomorrow.

## 6. External surfaces

None. The flag is visible only in `ps` for confined sessions.

## 6b. Operator-surface quality

Unchanged.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the argv is built on the machine that spawns the session; every machine
gets the change with the release.

## 8. Rollback cost

Revert the commit. No persisted state.

## Carried alongside: model-registry review (a found problem that blocked this commit)

`scripts/model-registry-freshness.manifest.json`: the 45-day review window expired at 00:00 UTC
2026-10-26 (last reviewed 2026-09-10) and the strict pre-commit lint began refusing every commit
in the repo — including this PR's follow-up. Fix now (it blocks the current work): the review is
done and recorded in `$lastReviewNote`. Pins re-checked live on 2026-10-25: codex `gpt-6-astra`
answered three independent review runs that day; `claude-fable-5` (and the current Claude 5.5 ids
`claude-fable-5-1`, `claude-opus-5-5`) answered `claude -p --model` probes on CLI 2.1.303 — the two
5.5 ids are ADDED as frontier rows (verifiedAt 2026-10-25) and no pin moved, so routing is
unchanged; `gemini-3.1-pro-preview` could not be re-probed (no gemini auth on the reviewing machine)
and is carried unchanged. Rollback: revert the manifest hunk; the lint then fails again on
staleness, which is the honest state.

## Conclusion

Ship. One flag, proven live, strictly fewer startup questions for a session that could never use
the answer.

## Second-pass review (if required)

Not required.

## Evidence pointers

- Live failure: `logs/server.log` 2026-10-25T22:49:43–54Z — `awaiting-trust-dismissal → awaiting-browser-dismissal (action keys)` then `awaiting-browser-dismissal → failed`, degradation `startup browser-offer-not-dismissed (observed browser-offer)`; `GET /feedback-factory/execute/status` → `session-last-screen` detail quoting the offer; canary 15:49:57 PDT failed only the session probes.
- Live proof (2026-10-25 15:57 PDT, Claude Code 2.1.303, tmux, `CLAUDE_CONFIG_DIR=<a login without the Chrome flag>`): `claude --permission-mode dontAsk --tools Bash,Read` → after the trust dialog, the screen shows "Claude in Chrome extension detected … ❯ No, keep browser tools off / Yes, use my browser"; `claude --no-chrome --permission-mode dontAsk --tools Bash,Read` → after the trust dialog, straight to the prompt with the `don't ask on` footer. Under a login WITH `claudeInChromeDefaultEnabled: false`, neither variant shows the offer (which is why the 12:48 canary had not hit it).
- Honest note on the live proof: pressing Esc to end the offer in the un-flagged variant wrote `claudeInChromeDefaultEnabled: false` into that login's `.claude.json` (Claude Code records the answer). That is the answer a human would give and is harmless; it is named here because the test touched a real login's config, and because it means the SAME login would not show the offer again — the pool's other un-flagged logins still would, which is why the flag (not the config edit) is the fix.
- First local verify (70e5e2b29, 2026-10-25 23:33–23:53Z): 7 integration + 2 e2e failures, all in `subscription-relogin-runtime` / `subscription-relogin-lifecycle`, which do not touch the confined argv and pass 16/16 on this branch locally on the same merge base; the verifier retains no per-test output (filed fb-e30113d7-578). Re-verified on this head.
- Unit: `session-manager-confined-reroute.test.ts`, `session-manager-confined-spawn.test.ts`, `feedback-factory/execute-units.test.ts` — 68/68 green with the exact argv pinned including `--no-chrome`; `tsc` clean.

## Class-Closure Declaration (display-only mirror)

The class is "a Claude Code startup dialog a confined session cannot answer in time". This closes
the one member whose answer is fixed (the browser offer) at the source; the trust dialog genuinely
needs an answer and keeps its state-machine handling. No self-triggered controller is added or
modified.
