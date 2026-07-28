# ELI16 — Operator-Surface Quality standard + Mandates-tab redesign

## What this is, in one breath

Two cohesive changes born from one moment: on 2026-06-12 the operator opened the
brand-new Mandates grant form on his phone and called it "absolutely abysmal."
The form *worked* on mobile — it just wasn't any good. So we (1) redesigned that
surface to be genuinely usable, and (2) wrote a constitutional standard —
**Operator-Surface Quality** — so "reachable but bad" can never quietly ship again,
backed by a real pre-commit gate, not just prose.

## What already existed

- The **Mandates tab** (dashboard) lets the operator issue, grant, revoke, and
  audit "permission slips" that authorize bounded agent-to-agent work, all
  PIN-gated. It shipped earlier the same day under the **Mobile-Complete Operator
  Actions** standard, which guarantees an operator can *reach and complete* any
  action from a phone.
- Mobile-Complete measures **reachability**. Nothing measured whether the surface
  was actually *good* once you got there — so a grant form passed every gate while
  being unusable: the primary action (Grant) was collapsed behind a toggle, the
  destructive action (Revoke) sat open above it, and the card dumped raw JSON,
  agent fingerprints, and internal slugs as its headline content.

## What's new

1. **The Mandates card is redesigned.** The Grant form is now the card's primary,
   always-open block. Revoke is demoted to a quiet, collapsed control below it.
   Raw JSON bounds, fingerprints, and scope slugs are replaced with one plain
   sentence ("Lets two agents exchange a read-only credential and co-sign a code
   review. Expires …"); the ids/fingerprints survive only on a muted "For support"
   line. Existing grants read in plain English ("Adam Admin can deploy to
   production until … — authorized by you"). The decision-audit table stacks into
   labelled rows on a phone instead of truncating the reason column.
2. **A new constitutional standard, Operator-Surface Quality**, lands in the
   standards registry as a sibling to Mobile-Complete. It requires every operator
   surface to lead with its primary action, expose zero raw internals, de-emphasize
   destructive actions, read in plain language, and work at phone width.
3. **A real enforcement gate.** The instar-dev side-effects review template gains
   an operator-surface-quality question (§6b), and the pre-commit gate blocks any
   commit that touches an operator surface (dashboard files, approval pages, grant/
   secret forms) unless the review answers that question in writing. The standard
   names this gate, so the Standards-Enforcement-Coverage audit classifies it as an
   enforced *gate*, not documented-only.

## The safeguards, in plain terms

- The gate is **scoped**: it only fires when a commit actually touches an operator
  surface, so normal commits pay nothing.
- It is **self-teaching**: if the section is missing, the block message tells the
  agent exactly what to add and where — so no developer is left guessing.
- The redesign is **renderer + markup + CSS only** — no server, security, or
  data-model change. Rollback is a pure revert.

## What a reader actually needs to decide

Nothing is irreversible here. The only judgment calls are aesthetic/standards
ones the operator already approved: that UI/UX quality is worth a constitutional
standard, and that the gate should fire at the side-effects-review layer. Both
were ratified directly (topic 22367, CMT-1434).
