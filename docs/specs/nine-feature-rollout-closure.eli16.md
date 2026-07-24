# Nine-feature rollout closure — ELI16

Nine recent pull requests need to appear honestly in Instar’s feature-maturation
view. They are not nine identical features. Five have their own real switches and
can move through test-agent, development-agent, and fleet rollout stages. Three are
smaller parts deliberately built into systems that already own the switch and the
decision. One supplied documentation only.

This change teaches the existing registry those three shapes. The five independent
features are “active.” The three built-in pieces are “composed”: they name the system
that owns them and carry their own measurable success rule, but they do not receive
a fake switch or a separate rollout rung. The documentation-only pull request is
“excluded,” with a plain reason, so it is counted without pretending prose is runtime
behavior.

Measurements stay in the D7 maturation ledger that already exists. D7 reads bounded
numbers from the real feature owners—for example completed drain runs, admitted claim
checks, successful context recoveries, Slack considered acknowledgments, and mutually
ready SSH peers. It copies only a number and sample count into its existing evidence
table. It cannot change the feature, promote it, send a notice, or create another
source of truth. If a reader is unavailable, throws, is stale, or has too few samples,
the feature does not pass. There is no made-up green result.

The visible result is a complete nine-row accounting: five active, three composed,
and one excluded. Active rows show a real rung derived from their existing switch.
Composed and excluded rows always show no rung. The old database is migrated without
discarding its history, older peers may omit the new fields, and legacy rollout
records continue to behave as before. This closes the bookkeeping gap while keeping
the control model exactly as the shipped components designed it.
