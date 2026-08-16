# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

A Codex sign-in that you completed successfully is no longer thrown away and re-asked.

Three defects compounded into one loop. A Codex sign-in was pointed at its private folder using
`CLAUDE_CONFIG_DIR` — a variable the Codex CLI ignores — so the login actually ran against the
machine's ambient `~/.codex` while the pool recorded an isolated `configHome`. Nothing ever detected
that a sign-in had succeeded: `complete()` is only reached from an HTTP route, and a `device-code`
flow (Codex, grok) has no paste-back step to trigger one, so the record stayed `pending`
indefinitely. And every reissue killed the login's tmux pane before starting a new one — destroying
the process that was waiting for the operator's approval.

The result was a sign-in that could never finish: approve, nothing notices, the code expires, the
listener is killed, a fresh code appears, repeat. Observed live at 33 reissues over eight hours on
one account, still running when found — each iteration re-running `codex login` against the
operator's real Codex account.

Now the isolation variable is per-framework (`CODEX_HOME` for Codex, `GROK_HOME` for grok,
`CLAUDE_CONFIG_DIR` for Claude, and **nothing** for a framework whose variable instar has not
verified), and the reissue sweep checks whether a `device-code` login already succeeded — by looking
for a credential in its slot newer than the login itself — and completes it instead of re-driving.

## What to Tell Your User

- "If a Codex sign-in kept handing you new codes, approve one and it will finish now."
- "Signing in to Codex no longer disturbs the Codex account already on that machine."
- "If you connected a Codex account before this fix, its credential may not be in the folder the
  account list claims — worth a check."

## Summary of New Capabilities

None. This is a bug fix. No new endpoint, no new configuration key, no new behaviour to opt into.

## Compatibility Notes

**The Claude sign-in flow is deliberately untouched.** The success check applies only to
`device-code` flows. Claude uses `url-code-paste`, which already completes through the dashboard
route, and a Claude slot's credential file is rewritten by ordinary token refresh — so witnessing it
could mistake a routine refresh for someone finishing a sign-in. Pinned by a test.

**A credential that predates the sign-in does not count as success.** Re-connecting a slot that still
holds the previous account's credential re-drives exactly as before, rather than being marked
instantly complete. Also pinned by a test.

**Every uncertainty preserves the old behaviour.** No witness wired, no credential present, an
unreadable slot, a probe that throws, an unparseable timestamp — all fall back to issuing a fresh
code. The check can only ever prevent instar from discarding a sign-in that worked; it cannot strand
you on a dead code.

**`gemini-cli` and `pi-cli` now get no isolation variable** instead of `CLAUDE_CONFIG_DIR`. Their
actual behaviour is unchanged — they ignored that variable either way — but the spawned command no
longer implies an isolation it never provided.

## Evidence

107 tests across the enrolment surface, including 26 in the login-driver unit suite, 44 in the
enrolment-wizard unit suite, and 12 integration tests driving the real reissue route over a real
credential file on disk with the witness composed exactly as production composes it.

The isolation-variable defect was proven against the real CLI rather than reasoned about:
`CLAUDE_CONFIG_DIR` pointed at an empty directory still reported "Logged in using ChatGPT", while
`CODEX_HOME` pointed at the same directory correctly reported "Not logged in".

Shown capable of failing: inverting the success comparison fails exactly the three behavioural tests
— completion, the re-enrolment guard, and the restart-recovery path — while the uncertainty and
flow-kind invariants keep passing. Without those controls, "it completes now" would pass equally well
against a change that marked every pending login complete on sight.
