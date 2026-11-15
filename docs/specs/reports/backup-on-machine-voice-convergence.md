# Convergence Report — Reading voice notes on the agent's own machine

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier review ran through the agent's Codex CLI in rounds 2 through 6. Round 1's call failed (`degraded: error`): the agent home's installed reviewer still asked for `gpt-5.5`, which ChatGPT-account Codex no longer accepts; the fix was already on main (`capable` → `gpt-6-astra`), so rounds 2-6 ran from this worktree's fresh build. The Anthropic clean-door reader was tried once and declined (`override-not-frontier`: the configured model was not the frontier model), so it is not counted. Gemini was not signed in on this machine.

## ELI10 Overview

When someone sends an Instar agent a voice note, the agent needs it turned into text. Until now that only worked with a paid Groq or OpenAI key. On 14 November Justin's voice note from the Android app came through as "transcription unavailable", even though the Studio already had the free whisper.cpp program installed, which read the same note in about a second.

This change teaches every agent to use whisper.cpp on its own machine: when no paid service is set up, and as the backup when one fails. Telegram, the app, Slack and WhatsApp all go through one shared piece of code, so the fix reaches every channel. When nothing can transcribe, the agent is told exactly what is missing and offers to install it (free; the person only says yes). The agent can also say which transcriber it is using, from a status page.

The main trade-offs: transcription on the machine uses its CPU, so only one runs at a time per machine and every run has a time limit; and Telegram keeps its existing 60-second limit, so very long voice notes on Telegram may need to be shorter.

## Original vs Converged

- **Originally**, "ready" meant "the files exist". **After review**, readiness is a state proven by a real run, and only an installation-level failure (the program or model won't run) can switch local off for a while; a bad attachment from one person can't disable it for everyone.
- **Originally**, ffmpeg would read any file it was handed. **After review**, it only accepts single-file audio containers and no network, because a voice note is untrusted input and some formats can point at other files.
- **Originally**, "no speech" was judged from whisper's text. A real test showed whisper writes " you" for pure silence, so **now** silence is measured from the audio itself and reported as a measurement, never as transcript text.
- **Originally**, local transcription had a 120-second limit. Review showed Telegram handles messages one at a time, so a longer wait would freeze every Telegram conversation. **Now** Telegram, Slack and WhatsApp keep their existing 60 seconds, a paid service is held to 40 of them when local is ready (so a hanging service still leaves time for the backup), and one long app note can't hog the machine.
- **Originally**, one run at a time per server. **Now** one per machine (shared across agents of the same user) with a lock that can't be stolen by mistake, and notes with short time limits go first.
- **Originally**, a failure sent the person a canned reply. **Now** every channel tells the agent the plain reason, so the agent answers in its own words and can offer to fix it.
- **Originally**, the app labelled transcripts from shared state, which could swap labels. **Now** each transcript carries the provider that actually produced it.
- **Added**: an off switch (`voiceTranscription.local: false`), a key-refused report so a broken paid key isn't hidden by the backup, and exact install steps with a checksum.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security, adversarial, scalability, integration, decision-completeness, lessons (GPT degraded) | 14 | 9 | ffmpeg hardening, readiness states, budgets, label race, capabilities cache, layout title, off switch, WhatsApp escaping, queue cap, key-refused report, audio-level silence, multi-machine text |
| 2 | GPT; internal | 3 + 3 | 6 | install-only failures, 20 s reserve, model structural check; Telegram fairness, typed reasons on every channel |
| 3 | GPT; internal | 3 + 3 | 3 | ffmpeg claim made precise, ownership-safe takeover, per-process ordering; Telegram failure path without paths, per-user lock |
| 4 | GPT; internal | 3 + 1 | 9 | serialized takeover lock, deadline through the paid call, wording on vault read; estimate-based busy rule |
| 5 | GPT; internal | 3 + 1 | 7 | conversion bound, proven tied to install; no "kept file" promise on Telegram |
| 6 | GPT (code-level); internal | 2 code-level + 0 | 6 | none to the design; two code fixes (no tight loop on takeover, file read honours the timeout) |

Standards-Conformance Gate: round 1 ran (3 flags: fixed limits, parser fixture realness, live proof channels — all addressed: limits reclassified with evidence, real captured fixtures added, live proof on Telegram + Slack + app). Round 2 ran (7 flags; addressed: per-machine lock, "seems silent" wording, longer cap with explicit note, `-j 2`, app live proof, commitment for the pool view; the fixed-limits flag remains advisory with each limit now a judgment-candidate with a floor and arbiter).

Per-round model disclosure: internal reviewers ran as Claude subagents on the authoring session's model (Opus 5.5); the six lenses were grouped into three subagents in round 1 and one subagent covering all six lenses in rounds 2-6.

## Proportion

Tier 2 (untrusted input into native programs, four channels): spec 230 lines; 6 rounds used of 6. ⚠ The lock and timing details took four rounds; much of it was real (a lock race, a Telegram freeze, a wrong file-kept promise), but the effort was high for a modest feature.

## Left behind

- Pool-wide transcriber view (`scope=pool`) — tracked as Echo commitment ACT-613.
- Re-transcribing app notes that failed before an install — same commitment.
- Status route follows Telegram's `voiceProvider`, not Slack's (precision).
- In-process waiters behind another process's run fail at their deadline rather than at once (bounded).
- Telegram success-path logging throw could log a second line (unlikely).
- Unreadable-file checks report the piece as missing rather than "could not check" (wording narrowed in the spec).
- Gate advisory: fixed limits want measured derivations; each is a judgment-candidate default with a floor, to be tuned from real runs.
- A hanging paid service costs each Telegram note up to 40 s before the backup runs; no auto-pause after repeated timeouts (precision; logged).

## Full Findings Catalog

Round 1 (security + adversarial): ffmpeg playlist/concat reads (DESIGN, fixed); unbounded WAV size (DESIGN, fixed: 2 h cap); WhatsApp transcript unescaped (DESIGN, fixed); Telegram serial loop blocked by long local runs (DESIGN, fixed: 60 s budgets); fallback budget undefined (DESIGN, fixed); provider label race (DESIGN, fixed); unbounded queue (DESIGN, fixed); path disclosure, model checksum, trust boundary, output buffer, model folder naming, hallucination labelling (PRECISION, folded in).
Round 1 (scalability + integration): keychain read on /capabilities (DESIGN, fixed); poll-loop stall (DESIGN, fixed); app multi-machine claim wrong (DESIGN, fixed); layout title would land in sessions file (DESIGN, fixed); rollback lever didn't restore old behaviour (DESIGN, fixed: off switch); ffmpeg stdin hang (DESIGN, fixed); efficiency-core speed (DESIGN, noted with measurement).
Round 1 (decision-completeness + lessons): file presence as readiness (DESIGN, fixed); paid failures hidden by fallback (DESIGN, fixed: key-refused report); ffmpeg untrusted input (DESIGN, fixed); blank-audio tags not enumerable (DESIGN, fixed: audio measurement); one-at-a-time evidence wrong (DESIGN, reclassified); install steps, live proof, parser fixtures, time arithmetic, string-matched error text, local setting per channel, multi-machine install (PRECISION, folded in).
Round 2 GPT: any failure disabled local (DESIGN, fixed); paid could eat the whole budget (DESIGN, fixed: 20 s reserve); magic bytes don't prove a full download (DESIGN, fixed); larger-model wording (PRECISION, fixed).
Round 2 internal: shared slot vs Telegram (DESIGN, fixed: earliest-deadline + fail-fast); one bad note disabled local (DESIGN, already fixed); reasons not reaching agent on app/Slack/WhatsApp/Telegram (DESIGN, fixed); wiring sites, sync-ness, real longest note, peer install, m4a/webm whitelist test (PRECISION, folded in).
Round 3 GPT: ffmpeg file boundary overstated (DESIGN, fixed); stale takeover race (DESIGN, fixed); cross-process ordering overstated (DESIGN, fixed).
Round 3 internal: `[voice:path]` line neutralised by escaping (DESIGN, fixed: no path); kept voice files could be git-synced (DESIGN, fixed: file still deleted); shared /tmp lock (DESIGN, fixed: per-user folder); async measurement, report noise, Telegram timeout wording (PRECISION, folded in).
Round 4 GPT: takeover still racy after recreation (DESIGN, fixed: serialized takeover lock); paid timer started after file read (DESIGN, fixed); canTranscribe reads vault (DESIGN, wording corrected: same check WhatsApp already made).
Round 4 internal: worst-case cap used as finish estimate (DESIGN, fixed: measured speed estimate); fixed phrases, provenance, app "try again", Slack type, rollback timing, no-session case, cap wording, concurrency, non-key paid failures (PRECISION, folded in or left behind).
Round 5 GPT: conversion unbounded (DESIGN, fixed); initial lock estimate (DESIGN, already fixed); proven not tied to install (DESIGN, fixed).
Round 5 internal: Telegram has no kept file (DESIGN, fixed wording and reasons); lock first estimate, silent paid hangs, lost paid reason, report once, cross-process waiting, stale comment, trust wording (PRECISION, mostly fixed).
Round 6 GPT: takeover could spin (code-level, fixed); file read outside timeout (code-level, fixed); diagnostic detail (PRECISION, wording narrowed).
Round 6 internal: zero design findings; six precision items (fixed or left behind).

## Convergence verdict

Converged at round 6 (the Tier 2 cap). The final internal round found nothing that changes what gets built; the final GPT round's two items were implementation slips against an unchanged design and are fixed in the draft code. No open safety, security or data-loss finding remains. Eight items left behind. Spec is ready for build.
