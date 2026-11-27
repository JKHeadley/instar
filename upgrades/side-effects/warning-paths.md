# Side effects: every console warning has a checked path

1. Over-block: the floor can refuse a harmless new `tone: 'attn'` line until it carries a comment. That is its job; the fix is one line.
2. Under-block: the check can't prove a row's sheet helps. It proves the mechanism exists, not its quality. Warnings using other words than `attn` or `bad` are not seen. A warning rendered with a literal class name is not seen.
3. Level fit: a test floor beside the existing first-screen floor, which covers "needs you" items and stays as it is.
4. Signal vs authority: a development-time test. Nothing at runtime is gated. The iMessage state is display only.
5. Interactions: `pageHead` gains a link on warning pages; the first-screen floor still passes. iMessage down now keeps a row on Home and on the Fleet until it's fixed, or iMessage is switched off, so an agent with iMessage enabled and never working (Echo on Studio today) reads Degraded steadily. That is true, and the fix or the off switch ends it.
6. External surfaces: none new. One new `app` screen name; older apps show no button for a name they don't know.
6b. Operator-surface quality: 1) warnings lead with their action or the ask link. 2) raw reporter text is out of titles and stays in the details. 3) no destructive action added. 4) plain words; link height is usable at phone width.
7. Multi-machine posture: machine-local, like `/health`. iMessage state is this machine's adapter.
8. Rollback: revert the commit. Nothing durable.

## Second-pass review

**Reviewer:** none outside on this change. Self re-read, plus the checked claims: the floor found three false path claims on the app side while it was being written, which is the evidence it works.

## Agent Proposes, Operator Approves

`mandates-model.js` and `mandates.js` change only by comments, plus the shared page-head link. Nothing about approving changes: the operator still (1) approves a pre-filled request rather than constructing one, and (2) reads an authority statement the server authored from structured data, not agent free-text. The ask link only opens a chat with a question in the box; it grants nothing and approves nothing.
