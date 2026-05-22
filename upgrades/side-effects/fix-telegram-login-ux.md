# Side-effects review — Telegram login UX (narrative-driven prompt)

Per L6. Seven dimensions.

## 1. Over-block / under-block

Before: UNDER. v1.2.17 Codex prompt only described internal actions
("take snapshots", "look for login transition"). Codex did exactly
that — silently. User stared at a QR code for 2 minutes with no
on-screen guidance, hit the 120s timeout, fell to manual.

After: precisely targeted. Prompt now explicitly demands user-facing
narration at every step — before opening the browser, during the
login wait (every 25-30s reminders), between BotFather sub-steps.
Login window also bumped to 5 minutes for fresh users who haven't
installed Telegram yet. No over-block: the wizard still falls
through to the readline backstop on any failure.

## 2. Level-of-abstraction fit

Pure prompt-content change. No new functions, no new modules, no
new abstraction. The prompt's conversational rules section is a
direct translation of the wizard SKILL.md's "speak conversationally
/ never show CLI" rules into Codex-training-aware language.

## 3. Signal vs Authority compliance

- The user's eyes are the AUTHORITY for "did this UX work." The
  prompt content is a SIGNAL aimed at producing the right UX.
- The verifier (`verifyTelegramConfig`) remains the AUTHORITY for
  "did the agentic path succeed." Prompt content doesn't change
  the success criterion.
- The user-facing reminder cadence (~25-30s) is a SIGNAL the
  prompt sends to Codex — not enforced structurally. If a future
  log shows Codex ignoring the cadence, we revisit with an outside-
  the-spawn timer.

## 4. Interactions with adjacent systems

- **`runTelegramAgentic`**: comment-only edits (removed the now-
  redundant pre-spawn instruction lines that the prompt itself now
  prints).
- **Spawn timeout**: unchanged (10 min outer wall). The 5-min
  login-wait is enforced inside the prompt by Codex.
- **`verifyTelegramConfig`**: unchanged.
- **`runTelegramSetup` (readline backstop)**: unchanged. Still
  catches AGENTIC_FAILED via verifier check.
- **Existing unit tests**: 18 still pass; 2 new tests cover the
  v1.2.18 prompt additions (conversational rules + 5-min window).

## 5. Rollback cost

Trivial. Prompt content is the only meaningful change. `git revert`
restores v1.2.17 prompt + the redundant pre-spawn lines.

## 6. Backwards compatibility / drift surface

Fully backwards-compatible.

- Codex-runtime users with Playwright reachable: get a much better
  conversational experience.
- Codex-runtime users without Playwright: same fallback to
  PLAYWRIGHT_UNAVAILABLE → manual flow.
- Claude-runtime users: zero change.
- Drift surface: the prompt's wording itself. If a future PR
  weakens the conversational-rules section (or removes the
  5-minute window), v1.2.18's tests will fail.

## 7. Authorization / Trust posture

No change. Same Codex spawn flags, same Playwright access, same
sandbox bypass posture.

## Outcome

Ship. Restores the user-facing experience for the Codex agentic
path to match the Claude wizard's quality. Prompt content is the
right place to fix this — confirmed by Justin's pushback against
scaffolding from instar ("why cant the codex agent know to stop
just like the claude code agent does?").
