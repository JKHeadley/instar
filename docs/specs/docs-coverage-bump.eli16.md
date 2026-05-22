# Docs coverage second pass — plain English

The first round set up the structural answer to documentation drift — a script that measures coverage of every shipped capability, and a CI gate that fails any pull request that drops the coverage below a calibrated floor. That round landed yesterday and the floors were calibrated loose (around 15% overall) because the existing gap was large.

This round does what the gate was designed for: ratchets the bar. Two categories were sitting near the floor — routes (15% covered) and classes (15% covered). Both are now in the 55-62% range, and the floors moved up correspondingly so future pull requests can't regress past the new bar.

The way each category got bumped:

For routes, the existing API reference page had the most-used endpoints documented with curl examples but only covered about a fifth of the registered route surface. Writing detailed docs for the remaining 380 routes would be days of work, and most of them follow guessable patterns. Instead, this change appends a full route inventory to the API reference — every registered route grouped by prefix, listed by HTTP method and path. The curated sections stay as the front; the inventory is the grep-friendly back. Route coverage jumped from 15% to 59%.

For classes, two complementary moves. First, the architecture page got a "Subsystem class inventory" appendix that lists every top-level class shipped under each source subsystem. It's a navigation aid — class names grouped under headers like "core" and "monitoring" and "threadline", so you can find the owning page for any class by skimming the right list. Second, four new feature pages got written for the subsystems that previously had zero documentation home: paste handling (the lifecycle for user-pasted content), privacy routing (the component that routes sensitive replies to DM instead of public topics), the self-healing remediator (the system that detects and fixes known failure patterns automatically), and task flows (the durable multi-step job system imported from OpenClaw). Class coverage jumped from 15% to 62%.

The sidebar config also got updated so the new pages and the ones from the previous round (Slack, observability, cross-framework portability, coherence gate, the living system, threadline protocol wire format) actually show up in site navigation when the deploy works. The Vercel deploy itself is still misconfigured — the project's root directory setting points at the repo root instead of the site subdirectory, which is why the live site at instar.sh currently serves the wrong content. That's a Vercel dashboard fix, separate from code.

The floor ratchet means future pull requests have to maintain at least 55% overall and 55% per major category. Doc-update PRs that move coverage further up should bump the floors too, the way this PR does — that's how the bar keeps moving. The weekly audit job will continue surfacing the trend.

This is the second round of what should be many incremental rounds. The structural protection is in place; the rest is just sustained attention to the gap.
