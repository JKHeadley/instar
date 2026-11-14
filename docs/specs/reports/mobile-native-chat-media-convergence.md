# Convergence Report — Media in app conversations (photos, files, voice notes, video)

## Cross-model review: codex-cli:gpt-6-astra

The external Codex reviewer (gpt-6-astra) ran in all six rounds against the spec, with mobile-native-conversations.md, mobile-device-keys.md, mobile-operator-chat.md and mobile-push.md as context. Every round returned findings and every one was folded into the spec. Gemini was not available (`gemini-not-authed`); grok-build is not enabled. The Standards-Conformance Gate ran every round. Internal reviewers ran on this session's model (Claude Opus 5.5) as subagents: round 1 used two (security/adversarial/scalability, and integration/decision points/decision-completeness/verify-the-state/lessons); rounds 2–6 used one subagent applying all lenses. They read the source code and caught most factual errors about it.

## ELI10 Overview

The Instar iPhone app now has its own conversations with the agent, but they carry only text. In Telegram the operator can already send the agent a photo, a document or a voice note and the agent opens it from a file on its machine. This spec adds the same to the app, plus videos, files from the agent back to the phone, and voice notes that are kept and transcribed on the phone itself, so they work even for an agent that has only a Claude subscription.

The phone uploads each file in signed one-megabyte pieces that can resume after a dropped connection, then sends a signed message listing every file's fingerprint (SHA-256). The saved record therefore proves the phone sent exactly these files. The agent's session gets a path to a private copy, in the same `[image:…]` form Telegram uses. Files are typed by their bytes, never their names, and anything that could run in a browser is only ever served as a download. Every download is a signed request from a phone that is still paired, and the phone re-checks each file's fingerprint before showing it. The agent can reply with files, but only from its project, its outbox or the temporary folder, never from places that hold keys, and every file passes the same live-credential wall as reply text.

Files are copied to every one of the agent's machines in the background, with brakes, and the agent measures how many files exist on only one machine and says so when that lasts. Nothing deletes a file on its own; the operator can permanently remove the files of deleted conversations from the app. The main tradeoffs: the storage limit is a soft planning limit (machines that lose contact can each fill it), and a file accepted on a machine that dies before copying it is lost, the same window that applies to any not-yet-copied message.

## Original vs Converged

- **Originally**, attachments were extra fields on the existing message event, and the spec claimed older versions would refuse them. **After review**, that claim proved false (older validators silently drop unknown fields, which would have stored file-less messages forever), so media became a new event kind that older versions refuse.
- **Originally**, a misdeclared file was re-labelled, which would have broken its own signature check, and redacted media reused the v1 attestation. **After review**, the declared kind is kept for the signature, and redacted media uses a new v2 attestation over a canonical projection of stored fields, with the validator keeping the version field.
- **Originally**, the agent's `--file` could name any path, protected by a list matched relative to the project. **After review**, paths are confined to three roots with a home-level credential denylist, hard links are refused, bytes are snapshotted before a credential scan of every file, and the spec says plainly that a deliberate copy inside an archive is outside this protection.
- **Originally**, the storage cap was checked once at upload start and "deleting conversations frees space" was false. **After review**, every admission reserves against a usage figure computed from replicated metadata, a physical disk floor protects every disk, deleted conversations' files do not count, the operator can permanently remove files from the app, crash orphans are reclaimed, and the cap is honestly labelled a soft cap.
- **Originally**, bytes replicated eagerly only for native conversations and pulls had no brakes, and the serve side reused a verb that hashes whole files on the event loop. **After review**, every blob replicates eagerly with backoff, give-up, a peer breaker, a bounded load pause, inventory-measured copy counts and alarms; slices are served with async reads and no re-hash.
- **Originally**, voice notes needed Groq or OpenAI. **After review**, the phone transcribes on-device and signs the transcript; server transcription is a fallback, and a too-long transcript is never cut silently.
- **Originally**, uploads claimed iOS background support, used a machine-local Slack alias in signed data, and had no claim or crash recovery. **After review**, uploads are foreground only, use canonical keys, are claimed atomically, and have a single idempotent finalize procedure for every crash point.
- **Originally**, push previews for media had no route to fetch from. **After review**, a narrow preview route under the existing notification read token returns a fixed phrase.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | Codex (5), internal security panel (10), internal integration panel (10), gate (1 flag: multi-machine) | ~20 distinct after de-duplication | 12 | Full rewrite: `media-message` kind, `declaredKind`, redaction v2, path confinement, store cap and purge, upload claim, foreground uploads, canonical Slack key, on-device transcription, pull brakes, push preview route, async serving |
| 2 | Codex (4), internal (6 + 2 gate items), gate (2 flags: verify-the-state, cross-store coherence) | 10 | 1 | Usage from replicated metadata, disk floor for all writers, platform-media events, orphan reclamation, size limits, complete knownFields, replay-guard reserve, hard-link refusal and full scan, honest credential boundary |
| 3 | Codex (4), internal (4), gate (1 flag: multi-machine) | 6 | 5 | Serialized size check, snapshot before scan, purge scoped by attachment ids, per-conversation purge events, bounded load pause, residual risk stated, helper timeout, offline-peer alarm |
| 4 | Codex (3), internal (2), gate (1 flag: Signal vs Authority) | 5 | 4 | Purge batching, retained deleted blobs replicate, `redaction.v` kept, platform media in copy counts |
| 5 | Codex (3), internal (2), gate (1 flag, same) | 5 | 1 | Admission simplified to an honest soft cap (the acknowledgment state it relied on does not exist), redaction projection, upload crash recovery, phone-side hash check before display, credential-wall authority cited |
| 6 | Codex (4), internal (2), gate (1 flag, same) | 6 | 1 | One finalize procedure, claim recovery only for stranded requests, limits and reservation before copying reply files, token removal and `scanInbound` over transcripts and filenames, purge removes session copies |
| Standards-Conformance Gate | ran every round (1–2 flags each); a final run after round-6 edits flagged a silent transcript cut, fixed | — | recorded per round above |

Round cap: 6 (Tier 2: security-sensitive, published app interface). Stopped at the cap with every round-6 design finding applied in the spec text.

## Proportion

Tier 2, a spec of about 280 lines for a feature in five increments; 6 of 6 rounds used. Every round surfaced real design defects, most of them factual errors about the code that only a code-reading reviewer could catch, so the rounds were proportionate. The size reflects that this spec touches device authentication, signed records, replication and a published app contract at once.

## Left behind

- **Round-6 edits were not re-reviewed** (the cap). They are local fixes (one finalize procedure, claim recovery rule, pre-copy limits, token removal in transcripts and filenames, purge removing session copies); each has a named test, and the first increment's PR review is the next independent read.
- **Standards-Conformance Gate, Signal vs. Authority on the reply-file credential wall (rounds 4–6).** Accepted with reasoning: this spec creates no new blocking authority; it routes files through the existing non-overridable live-credential wall, whose authority rests on `docs/signal-vs-authority.md`'s hard-invariant exemption and Judgment Within Floors, as recorded in outbound-credential-wall-modern-key-formats.md. The conflict with the registry article's "one named exception" wording is tracked in ACT-027 (open).
- **Gate fit verdict "weak"** every round: the gate judged the parent principle (reachability and responsiveness) only loosely served by a capability-parity feature. Not a design defect; recorded.
- Mode 0400 on blobs does not stop a process running as the agent's user from changing them; the hash re-checks detect it (stated in 4.8).
- `WorkingSetPull`-style full-file hashing is avoided on the serve side; the receive side hashes once in a worker (accepted cost).
- Push preview leaks nothing to Apple, but the preview route reveals the media kind and caption to whoever holds the notification read token (the same exposure class as attention titles in mobile-push.md).
- Telegram/Slack parity gaps (inbound Telegram video, files over 20 MB, session file replies into Telegram or Slack) are existing adapter limits, filed as one feedback item at increment 1's ship (4.9).
- Inventory traffic at very large blob counts is bounded by diffs; paging the full list on request is left to the build.
- Precision items folded in passing: canonical chunk index, per-rule body type, `sendRoute`/`ownBucket` naming, Telegram's decimal 50 MB limit, tick interval, `openCheckedDescriptor` wording, CLAUDE.md wording, impossible 60 MB test fixture, `batch` field removed.

## Full Findings Catalog

**Round 1.** Codex: reclassification breaks signature (fixed: `declaredKind`); no atomic upload claim (fixed); incomplete storage cap (fixed); undefined delivery after the 60-second pull timeout (fixed: durable pending row and follow-up line); push preview has no contract (fixed: preview route). Internal: false rollback claim (fixed: new event kind); `transient-staging` not in taxonomy and upload failover (fixed: physical-credential-locality, `404 upload-unknown`); platform media on-demand only (fixed: eager for all); false "deleting frees space" advice (fixed: deleted not counted, purge); redaction v1 changed in place (fixed: v2); key-material wall project-relative only (fixed: confinement and denylist); iOS background upload impossible (fixed: foreground only); no Slack route and alias in signed data (fixed: canonical key, dependency on parent increment 4); voice on a Claude-only agent (fixed: on-device); unbounded pull loops (fixed: brakes); whole-file sync hash on serve (fixed: async reads); assembly on event loop (fixed: worker); filename tag forgery (fixed: title cleaning); cap writers unbounded (fixed: reservation for all). Precision: counters as symbols, decision table gaps, migration sniff heading, start hash, leading zeros, replay budget, JSON to chunk route, mode 0400 limits, tick interval, lazy session copies.

**Round 2.** Codex: machine-local reservations cannot enforce an agent-wide cap; credential guarantee overstated; platform references not durable; unreclaimable storage. Internal: both gate flags valid; record size over journal limit; admission ignores disk floor; purge before tombstone; replay-guard exemption unbounded; knownFields incomplete; double reservation. All fixed.

**Round 3.** Codex: purge unbounded and fights pulls; 44 KiB body does not fit 80 KiB; scan and publish read different bytes; overshoot bound unsupported. Internal: same size and purge issues, purge event shape invalid (single `conversationKey` required), posture wording, helper with no timeout, alarm only when all peers online. All fixed.

**Round 4.** Codex: overshoot bound false under partition; oversize purge events; deleted-file retention conflicts with serving. Internal: `redaction.v` dropped by the validator; platform media missing from copy counts. All fixed.

**Round 5.** Codex: redaction hash unreconstructable (uploadId); upload assembly recovery; download integrity not end to end. Internal: the per-peer pull position the spec relied on does not exist; an offline peer would freeze admission; credential-wall citation. All fixed; the admission scheme was removed in favour of a stated soft cap.

**Round 6.** Codex: recovery bypassed completion checks; sweep could undo an active send; reply limits after copying; transcripts skip token removal. Internal: transcript and filename skip `scanInbound` and token removal; purge left session copies. All fixed without a further round (cap).

## Convergence verdict

Stopped at the round cap (6) for a Tier 2 spec. No safety, security or data-loss design finding remains open: every one raised in round 6 is applied in the spec text, and the remaining items above are precision-class or accepted with reasons. Spec is ready for approval.
