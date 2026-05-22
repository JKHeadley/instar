# Convergence Report — Wizard audit bundle v1.2.20

## ELI10 Overview

After v1.2.19 closed the three Telegram-setup blockers (privacy
off, Forum mode, system topics + intros), Justin asked for a
comprehensive audit instead of more whack-a-mole. The audit
catalogued 14 findings; he approved 10 for this PR.

The 10 changes bring the Codex agentic Telegram path to parity
with the Claude wizard on identity, the "agent comes alive"
moment, admin permissions, security hygiene, and a handful of
polish items. The 4 remaining items (bot/group images, bot
commands menu, browser-close polish) defer pending separate
decisions.

## Iteration Summary

| Iteration | Reviewers who flagged | Material findings | Spec changes |
|-----------|-----------------------|-------------------|--------------|
| 1         | research subagent audit + Justin's review | 10 (approved scope) | implementation per audit recommendations |
| 2         | (converged)           | 0                 | none |

## Full Findings Catalog (in priority order)

**High (5):**

1. D2/G1 — agentName piped into the prompt + used as BotFather
   display name. Resolved: new TelegramAgenticContext param,
   dispatch passes answers, prompt references context.

2. C1 — Richer Lifeline orientation message in agent's voice.
   Resolved: rewrote step 14a to address user by name + teach
   topic mechanics + invite topic creation.

3. C2/D1 — Post-server "magic moment" agent greeting.
   Resolved: state-machine send-greeting wired to new
   runSendLifelineGreeting helper that reads config and POSTs
   sendMessage with lifelineTopicId.

4. A1 — Bot admin promotion via Playwright. Resolved: new step
   12b drives Telegram Web's Add Administrator flow + Bot API
   verification.

5. F1 — Token redaction rule. Resolved: new "CRITICAL
   CREDENTIAL HYGIENE" section in prompt preamble.

**Medium (5):**

6. A2 — /setdescription. Resolved: new step 9b.
7. A3 — /setabouttext. Resolved: new step 9c.
8. B3 — Pin Lifeline orientation message. Resolved: new step
   14b.
9. F2 — chmod 0600 on config.json. Resolved: new step 15b.
10. G5 — Two-call getUpdates flush pattern. Resolved: step 12
    revised to drain backlog first.

**Deferred (4):**

- A4 (bot userpic), B2 (group photo): need image-source
  decision.
- A5 (/setcommands): needs instar-wide command vocabulary
  decision.
- G2 (browser-close): polish; bundle with next Playwright
  touch-up.

## Convergence verdict

Converged at iteration 2. 10 scoped additions inside one file
plus one helper plus one state-machine wiring. 81 wizard tests
pass; 11 new tests cover v1.2.20 additions. lint + tsc clean.
Spec ready.
