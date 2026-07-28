# Convergence Report — WS5.2 Account Follow-Me operator code paste-back

## Cross-model review: codex-cli:gpt-5.5

A real GPT-tier external pass (codex CLI, gpt-5.5) ran and **succeeded on every round** (9 rounds). Gemini was attempted in round 1 and **degraded (timeout)**; because codex succeeded, the spec-level external posture is the clean RAN flag. This is a genuine outside-the-Claude-family opinion, not a phantom.

## ELI10 Overview

When you let one of your machines borrow another machine's subscription, the sign-in has two steps: open a link and log in, then paste back a short **code** the provider gives you. Until now the dashboard showed the "Sign in" link but had nowhere to put the code — so in a real run the operator signed in, got a code, and had to send it through chat for the agent to paste in by hand. That's clumsy and a little unsafe (a sign-in code shouldn't sit in a chat log).

This change adds a code box right on the card. After you sign in, you paste the code there and tap Submit; it goes straight to the machine doing the login over the same secure connection the dashboard already uses — never through chat — and the card updates to "Done." Under the hood there's a route on the target machine that types the code into the waiting login (only after verifying the login is actually still waiting), and a relay so your single dashboard can reach whichever machine owns the login.

The main tradeoffs the review wrestled with: typing a code into a live terminal is a real (if narrow) capability, so the design bounds it heavily — it only works for the right kind of login, only when the pane is genuinely at the code prompt (it refuses rather than risk typing into a shell), only one submit at a time, and only the short code itself (a pasted URL is rejected). The code is never stored or logged, and the account that results is still independently validated against the operator-approved email before it's used.

## Original vs Converged

The original spec was a sound three-piece design (code field + target route + relay) with five frontloaded decisions. Nine rounds of cross-model review plus an internal security/decision-completeness panel expanded it to twenty frontloaded decisions and changed the implementation in several real ways:

- **Pane targeting** moved from a formula duplicated in two files to a single shared `enrollPaneSessionName` helper (they can no longer drift).
- **The code is validated** as a single token (no whitespace/control chars), a pasted URL is rejected, and the length is capped — none of which the original had.
- **Pane readiness** went from "the pane exists" to "the pane is genuinely at the code prompt" (positive paste+code match on the last lines + a negative shell-prompt check) — and, critically, this guard now **fails closed**: if we can't capture and verify the pane, we refuse rather than blind-type. (The internal panel caught that an earlier version skipped the check when the capability was absent — a fail-open safety guard, now fixed.)
- **Concurrency** got a per-login in-flight mutex; **observability** got a greppable terminal-outcome log; **scrollback** is cleared best-effort after submit.
- The **authority framing** was corrected from "no new authority" to "no new credential-returning authority; a narrow, bounded paste-back authority."

## Iteration Summary

| Iteration | Reviewer(s) | Verdict | Material findings | Spec/code changes |
|-----------|-------------|---------|-------------------|-------------------|
| 1 | conformance gate; codex; gemini(timeout) | MINOR | 6 (codex) + 1 (gate) | shared pane helper; code-shape validation; kind guard; observability log; S7-as-validator clarification; client copy |
| 2 | codex | MINOR | 5 (refinements) | in-flight mutex; FD10–FD12; authority wording |
| 3 | codex | SERIOUS | 2 material (pane-readiness, scrollback) + 2 doc | readiness check; clear-history; FD13–FD15 |
| 4 | codex | MINOR | 1 (URL reject) + docs | URL-reject guard; FD16–FD19 |
| 5 | codex | MINOR | 0 new (repeats) + 3 nits | capture-window 12 lines; cap 4096→512; response-schema table |
| 6 | codex | MINOR | 0 new (repeats) | negative shell-prompt check; doc strengthening |
| 7 | codex | MINOR | 1 (crash-window) + repeats | FD20 (crash recovery) |
| 8 | codex | MINOR | 0 new (all repeats) | — |
| — | internal panel (security + decision-completeness/lessons) | — | **1 material (fail-open readiness)** | fail-closed readiness; cleared-audit; FD13/FD10/FD8/FD19 doc |
| 9 | codex | MINOR | 0 new (all repeats) | (converged) |

## Full Findings Catalog (by theme)

- **Pane-name drift (codex r1#1)** → shared `enrollPaneSessionName` helper + regression test. RESOLVED.
- **Code escaping/shape (codex r1#2, r2#2)** → single-token validation; `sendInput` confirmed argv-safe (`send-keys -l --`). RESOLVED.
- **Replay/one-shot (codex r1#3)** → login removed on complete = one-shot; documented FD8. RESOLVED.
- **Authority framing (codex r1#4, r2#5)** → narrowed to "paste-back authority"; kind guard. RESOLVED.
- **Weak completion oracle (codex r1#5)** → S7 email-gate is the validator; file-existence only a trigger. RESOLVED.
- **UX code ambiguity (codex r1#6)** → client copy "the code the page gives you"; URL-reject. RESOLVED.
- **Concurrent submit (codex r2#1)** → per-login in-flight mutex + test. RESOLVED.
- **Pane readiness (codex r3#1)** → positive paste+code check; **fail-closed** (internal panel) + negative shell-prompt check (codex r6). RESOLVED.
- **Scrollback residual (codex r3#2)** → best-effort clear-history + honest FD1 + cleared-audit. RESOLVED.
- **CSRF posture (codex r3#3)** → documented header-only-Bearer (token in JS memory, not cookie). RESOLVED.
- **Crash-during-submit (codex r7#2)** → documented bounded recovery via existing sweep (FD20). RESOLVED.
- **Fail-OPEN readiness guard (internal panel, MATERIAL)** → readiness now fails closed (503 if uncapturable, 409 if empty/unready); tests added. RESOLVED.
- **Standing design-decision disagreements (repeats r4–r9): PTY-state wrapper, per-login ACL, rate-limiting** → each a documented Signal-vs-Authority decision (FD16/FD18/FD19): heuristic-not-brittle-exact-match, operator-is-single-principal, malformed-code-can't-reach-pane. NON-MATERIAL (the reviewer prefers heavier engineering than the risk warrants; the decisions are explicit and justified).

## Convergence verdict

**Converged at iteration 9.** From round 4 onward the external reviewer's findings stabilized into a fixed, recurring set of design-preference disagreements — all addressed as documented Frontloaded Decisions. The one genuinely new material finding across the whole process (the fail-open readiness guard) came from the internal security panel and is fixed + regression-tested. Round 9 produced zero new material findings. `## Open questions` is empty. The spec is ready for user review and approval.
