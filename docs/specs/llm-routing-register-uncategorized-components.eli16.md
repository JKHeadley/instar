# Register 13 uncategorized LLM components — Plain-English Overview

> The one-line version: thirteen background AI helpers were quietly running on Claude instead of the cheaper off-Claude models their peers use; this tells the router which category each belongs to so they route like everyone else.

## The problem in one breath

Instar runs dozens of small AI calls in the background — things that classify a message, validate a resumed session, summarize a screen, or distill a correction into a preference. There's a policy that routes those background calls OFF Claude (Claude's subscription rate-limits hard) onto other providers. But that policy only moves calls whose component name is listed in a central category map. Thirteen real AI call sites were never added to that map, so they silently fell through to Claude and burned Anthropic quota — while their near-identical siblings routed off-Claude correctly.

## What already exists

- **The category map** (`componentCategories.ts`) — a lookup table saying each component is a `sentinel`, `gate`, `reflector`, or `job`. The router reads it to decide which provider runs a given call. An unlisted name resolves to `other`, which falls back to the default provider (Claude).
- **The provider-fallback policy** — already moves `sentinel`/`gate`/`reflector` calls off Claude automatically. It works today for every *registered* component.
- **The wiring ratchet** (a CI test) — already scans the source for AI call sites and fails the build if one isn't either registered or explicitly pinned as a known exception. The thirteen components were sitting in that "known exception" backlog, explicitly deferred from an earlier PR because registering a name changes live routing and "each needs its own deliberate routing decision."

## What this adds

This is that deliberate decision. It adds the thirteen deferred components to the category map, each tagged by what it actually does, so they route off Claude like their peers. It then trims those thirteen out of the ratchet's "known exception" list — leaving only the five that are correctly handled a different way (they pass their category explicitly at the call site, so they never needed a map entry).

The thirteen, by category: **sentinel** — the input classifier, the session-summary sentinel, the Telegram alert-suppression judge (this also fixes an asymmetry: the equivalent Slack judge was already registered); **gate** — the resume validator; **reflector** — the topic router, topic-intent extractor, pre-compaction fact flush, knowledge-tree synthesis, multi-machine conflict resolver, A2A conversation-brief writer, A2A check-in summarizer, correction-learning distiller, and mentor-stage-b forensics.

## The new pieces

No new modules and no new logic — this is a data-map change. Thirteen key/value rows are added to an existing table, and thirteen names are removed from an existing test's exception set. The router, the fallback policy, and the ratchet are all untouched.

## The safeguards

**Prevents a wrong-provider surprise.** Every one of the thirteen joins a category (`sentinel`/`gate`/`reflector`) that the fallback policy already routes for dozens of other components — so the target providers are already exercised in production. Nothing routes anywhere new; these calls just stop being the odd ones out.

**Prevents silent recurrence.** The existing ratchet already fails CI if a *future* AI call site is added without being registered. This change strengthens that guarantee by clearing the backlog down to only the genuinely-exempt five, so the exception list now means exactly what it says.

**Prevents mis-categorization drift.** The ratchet's second assertion verifies that everything still pinned as an exception genuinely resolves to `other` — so if someone later registers one of the remaining five, CI tells them to remove it from the list.

## What ships when

One PR, one Tier-1 change: the map addition and the exception-list trim ship together, guarded by the already-green routing and ratchet tests. It is reversible by removing the added rows. A follow-up (separate, operator-reviewed) will re-derive each category by task *nature* and by which model is reachable on a subsidized non-Claude subscription — this change simply stops the thirteen from leaking onto Claude in the meantime.
