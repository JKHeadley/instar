# Convergence Report — Awareness entry registry

## Cross-model review: codex-cli:gpt-6-astra

A GPT-tier outside review ran through the codex CLI in every one of the six rounds (status ok each time). A clean-door Anthropic second read (claude-code, claude-opus-5-5) also ran every round; it is a second read, not a cross-model opinion. Gemini was not available (not signed in).

## ELI10 Overview

Every Instar feature has to tell the agent it exists by adding a few paragraphs to the agent's instruction document. Today a feature does that by editing two very large shared files, always at the same spots as every other feature. When two features do that, the second one to merge gets a conflict even though neither did anything wrong, and it has to be combined by hand and tested again. On 2026-11-14 eight features were knocked out of the test line that way in one night.

This spec gives features a folder. A feature drops one small text file in it with a title and its text. The program reads whatever is in the folder and puts all of it into one section at the end of the instruction document, which it rebuilds on every update. Because each feature has its own file and there is no list of files anywhere, two features can no longer collide on this. As a bonus, a wording fix now reaches every agent, and a removed feature's text goes away, neither of which the old mechanism could do.

Nothing that exists today moves, and on the day it ships there are no files in the folder, so every agent's document is exactly what it is today. The trade-off is one more mechanism to understand, and it only fixes collisions in the instruction text, not in the other shared files features also touch.

## Original vs Converged

The first draft had each feature add a small code file, found the files by scanning the built program's folder at start-up, gave each feature its own marker phrase to detect whether an agent already had its text, and refused to start the server if a file was broken.

Review changed almost all of that:

- **A broken file no longer stops the agent.** It is left out and reported; the tests are what keep a broken file from being released.
- **Scanning the built folder was dropped.** The build never deletes the output of a removed file, so a stale file would have been loaded silently. A middle design (a list generated at build time) fixed that but had to be wired into every build, lint and test entry point, which is its own way to break the test line.
- **Entries became plain text files instead of code.** The package already ships its data folder as-is, so nothing is built, nothing can go stale, and a feature's file cannot break anything by running. A reviewer sampled the instruction sections written recently and found essentially all of them fit this format.
- **Per-feature marker phrases were replaced by one managed section** that is rebuilt on every update, which is what makes wording fixes and removals reach every agent.
- **Marker lines are kept out of the main document** that feeds the reference files, because the document parser would have attached them to neighbouring sections. They exist only in files that are patched in place.
- **A damaged section is left exactly as it is and reported**, instead of a fresh one being added beside it, which would have repeated on every update.
- **The copy made for Codex and Gemini** got explicit rules so registry text can never leak into, or hide, the older sections it copies.
- **The check for the old way became advisory** and never blocks.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 0 (pre-round) | Standards-Conformance Gate | 3 flags | 0 | no startup failure on a bad entry; lint advisory; multi-machine statement corrected (an unsupported "operator-ratified" claim removed) |
| 1 | security+adversarial (4), scalability+integration (4), decisions+lessons (8), codex (2), clean door (2) | about 12 distinct | 9 | rewritten: generated index; one managed block; title/body entries; zero entries at ship |
| 2 | security+adversarial (4), scalability+integration (4), decisions+lessons (2), codex (3), clean door (0) | about 8 distinct | 9 | markers out of the canonical document; broken block = change nothing; generator wiring corrected; throwing body caught |
| 3 | security+adversarial (0), scalability+integration (1), decisions+lessons (1), codex (2), clean door (1) | 4 | 8 | mirror source defined; render-time one-unit check; scripts importing src; rejection reason corrected |
| 4 | security+adversarial (1), scalability+integration (0), decisions+lessons (0), codex (2), clean door (1) | 4 | 7 | entries become data files, no generator; fences and whole-block check; reporting where produced; block removed from the copy before the mirror loops |
| 5 | internal (0, 0, 0), codex (1), clean door (1) | 2 | 15 | both-marker boundary and broken-copy rule; conversion removes a block by its markers |
| 6 | internal (0, 0, 0), codex (0), clean door (1) | 1 | 13 | title uniqueness added in passing (one line); no further round |

Standards-Conformance Gate: ran before round 1 (3 flags, all addressed). It was not re-run in rounds 2 to 6; the three standards it flagged were re-examined by the lessons-aware reviewer in round 1 and held afterwards.

Internal reviewers: the six lenses were run as three paired subagents (security + adversarial; scalability + integration; decision-completeness + lessons-aware), each resumed with its own context in every round, on the authoring session's model (claude-fable-5-2). All were read-only because the machine was running the test line; nothing was executed.

Externals: mandatory every round (the spec body changed each time). Body hashes: r1 280483bf, r2 899254c7, r3 aa6104f7, r4 0de85fa9, r5 9c65743d, r6 53513620.

## Proportion

Tier 2 (it changes how every agent's instruction document is built, new and existing). Spec about 370 lines. 6 rounds used of a cap of 6. ⚠ That is the full cap. The rounds were not polish: rounds 1, 2 and 4 each replaced a core mechanism (start-up scan, then generated index, then data files), and each replacement removed more than it added. Rounds 5 and 6 were narrow.

## Left behind

Converged at the round cap. Round 6 raised one design finding (titles not checked for uniqueness); it was fixed with one added validation line and not sent through a seventh round. It is not a safety, security or data-loss matter.

Precision items for the build to pick up, not iterated on:

- Mirror "changed" count must compare the final text with the original copy after its CRLF handling; add a no-change second pass on a CRLF copy.
- The block finder's whole-line match should tolerate a trailing carriage return.
- Pass the block-stripped text to `extractOperatorContent` only; the one-time backup keeps the true original. Say that the second call site (text below the core markers) is deliberately unchanged.
- The marker prefix goes into the mirror's `boundaryMarkers` only, never `markers`.
- State that entries are read once per process and that the migrator runs in the new process after an update.
- "Needs top-level await" overstates why compiled-module discovery was rejected; the stale-output reason stands on its own.
- Two entries merged separately can together exceed the core size budget through their titles; the size test on main catches it after the fact. Consider a note in the folder's README.
- A small table for the mirror (source kind × block state → action) would make 3.4 item 3 easier to read.
- A per-entry size cap was suggested three times and not adopted: no evidence yet of oversized entries, and a fixed cap needs a basis.
- An overlay-style deploy that does not replace the package directory could leave a removed entry file behind; the update paths checked use installs that replace it.
- A revert of the whole mechanism needs a removal step for leftover blocks (stated in section 7).
- The advisory lint and the two-week review were called more ceremony than the risk needs; kept because they cost nothing when quiet.
- Rows under core headings, and the other shared files (`server.ts`, `routes.ts`, `feature-ladders.json`), are out of scope and tracked under CMT-1767.

## Full Findings Catalog

Round 1. Security+adversarial: stale or dropped files in the built folder load as entries (DESIGN, resolved by not reading built output); section 7 wrong about removed entries (DESIGN, resolved by the rebuilt section); an edited marker duplicates text (DESIGN, resolved by removing per-entry markers); purity untested (DESIGN, resolved: entries are data); requires and the mirror (DESIGN, resolved by one eligibility function). Scalability+integration: appended entry may not land in a reference file (DESIGN, resolved by the fixed non-core heading and the canonical last step); example does not form a unit (DESIGN, resolved: the registry writes the lead-in and checks with the real parser); top-level await deadlock (DESIGN, resolved: no await); stale built entries (DESIGN, as above). Decisions+lessons: title rule vs parser; placement; duplicate handling; proof conversion; decision-point rows incomplete; marker verify-state; lint measure; discovery reads build output; no way to revise wording (all DESIGN, all resolved in the rewrite). Codex: Telegram filter inconsistent across consumers; empty registry passes health checks (both DESIGN, resolved). Clean door: where the helper lives can hang start-up; leftover built files load silently (both DESIGN, resolved).

Round 2. Security+adversarial: start marker joins the previous unit; broken-marker path not idempotent; marker detection must be whole-line outside fences; mirror can copy the end marker (all DESIGN, resolved). Scalability+integration: marker lines join neighbouring units; "always last" false in the canonical document; consumer 2 never touches the real file under the reference layout; generator wiring incomplete (all DESIGN, resolved or made moot). Decisions+lessons: marker lines are not units; broken-marker action never converges (DESIGN, resolved). Codex: broken-marker growth; throwing bodies not isolated; stale generated index (DESIGN, resolved or moot). Clean door: no design findings.

Round 3. Scalability+integration and decisions+lessons: the mirror's registry-free source had no defined mechanism (DESIGN, resolved by the empty-registry build and block removal). Codex: one-unit guarantee not enforced at run time; scripts importing source cannot generate their own index (DESIGN, resolved; the second became moot). Clean door: reason for rejecting a union-merge list was wrong (DESIGN, corrected).

Round 4. Security+adversarial: the mirror's "already present" test reads registry text in the copy (DESIGN, resolved by removing the block from the copy first). Codex: an unclosed code fence can swallow the end marker; reporting only at start-up (DESIGN, resolved). Clean door: entries as data files not considered (DESIGN, adopted).

Round 5. Internal: none. Codex: broken blocks through the mirror (DESIGN, resolved with the both-marker boundary and the broken-copy rule). Clean door: conversion recognises a block by matching text, not markers (DESIGN, resolved).

Round 6. Internal: none. Codex: none. Clean door: titles not unique (DESIGN, fixed in passing).

## Convergence verdict

Converged at round 6, the cap for a change of this size. All three internal reviewers and the GPT-tier outside reviewer found nothing in the final round that changes what gets built; the one remaining design point from the clean-door read was a one-line addition and has been made. Thirteen items are left behind for the build. The spec is ready for approval.
