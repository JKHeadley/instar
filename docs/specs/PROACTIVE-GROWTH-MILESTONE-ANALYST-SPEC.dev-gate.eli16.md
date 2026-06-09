# ELI16 — GrowthMilestoneAnalyst should be LIVE on dev agents, dark on the fleet

## What this change is, in plain English

The GrowthMilestoneAnalyst is the "proactive growth analyst" — the thing that
reads our own tracking systems (which features are maturing, which initiatives are
stalling, how often you approve vs. change a spec, how often you correct me) and
turns them into one digest with clear notify rules. It shipped in PR #1001.

When it shipped, I said it "ships dark" (off by default). Justin asked the right
question: *dark for the fleet is correct, but a development agent like Echo should
NOT be dark — Echo is the place we dogfood new features before the fleet gets them.*

He was right, and my first version got it wrong. I had hardcoded the feature to
`enabled: false` for **everyone**, including Echo. This change fixes that.

## What already exists

Instar already has a well-worn pattern for exactly this, used by several features
(secret-sync, boot self-knowledge, the resource sampler, warm-session A2A). It's
called the "developmentAgent dark-feature gate." The trick is simple: a feature
does NOT write `enabled: false` into its defaults. It leaves `enabled` blank, and
at startup the server computes `enabled ?? !!developmentAgent`. Read that as: "use
the operator's explicit setting if they gave one; otherwise turn it ON for a
development agent and OFF for everyone else." Echo's config already carries
`developmentAgent: true`, so the moment a feature uses this gate, Echo runs it live.

## What's new here

Three small, surgical edits:
1. Remove the hardcoded `enabled: false` from the growth-analyst config default so
   the blank lets the gate decide.
2. Change the server's startup check from "construct only if `enabled === true`" to
   "construct if `enabled ?? !!developmentAgent`" — and pass that resolved answer
   into the analyst's settings so `GET /growth/status` honestly reports `enabled:
   true` on a dev agent (otherwise it would say `false` while the routes were live).
3. Add tests proving all of this: the default omits `enabled`; the gate turns it on
   for a dev agent and off for the fleet; an explicit operator setting still wins
   both ways; and the server source actually wires the gate.

## The safeguards, in plain terms

- An operator can still force it off on a dev agent by explicitly setting
  `enabled: false` — explicit always beats the gate.
- The fleet stays dark. Nothing changes for production agents.
- The analyst is read-only: it computes and serves a digest; it never blocks a
  message or an action. This change only decides whether it runs, not what it's
  allowed to do.
- Rollback is trivial: flip the config flag and restart, or revert the commit.
  There is no data migration and no state to repair.

## What you actually need to decide

Just whether you agree dev agents should run this live (you already said yes). If
so, merge the updated PR; on Echo's next server restart, `/growth/*` goes live and
the fleet stays dark. The next slice — the analyst actually messaging you on a
schedule — remains separate and unchanged by this fix.
