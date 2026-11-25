# Use the Codex allowance that expires first

Each Codex account has a separate weekly allowance and reset date. Unused allowance disappears at reset. The account that resets next should therefore take suitable new work while accounts with later resets remain available for later work.

Ongoing conversations were skipping the account picker. On the Studio that meant they all inherited the default Codex login, dawn, even though its allowance resets last. Background work used another picker that favored the least-used account without considering its weekly deadline. This repair connects ongoing conversations to their existing Codex picker and gives the shared selectors the same weekly-reset priority. Existing checks for account availability and quota headroom remain in place.

The launch uses the selected account's actual folder and records the matching account name. When reopening a saved conversation under that account, its saved conversation follows it. If that move or the resumed startup fails, the failure is reported and the saved conversation and pending message remain available for recovery; the system does not quietly replace it with an empty conversation.

This is a narrow routing repair. It does not restart active conversations on a timer, force busy sessions to move, change a model, overwrite credentials, or remove the existing quota thresholds. Explicit account choices and local models keep their current behavior. Existing conversations receive the corrected selection when they next launch through their normal lifecycle. The change must pass normal full verification and release before any installed agent is said to use it.
