# Agent Autonomy Principles documented (false blockers + decision frontloading)

## What Changed

Added `docs/AGENT-AUTONOMY-PRINCIPLES.md` — a verbatim capture of the operator's two
foundational principles for how Instar agents should operate: (1) almost all "blockers" are
false blockers — judgment calls to work through an authority → access → dry-run → codify
pipeline rather than walls; (2) the spec-design process should frontload every user decision
so the agent completes the spec in a SINGLE autonomous run, and mid-run decisions are
cheap-to-change-after rather than stop-and-wait. No runtime code changed; this is the source
document for an in-progress exploration of integrating these into Instar fundamentals
(hooks, skills, and possibly new Constitutional standards).

## What to Tell Your User

Nothing changes in how the agent runs today. This records, word-for-word, two operating
principles the operator laid out — so future work (and any new constitutional standards
derived from them) traces back to a single durable source instead of living only in a chat
log.

## Summary of New Capabilities

- A new reference doc: the verbatim, citable source of the false-blocker pipeline and the
  decision-frontloading principle.

## Evidence

- New doc only; no source change. The two principles are quoted verbatim with the operator's
  attribution, date, and topic, followed by a clearly-labeled derivation (the quote governs).
