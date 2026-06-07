# Graduate the Subscription Pool capability — Plain-English Overview

> The one-line version: the multi-account subscription feature is finished enough to be real, so I'm turning it from a hidden/internal thing into a capability I actually know about and will offer you.

## The problem in one breath

The Subscription & Auth Standard was built in pieces (registry → quota poller →
auto-swap scheduler → enrollment wizard → dashboard tab). While it was half-built,
it was deliberately kept "internal" — hidden from my list of capabilities and
absent from my own instructions — so I wouldn't brag about a feature that didn't
fully work yet. That was the honest thing to do then. Now all the pieces are
merged and tested, so keeping it hidden is the dishonest thing — it means I'd
never think to offer it to you.

## What this changes

Three small, no-behavior edits:

1. **Capability list** — `/subscription-pool` moves from the "internal, skip
   discovery" list to the surfaced capability index, so anyone (including me)
   probing what I can do now sees the whole subscription pool: the accounts, the
   live quota, the auto-swap continuity guarantee, and the enrollment wizard.
2. **My instructions for new agents** — the CLAUDE.md template gains a short
   "Subscription Pool" section so a freshly-initialized agent knows the feature
   exists and when to reach for it.
3. **My instructions for existing agents** — a migration appends that same
   section to already-installed agents on their next update (so it's not just
   new agents who learn about it).

## What this does NOT change

Nothing runs differently. No new endpoint, no new code path, no new authority.
Auto-swapping a live session stays OFF until you turn it on. The enrollment
section reminds me to drive the login wizard and never ask you to paste a token.
It's purely "make the finished thing visible and known."

## The safeguards

- **Honesty bar respected** — the feature is only surfaced now that its pieces
  (scheduler P1.3 + enrollment P2.1 + dashboard P2.2) are genuinely merged; the
  original internal note set exactly this bar.
- **Idempotent migration** — the CLAUDE.md edit only appends if the section isn't
  already there, and never touches anything you wrote.
- **Proven** — the capability-index test confirms `/subscription-pool` is claimed
  exactly once and no longer internal; the template tests stay green.
