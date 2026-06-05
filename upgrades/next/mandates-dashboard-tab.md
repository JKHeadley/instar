<!-- bump: patch -->

## What Changed

Added a Mandates tab to the dashboard — the operator's surface for the coordination
permission slips. It lists every issued mandate with live authorship verification and
state, provides PIN-gated forms to issue a new mandate or revoke an existing one, and
shows the tamper-evident decision audit with its chain status. The PIN is typed at
action time, sent once, and cleared immediately — it is never stored anywhere in the
browser. Also backfilled the agent-awareness sections for the three coordination
surfaces into existing agents' instruction files on update, so agents updated in
place learn these capabilities exist (previously only freshly-initialized agents got
them).

## What to Tell Your User

Your dashboard now has a Mandates tab where you manage the permission slips for
autonomous agent-to-agent work: see every slip and whether its authorship still
verifies, issue a new one with your PIN, tear one up with your PIN, and read the
tamper-evident log of every allowed and denied action under them. Your PIN is asked
for right when you act and is never remembered by the page.

## Summary of New Capabilities

- See all coordination mandates with live authorship-verification badges and
  active/revoked/expired state at a glance.
- Issue a mandate from a form (pre-filled with the standard two-authority shape) —
  PIN required, typed at issuance, never stored.
- Revoke any active mandate inline with a reason — PIN required.
- Read the hash-chained decision audit; a broken chain is flagged loudly as possible
  tampering.
- Existing agents now learn the mandate, review-exchange, and cutover-readiness
  surfaces via the update path, not just fresh installs.
