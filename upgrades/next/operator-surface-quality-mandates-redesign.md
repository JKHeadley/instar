<!-- bump: minor -->

## What Changed

Two cohesive changes (topic 22367, CMT-1434):

1. **Mandates dashboard tab redesign.** The Mandates card now leads with the Grant
   form as its primary, always-open block; Revoke is demoted to a quiet, collapsed
   control beneath it. Raw JSON bounds, agent fingerprints, and scope slugs are
   replaced with a plain-language summary sentence; identifiers survive only on a
   muted "For support" line. Existing grants read as plain English ("Adam Admin can
   deploy to production until 9:37 PM — authorized by you"), and the decision-audit
   table stacks into labelled rows at phone width so the reason column is never
   truncated. Renderer + markup + CSS only — the mandate API, payloads, and
   PIN-never-retained discipline are unchanged. Ships via `dashboard/` static
   serving, so it reaches every agent through the normal update path.

2. **New constitutional standard: Operator-Surface Quality** (sibling to
   Mobile-Complete Operator Actions) in `docs/STANDARDS-REGISTRY.md`. Where
   Mobile-Complete asks "can the operator do this from a phone?", this asks "is it
   actually good when they do?" — lead with the primary action, zero raw internals,
   de-emphasized destructive actions, plain language, phone-width layout. It lands
   with teeth: a new operator-surface-quality question in the instar-dev
   side-effects review template, and a pre-commit gate
   (`scripts/instar-dev-precommit.js`) that blocks any commit touching an operator
   surface unless the review answers it. The standard names that gate, so the
   Standards-Enforcement-Coverage audit classifies it as an enforced gate.

## What to Tell Your User

- **A cleaner Mandates screen on your phone**: "I gave the Mandates tab a real
  overhaul. The action you actually came to do — granting someone permission — is
  now front and centre, the risky Revoke button is tucked quietly out of the way,
  and the screen reads in plain English instead of raw data. The history list also
  finally fits your phone without cutting off the reason column."
- **A new quality bar for everything you touch**: "I also turned this into a
  standing rule for myself: any screen you use to approve or decide something has to
  be genuinely good to use on your phone, not just technically reachable. I added an
  automatic check that holds me to it whenever I build one of those screens."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Redesigned Mandates tab (humanized, mobile-first) | Open the Mandates tab in the dashboard |
| Operator-Surface Quality standard | docs/STANDARDS-REGISTRY.md (constitution) |
| Operator-surface-quality pre-commit gate | automatic during instar-dev work |
