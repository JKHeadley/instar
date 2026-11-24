# Review record for the packaged doorway scan migration

## Cross-model review: codex-cli:gpt-6.2-astra

Independent Codex CLI reviews and internal security, adversarial, integration, performance, decision and lessons perspectives reviewed this slice. Gemini was unavailable because its installed login was unauthenticated.

## ELI10 Overview

The scheduled doorway check is intended to work from an installed Instar package. The migration keeps existing on and off choices and their schedules. A packaged reader can show what was actually checked, what is stale, and when an install has no observations. The existing change notification path keeps custody of its pending messages.

## Original vs Converged

The draft separated a scheduled observation from the baseline used to deliver manual notices. Review added a common lock for the legacy shared file, durable recipient acceptance lookup, preservation of last actual observations over failed runs, and a package-backed verification gate for replacing the delivery path of existing enabled jobs.

## Iteration Summary

| Round | Standards-Conformance Gate | Material changes |
| --- | --- | --- |
| 1 | Ran, 3 flags across 102 standards | Defined signed package custody, concurrent writers, failed and partial observations, and legacy enabled delivery handoff. |
| 2 | Ran, 2 flags across 102 standards | Added durable recipient acceptance, last-observed retention, shared legacy fencing, and separate execution-profile graduation. |
| 3 | Ran, 3 flags across 102 standards | Closed stale-caller admission, distinguished uncertain acceptance from definitive refusal, and defined tied observation ordering. |
| 4 | Ran, 2 flags across 102 standards | Added durable scheduler attempt accounting, custom cadence freshness, legacy notice ownership and automatic promotion evidence. |
| 5 | Ran, 2 flags across 102 standards | Kept prior committed evidence across an interrupted write and defined the first scheduled baseline from acknowledged legacy state. |
| 6 | Ran, 2 flags across 102 standards | Separated run failure from individual doorway starts and required reverse handoff of the acknowledged baseline and pending notices before rollback. |

## Experience fit

An upgrade preserves existing choices, including an old disable without a recorded reason. A new install without live observations can still read the reviewed catalog. It can see when the reachability check last ran and whether an apparent result is historical. The standing doorway standard calls for a recurring dark-by-default scan. As a result, installed reachability is unknown until an operator enables a schedule or runs a probe.

## Proportion

Tier 2 design review at the six-round cap. Four frontloaded decisions, zero unresolved operator questions, and zero cheap-to-change tags.

## Full Findings Catalog

- **Trust and integration.** Signed package assets remain authoritative. The canonical state directory owns the kill switch. Only explicitly verified scheduled inputs can bind a scan to a durable run.
- **State and freshness.** Report the latest attempted run separately from per-door attempts and historical observations. The ledger retains the last committed evidence across a partial write. Cadence and timeout establish historical staleness.
- **Delivery.** Restrict writer admission before cutover or rollback and reconcile baselines and notices under one fence. Acknowledgment, terminal non-acceptance or keyed deduplication is needed before any retry of uncertain delivery.
- **Maturation and scope.** The execution profile has a ladder. Authorized job activation remains dark by default under the standing registry rule. The review distinguishes catalog age from reachability evidence.

## Left behind

Fresh dark installs lack recurring reachability observations until authorized activation. The projection labels that state explicitly. The freshness lint independently checks the reviewed catalog. The production package, scheduler and delivery evidence remain implementation acceptance criteria.

## Convergence verdict

The scoped design closes at the cap after addressing the final external findings. The specification defines what must be demonstrated by implementation tests and field evidence. No runtime behavior changed.
