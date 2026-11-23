# Side-Effects Review — Clearer Ideas Review

Tier1: narrow reversible presentation change. No authority or persistent state is added.

## Summary of the change

ideas.js wraps the existing unranked band in a counted native details element. All cards and actions stay intact. console.css supplies a44px readable summary. An open disclosure uses the existing interaction hold so automatic refresh preserves reading position.

## Decision-point inventory

Adds presentation branching on the server's explicit unranked band only. No review verdict, action eligibility, PIN, plan or commit decision changes.

## 1. Over-block

No block/allow surface. All unranked suggestions remain reachable through one keyboard-accessible disclosure. Other bands remain visible as before. Empty groups still do not render.

## 2. Under-block

No security boundary is added or weakened. Text remains rendered with el() text nodes. Buttons retain the existing server-worded plan, PIN and commit flow. Opening does not decide anything or send a request.

## 3. Level-of-abstraction fit

The view uses the existing ideasInBand result and native details rather than changing source classification or adding an API. This is presentation hierarchy, not a second review controller.

## 4. Signal vs authority compliance

No block/allow surface. The server band is a display input. No brittle text detector gains authority. See docs/signal-vs-authority.md.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The explicit enum selects a disclosure; no competing work or risk signals are adjudicated. Every action keeps its existing authority path.

## 5. Interactions

Shadowing: actionable groups precede the unchanged unranked group. Double-fire: native opening sends no request. Races: toggle mirrors open state into data-interaction-open, retaining the existing refresh hold until closed. An explicit owner decision can still trigger its existing refresh. Feedback loops: none; classification and source reads are unchanged.

## 6. External surfaces

Only the Ideas view changes. No new routes, configurations, schemas, notices or external operations. No new agent capability or migration is needed; normal dashboard asset delivery updates existing installs. The phone-completable decision controls remain inside the disclosure and use the existing PIN path.

## 6b. Operator-surface quality

1. Leads with the primary action: ready-to-act and worth-planning suggestions remain expanded; unfinished review material cannot bury the project list.
2. Zero raw internals as primary content: the summary uses the plain band label and count. Existing text-node rendering remains safe.
3. Destructive actions de-emphasized: no destructive action is added or moved above the constructive primary action. Existing Start a spec, Decline and Later controls remain unchanged.
4. Plain language and phone width: “Not ranked” matches the existing label, count shows what is available, and the native summary has a44px target. Four actual Chrome390/1280 light/dark cases passed:44px summary, no overflow,150cards/450actions retained, keyboard opening and refresh hold; the projects section remains within1200px of the top.

## 7. Multi-machine posture

Pool-merged through the existing /ecosystem-ideas?scope=pool read. This is a local ephemeral display state over the pooled answer; it neither creates duplicate suggestions nor holds durable state. No notices or URLs are introduced. No status, health, capabilities or channels response changes.

## 8. Rollback cost

Revert the renderer and CSS in a patch release. All unranked cards become expanded again. No stored verdict, migration or owner state repair is involved.

## Conclusion

This reduces the initial reading burden without removing evidence or changing who can act. Independent SMALL review concurred;158 focused unit/first-screen checks and four browser cases passed. Complete verification and release remain separate gates.

## Second-pass review

Not required for Tier1. One independent SMALL reviewer concurred with no material gaps.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable. No self-triggered controller was added or modified.
