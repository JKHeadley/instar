# Side effects: skill learning admits only the owner's own topics (SEC-109)

## What changes for running agents
- An agent with a configured owner or a verified owner: Telegram topics whose verified operator is the owner keep teaching exactly as before. Topics operated by anyone else stop feeding skill-learning observations and proposals. That is the fix.
- An agent with no owner and exactly one allowed Telegram sender: no change (that sender is the learning owner, as in SEC-105).
- An agent with no owner and several allowed senders: no Telegram topic teaches skill learning until an owner is set or verified.
- Slack rows are unchanged: they are admitted from Slack admins as `asserted`, count toward recurrence support only and never feed a draft (spec §3.1, §3.5).
- Rows admitted before this fix are not purged: a non-owner's earlier requests stay in the skill-learning ledger and can still count toward recurrence until they age out of the window (`defaultGate.windowDays`). A purge was judged not worth a migration for a dark, signal-only feature whose every new skill waits for the owner's PIN tap.
- Nothing already learned is changed or retired; existing proposals and learned skills stay as they are. Skill learning is a signal; every new skill still waits for the owner's PIN-gated tap in live mode.
- Feature state: skill learning ships dark (`monitoring.skillLearning.enabled` off by default); agents with it off see no difference.

## Signal vs authority
Skill learning observations are signals. This narrows whose words feed them. It grants nothing and gates no other action. Owner-only authority checks elsewhere are untouched.

## Not changed here
- The topic operator binding itself (`TopicOperatorStore`) and every other reader of it.
- The Human-as-Detector log, which records every user message as a metric signal.

## Rollback
Revert the commit. No stored data changes.

## Second-pass review
**Reviewer:** independent second-pass subagent (fresh context, read-only). It concurred with no blocking issues: the one production caller of `SkillLearningSentinel.create` goes through `ownerOnlyOperator`, both admission paths (live and catch-up) use it, draft and reviewer text is looked up only from admitted rows, fail-closed holds in every case, and `telegram` is constructed before the wiring in both Telegram modes. Notes taken: the uid is now returned trimmed (a padded binding failed the filter's exact match, safely but needlessly), and the unpurged pre-fix rows are documented above. Noted, out of scope: no e2e test drives the live wiring with a non-owner topic, and `Classifier.ts:390` falls back to a timestamp-only text match (pre-existing; filed for the ledger).

## Class-Closure Declaration
`unbounded-self-action`: n/a. This change only narrows which inbound Telegram rows skill learning admits (an owner check on a read). It adds no action, retry, timer or loop.
