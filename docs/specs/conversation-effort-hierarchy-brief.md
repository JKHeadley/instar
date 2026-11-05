# Conversations: product brief

**State:** reviewed design. DAWN's verified review and frontier GPT/Claude reviews are recorded. The clickable phone/desktop sample passes its interaction walkthrough. Justin approved the narrow witness-backed Pending choice on 2026-11-05. This feature is not shipped.

## What it feels like

The dashboard and app open to a quiet **Conversations** Overview: one headline, at most five named efforts or front doors, and a short cue only when a decision, conflict, or missing evidence needs attention. **All** and search reach every worker conversation. Opening a worker shows its original transcript first; **More** reveals its path, source-linked updates, why it is placed there, and correction controls. A wrong placement can be moved with a preview and undone. Pending changes explain which machine or sync step is still needed.

The production screens use the current dashboard and app components and their light/dark themes. The standalone sample uses the installed console's navy/slate/teal semantic colors as a preview; it is not a separate product style. The 320 px sample has no horizontal overflow and preserves Back to the actual prior screen.

## Telegram and Slack

**Yes, the hierarchy can be used from Telegram and Slack**, as on-demand access to Instar's shared graph. An owner can ask for an effort status or worker list and open a source conversation. Corrections use a verified owner interaction. Routine worker updates do not flood a parent chat. A group or unknown-audience chat receives only a neutral pointer to the authenticated app; private owner details stay in a verified private destination.

Telegram and Slack remain the original conversation stores and deep-link destinations. Neither bot can rearrange or hide an arbitrary user's entire sidebar. Telegram's ordinary Bot API cannot backfill full topic history, so the design labels what Instar actually observed and marks gaps. Optional client-side organization, such as a separate muted worker group or a person's Slack sections, can supplement the Instar-owned hierarchy after the core app experience works.

## Approved sleeping-machine behavior

The approved design lets the awake machine capture new sources and save owner actions as **Pending** while another installed machine sleeps. An independent witness preserves those exact items until the sleeping member catches up. Pending is never called fully committed or visible as a current view on the sleeping machine before repair. Justin approved a narrow exception to Instar's any-single-machine survivability rule for those new Pending items only; every fully acknowledged graph change, erasure tombstone, and completed answer keeps the full all-machine durability protocol. The exact scope and safeguards are in [the standards decision memo](conversation-effort-hierarchy-standard-decision.md). The installed 95-standard checker still flags the literal rule until its registry records the scoped exception; this is a known registry handoff, not evidence that the owner declined A.

## Delivery boundary

This package defines the graph, privacy and history rules, app/dashboard screens, chat behavior, recovery states, build order, and acceptance tests. Implementation still needs the real graph witness and answer gateway, production theme integration, multi-machine and authorization tests, screen-reader proof, and a pilot on real conversations before owner-facing activation.
