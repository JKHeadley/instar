# Side-effect review — green-PR namespace visibility

## Changed boundary

The watcher branch namespace is now resolved from
`monitoring.greenPrAutoMerge.agentNamespace`, with the historical project-name
and `agent` fallbacks preserved. Authorship remains established by the existing
GitHub `--author @me` list query; the namespace is explicitly an ownership
scope, not an identity proxy.

## Expected effects

- An enabled watcher with an empty expected GitHub login refuses startup and
  records the exact configuration issue.
- A non-empty authored PR list with zero namespace matches produces a live
  `namespaceMismatch` status episode, a transition audit, one aggregate
  attention line, and the `namespace-mismatch` tick result.
- The episode clears as soon as the authored list is empty or any authored PR
  uses the configured prefix; recovery is audited.

## Authority and notification behavior

- No configuration default enables auto-merge.
- The PIN-gated re-arm path and all safe-merge, lease, latch, identity, hold,
  protected-path, and CI gates are unchanged.
- The mismatch path is signal-only and can never merge, close, label, or edit a
  PR. Aggregate attention is deduplicated by mismatch fingerprint.
- Existing installs with no explicit prefix keep their project-name behavior.

## Class-closure declaration

This is an unknown-classification/fail-open observability instance: a populated
input set collapsed into the same `no-candidate` output as an empty input set.
The watcher test now exercises both sides and the status route exposes the live
configuration and mismatch state.
