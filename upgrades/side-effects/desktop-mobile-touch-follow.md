# Mobile remote desktop touch and zoom: side effects

## Summary

Tier 1: browser-only viewer change (2 dashboard assets, 1 unit test, 1 browser smoke script, docs), about 130 changed lines. Effort: no spec rounds, one commit attempt. A phone tap clicks the touched point, a double tap reaches the remote machine as two clicks instead of iPhone text selection, and a zoomed view follows the pointer at its edges.

## Over-block

The live viewer prevents native text selection and browser touch gestures over its controls. The remote typing field remains selectable and editable. Browser address bars and system gestures remain outside Instar's control.

## Under-block

Every short touch on the remote surface sends a remote click at that point. Two quick touches send two clicks. A finger drag near the edge of a zoomed view pans repeatedly until released, cancelled, stopped, or a boundary is reached. The target still enforces the active grant and input sequence.

## Level of abstraction

Only browser input mapping and local zoom pan change. Admission, PIN, signed target grant, stream encryption, controller lock, target input checks, and Stop remain in their existing production path.

## Signal versus authority

Touch distance and edge proximity are local gesture signals, not authority to control the host. `inputEnabled` and the target grant remain the input authorities. The browser cancels edge animation when access ends; the target independently rejects post-Stop commands.

## Interactions

Direct mode is now the default on phones. Trackpad remains in the controls menu. A two-finger gesture still zooms or scrolls as before. Cursor follow shifts a zoomed view only enough to keep the cursor within a visible margin. Direct drag at a visible edge continues shifting the view, and releasing the finger stops that motion. The on-screen keyboard remains usable.

## 6b. Operator-surface quality

(1) The live viewer leads with the remote screen itself; a tap acts on it directly, and the controls stay in the small dock. (2) No raw internals are shown; only the machine name, a short status line and Stop. (3) Stop stays in its existing place and colour; this change adds no new destructive action, and Trackpad mode moved behind the control menu rather than being the default. (4) The phone layout fills the screen at phone width, and the status text is plain language.

## External surfaces

The same dashboard URL and PIN are used. There are no new ports, credentials, prompts, or host permissions.

## Multi-machine posture

The browser behavior applies to every mesh machine whose desktop card is already ready. It does not enable any unverified machine.

## Rollback cost

Reverting the viewer assets restores the prior touch mapping and zoom behavior. There is no persistent state or schema migration.

## Class-Closure Declaration

`defectClass: interaction-mismatch`, `closure: guard`, `guardEvidence: { enforcementType: browser-and-unit-test, citation: dashboard/desktop.js + tests/unit/desktop-touch-gestures.test.ts + scripts/desktop-public-browser-smoke.mjs, howCaught: a real iPhone screenshot showed selection handles on Stop and user feedback showed touches not clicking the intended remote point; focused tests assert two remote click actions, zoom edge movement, and browser touch policy }`.
