# Dashboard UX Standard — the plain-English version

The operator opened the dashboard on 2026-07-08 and found it hard to use: tabs squished into a narrow strip, most of the 25 tabs unreachable, and several tabs that gave no hint of what they were for. Rather than polish it once and watch it drift again, we turned the operator's bar — "everything must be VERY clearly self-explanatory, easy to navigate, and responsive" — into a written standard with hard rules (F1–F9), each backed by an automatic check that fails the build if a future change breaks it. That way the dashboard can't silently rot back into the squished, confusing state; the rules are enforced by tests, not by anyone remembering to be careful.

**Added 2026-07-10 (topic 29836): F9 — a background refresh never clobbers an open interaction.** The Subscriptions tab's self-refresh was wiping a half-typed PIN back into a button and swapping the paste-your-code step for a spinner mid-paste. F9 makes it a rule for every tab that refreshes itself: anything the operator is in the middle of using (an open step, a focused box, a half-typed field) keeps its exact place on screen until it finishes, fails, expires, or the operator backs out — the refresh may only update things around it, like a live countdown. Shipped first on the Subscriptions tab (shared helpers + tests, including a control proving the old behavior really destroyed typed input); rolling the helpers out to the other self-refreshing tabs is the tracked follow-up in the spec.

This change implements **F3 — every tab carries a plain-language purpose line**. Concretely: each of the dashboard's tabs now shows one muted, jargon-free sentence near the top saying what the tab is for and what you can do there (for example, the Secrets tab now reads "create one-time links so someone can hand you a password or API key safely, never pasted into chat"). We added a shared `.tab-purpose` style so these lines look consistent, converted the tabs that already had a description to use it, wrote fresh lines for the two tabs that had none (Sessions and Files), and added a test that fails if any tab ever ships without a purpose line. Nothing about how the dashboard *works* changes — this is display-only text and styling, so there is no risk to the server, no data touched, and rolling it back is just reverting the commit.

## What shipped in this increment
- The `.tab-purpose` CSS class + purpose lines on all 25 registered tabs.
- The F3 floor test (`tests/unit/dashboard-tab-purpose.test.ts`).

## Open questions / decisions
- **None blocking.** The four accepted purpose-line classes (`tab-purpose`, `ph-intro`, `features-subtitle`, `dropzone-subtitle`) are the dashboard's existing conventions; floor **F7** (shared component vocabulary), a later increment, will consolidate them into one. The nav model (grouped dropdown vs a persistent sidebar rail) remains the operator's open call from #1404 and is independent of F3.

## What comes next (out of scope here)
- **F4** — the body must never scroll sideways, especially on a phone (ships next, with a browser-gated viewport check).
- **F5–F8** — labeled controls, self-explaining empty states, and the shared style vocabulary.
