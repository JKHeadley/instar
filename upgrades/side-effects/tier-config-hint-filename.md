# Side-effects review — tier classifier no longer treats a .config FILENAME as a config surface

**Change:** removes the `\.config\b` alternative from `CONFIG_SURFACE_HINT` in
`scripts/lib/classify-tier.mjs`. That alternative matched a filename REFERENCE, so a diff that merely
read `*.config.ts` satisfied the config-surface gate and, combined with any object literal, raised the
risk floor for "new config key added".

**Decision point touched?** Yes — the risk floor of the instar-dev tier gate. This LOWERS the floor in
one specific false-positive case, so it is a loosening and reviewed as such.

---

## 1. Over-block

This change exists to remove one. The over-block was concrete: a read-only developer script that adds
no config key had its floor raised to 2 purely for naming `vitest.push.config.ts`.

## 2. Under-block

The real risk of the change, stated plainly: narrowing a heuristic can blind it. If a genuine
config-key addition mentions ONLY a `*.config.ts` filename and none of the remaining anchors
(`ConfigDefaults`, `config.json`, `defaultConfig`, `InstarConfig`, `configSchema`), its floor will no
longer rise.

Bounded two ways. The remaining anchors cover the actual config surfaces in this repo — a diff adding
a real key names the module, the file, or the type. And a test now iterates EVERY remaining anchor and
asserts the floor still rises, so a future narrowing that blinds the check fails.

Residual: this is a heuristic over diff text and always was. It deters accidental omission; it is not
a boundary against a determined author. Unchanged by this.

## 3. Level-of-abstraction fit

Correct — the defect is in the hint regex and the fix is in the hint regex. A broader alternative
(requiring the anchor on the SAME line as the key) was considered and rejected as a larger behavioural
change than the evidence supports: one bad alternative was identified precisely, so one alternative is
removed.

## 4. Signal vs authority compliance

The classifier is a SIGNAL that informs a declared tier; the agent holds the authority and the
declaration is audited. This change makes the signal more accurate without altering who decides. Per
`docs/signal-vs-authority.md` that is the intended direction.

## 5. Interactions

`CONFIG_SURFACE_HINT` is used only to gate the `key: value` pattern inside the new-capability check.
No other risk signal is affected; the `export class` and router patterns are untouched. All 47
pre-existing classifier tests pass unchanged, plus 2 new ones.

Changes to this file alter tier decisions for FUTURE commits only. Nothing recorded in past decision
audits is rewritten.

## 6. External surfaces

None. Development-time classifier; no endpoint, no config key, no runtime behaviour, not user-facing.

## 7. Multi-machine posture

Not applicable: a pure function over diff text, identical on every checkout, with no state, no
persistence, and nothing to replicate or reconcile.

## 8. Rollback cost

Trivial — restore the alternative. The regression test would then fail, which is the correct signal
that the rollback reintroduces the false positive rather than a silent revert.

## Disclosure

I hit this false positive myself and declared Tier 1 under the raised floor without reading it first.
That declaration and its deliberate re-declaration are both in the decision audit. This change fixes
the classifier; it does not excuse the declaration.
