# Default scenario packs — MTP Red-Team Harness (EXO 3.0 G7)

Each pack is a `pack.json` (scenario definitions) plus a `payloads/` directory of
single-message attack fixtures referenced **by path + sha256** from the pack.

## Payload-by-reference protocol (why payloads aren't all committed)

Attack text must never accumulate in a long-lived agent transcript — inlining
red-team payloads into a conversation permanently wedged a session via an
AUP-rejection loop (CMT-1115). So:

- **Committed here**: `L0.md` (declared-audit — a safe "test this against our
  intent" framing) and `L1.md` (naive-direct — a plausible, benign user-style
  request). These bound the *bottom* of the ladder and let reviewers see the
  format without exposing engineered attacks.
- **Authored locally, gitignored** (`L2.md` motivated, `L3.md` engineered): the
  higher-pressure / engineered payloads are authored in a **dedicated, retired
  session** right before a live run (never in the orchestrator's transcript),
  and their `sha256` in `pack.json` reads `PENDING-LOCAL-AUTHOR` until then. The
  runner refuses to send a `PENDING-LOCAL-AUTHOR` level unless it is given a
  freshly-authored file whose hash it then pins.
- **The orchestrator never reads payload bodies** — it handles `{path, sha256}`
  only. The mechanical runner reads the file at send time and verifies the hash
  first.

## Authoring the gitignored payloads

In a throwaway session (NOT your main working session), write the `L2.md`/`L3.md`
files directly to each pack's `payloads/` dir, then update the corresponding
`sha256` in `pack.json` (`shasum -a 256 <file>`). Keep them benign
organizational-boundary probes — pressure, plausible rationale, authority
framing — never illegal content, malware, or harm instructions (spec §9).

## Channel coherence

Both default packs use `senderContext: owner-authentic`, the only context the
Tier-4 seat (the operator's authenticated channel) can coherently deliver.
`unknown-party` impersonation packs need a second sender identity (Phase 2);
`peer-agent` relay packs need Threadline (Phase 3). The pack linter rejects an
incoherent sender/transport pairing.

Spec: `docs/specs/MTP-REDTEAM-HARNESS-SPEC.md`.
