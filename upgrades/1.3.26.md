# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Twelfth increment of the **Feedback Factory Migration** (Dawn → Echo; spec `docs/specs/feedback-factory-migration.md`, approved). Ports the **dispatch request handlers** — the "send guidance back to agents" side — out of the reference Next.js endpoint (`the-portal/pages/api/instar/dispatches/index.ts`) into framework-agnostic functions at `src/feedback-factory/dispatch/handlers.ts`, plus the store operations they need (`listDispatches` / `findDispatchByTitle` / `createDispatch`).

List gates on the agent fingerprint, applies the since/type filter and the version-compat filter (so guidance only reaches the agent versions it applies to), and returns the mapped result. Create requires the internal key, validates the body, dedups by title, and creates. **Not wired into any route yet** — no behavioral change. This completes the front door's request layer (receive a report + send guidance both ported).

## What to Tell Your User

- Both halves of the feedback loop's front door are now ported and behave exactly like Dawn's originals — catching reports, and sending version-targeted guidance back.
- That's the entire request + decision layer done. What's left to actually go live is the database wiring and the deploy — now being coordinated with Dawn.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Dispatch handlers (TS port) | `handleDispatchList` + `handleDispatchCreate` in `src/feedback-factory/dispatch/handlers.ts` — framework-agnostic, not yet wired |
| Store dispatch seam | `FeedbackStore.listDispatches` / `findDispatchByTitle` / `createDispatch` |

## Evidence

- Reference is TypeScript, so equivalence is by faithful transcription plus both-sides-of-boundary tests (8): list UA-gate 400; basic list with count + asOf; version-compat filter hiding a min-version dispatch from an older agent; type filter; create 401 without the key; Bearer-form auth accepted; exact validation messages for title/content/type/version; 201-then-200-duplicate dedup by title.
