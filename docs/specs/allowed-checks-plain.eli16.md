# "What I'm allowed to do": safety checks that add up and read plainly

## What this is

The dashboard's "What I'm allowed to do" page lists the agent's safety checks, and the ones that need a look sit at the top. The 20 November live check of the dashboard (part of the "finish the dashboard makeover" project: low clutter, clear "needs you" items, names instead of IDs) found three problems on this page.

## What changes

- **The counts now agree.** The summary chip said "40 checks need a look", but the list under it said 42. That list mixed in two machines that didn't answer, and those aren't checks. Those machines now get their own short list, "Machines I couldn't check", so the list of checks counts exactly the checks.
- **Unanswered machines are named.** Those machines showed as "Another machine". They are now named from the pool's machine list (for example "M5 Pro", "Laptop") whenever the pool knows them.
- **Setting names read as words.** A check named after a setting showed a clumsy split of the code name, like "Models tier Escalation dry Run" or "Green Pr Auto Merge". These now read "Model tier escalation dry run" and "Green PR auto merge", keeping common short forms (PR, CI, LLM, API) in capitals.
- **Row titles drop internal incident tags.** A check described as "host CPU protection — the multi-actor test-suite storm (2026-07-02 load-stall kill cascade)" now shows without the dated tag in the list. The full description is still shown when you open the check.

## What is not affected

Which checks need a look, what each one protects and every action on this page are unchanged. This is wording and grouping only, checked on the live page before committing.

## What you need to decide

Nothing. A revert restores the old wording.
