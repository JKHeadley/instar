# Side-effects review: exact project-binding batch model

**Tier:** 1 for this small, reversible foundation slice. This commit adds an unused data validator, canonical hash helper, disclosure renderer, documentation, and unit tests. It does not send a request, accept an owner tap, write a project, or move a conversation. The complete approval feature remains in progress.

## 1. Over-block

The draft validator refuses duplicate child conversations, malformed conversation keys, invalid source fingerprints, empty goals/checklists, and batches larger than 32 items. Those are deliberate limits for a reviewable exact batch. It does not yet verify that the source, parent, audience, or conversation graph is current; future callers must do those checks before displaying or applying a draft.

## 2. Under-block

This helper alone cannot authenticate an owner, resolve source messages, prove Work Board provenance, preserve access audiences, serialize writes, or prevent replay. It is not wired into a route or callback. Nothing may treat its hash as owner authorization.

## 3. Level of abstraction

This belongs in a pure core module: shape validation and canonical disclosure are deterministic and have no I/O. The existing Chief of Staff journal, conversation graph owner-change path, and authenticated callback remain the authorities for later wiring.

## 4. Signal versus authority

The helper is a deterministic signal and display function only. It cannot grant authority or perform an action. This follows [Signal versus Authority](../../docs/signal-vs-authority.md): the authenticated owner callback and existing write authorities must make the decision.

## 5. Interactions

No runtime behavior changes in this commit. The future feature must preserve the single-project dashboard PIN route and use the current Chief of Staff and graph stores rather than shadowing their ownership rules.

## 6. External surfaces

No external messages or persistent state are changed. The renderer is not yet called. When integrated, full private disclosure, message-size handling, and current owner identity must be verified before an approval surface is sent.

## 7. Multi-machine posture

This module is machine-independent pure code and stores nothing. Future pending asks and project bindings must use the replicated Chief of Staff journal; callback receiver details must be checked against the currently admitted receiver, not a cached copy.

## 8. Rollback cost

Revert the code and tests. There is no runtime state to migrate and no user-visible effect because the helper is not wired.

## Conclusion

The focused tests and TypeScript build pass. This is a safe foundation only; the owner approval path, durable ask state, parent-placement authority, release fragment, and lifecycle coverage remain outstanding.

## Class-Closure Declaration

No agent-authored-artifact defect — not applicable.

## Evidence pointers

- `tests/unit/chief-of-staff-binding-batch.test.ts` — 5 passing focused unit tests.
- `pnpm build` — completed successfully.
