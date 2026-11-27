# Side-effects review for pre-push main reference selection

Version slug is prepush-main-reference-alias. Author is Echo. This Tier 1 change updates the main reference selection in one local push script and adds four real Git-history tests. All 23 focused checks passed.

## Decision and scope

The gate already uses a three-dot merge-base diff. Two remote aliases can share a URL while their tracked main commits differ. Git ancestry decides when another alias advances the preferred reference. Fully qualified remote-tracking refs keep local branches and tags out of that selection. The existing alias order still applies to separate remotes, older refs, divergent refs and clones with one usable ref.

## Over-block and under-block

Main's inherited release fragments leave the branch diff when an alias for the same remote points to a newer descendant. The fixture verifies that a branch-authored internal-only note still triggers the existing runtime-change refusal, including when a local branch shadows the remote alias. When all aliases are stale, the operator still needs to fetch main. Identical URLs and ancestry are both required to advance the selected ref.

## Signal and authority

The code changes the checked reference through source history. The release-fragment rule owns the existing decision, and the patch adds no authority or competing judgment point. [Signal and authority standard](../../docs/signal-vs-authority.md)

## Interactions and rollback

File and fragment checks use the same selected ref. The release-cut recognition uses that ref too. No network fetch, Git ref write, repository setting change, or agent state mutation is added. Local clones decide using their existing refs. Exact Git ref lookup pins the commit used for comparison. The upstream fallback also requires an exact full ref, and the existing parent diff remains the last fallback. Reverting the script restores the longstanding ref order with no migration or data repair.

## Second-pass review

**Second-pass reviewer:** Recovery Review

Reviewer is Recovery Review. Concur with the review. Exact ref lookup rejects local branch lookalikes, and the gate carries the resolved commit through ancestry checks, both diffs, and release-cut recognition. Alias advancement requires a matching remote URL and descendant history. Clones without an exact main or upstream ref retain the existing parent comparison.
