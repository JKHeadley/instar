# Convergence Report — Permanent agent links (instar.sh/a)

## Cross-model review: codex-cli:gpt-6-astra (RAN every round) + claude-code clean-door read (RAN every round)

GPT 6 Astra (through the Codex CLI) read the spec in all six rounds. The Anthropic clean-door read (`claude -p`) also ran in all six. It is a second Claude-family read, not a cross-family one, and it said so itself. Gemini was not signed in on this machine. Verdicts by round: GPT "serious issues" (round 1), then "minor issues" (rounds 2 to 6), with no design findings in rounds 5 and 6.

## ELI10 Overview

Today a link to something your agent has, like a conversation or a document, points at one of the agent's computers. If that computer is away, or its name changes, the link breaks. An agent on two computers has two different links.

This adds a link that names **the agent itself**: `https://instar.sh/a#…`. The part after `#` holds the agent's identity (a fingerprint of its own key) and which page to open. Browsers never send that part to instar.sh, so instar.sh stores nothing and never learns which agent or page it is.

When you tap the link, the Instar app on your iPhone or Mac finds the agent you're paired with that has that identity. It opens the page over that agent's own Cloudflare or Tailscale connection, the same way it does today. A browser without the app gets a plain page with an "Open in Instar" button. It never redirects anywhere.

A link only opens a page; it never approves or sends anything. Another agent can't pretend to be yours: the app checks a fresh signature from the agent before it trusts an identity. The feature is off unless the agent turns it on.

## Original vs Converged

| Area | First draft (16:03) | Converged |
|---|---|---|
| Link grammar | Fields had patterns, but the topic id had no upper bound, and how `%` encoding was handled was loose | Exact patterns with a computed length bound; topic ids follow the server's own safe-integer rule; `%` only as `%3A` in `r`/`c`; one parser with shared accept/reject vectors (server, page, app) |
| Which identity file | "Same as the handover reader" | Strict: `identity.json` decides; the legacy file is used only when it is absent; two different keys → refuse (`identity-split`) |
| Proof | Transcript only | Fixed check order; nonce has exactly one valid spelling; the host is the one the signature was verified against (shown in code); empty host → refuse |
| App binding | Three states, with gaps | A full transition table (`none`/`bound`/`mismatch`/`off`); a per-row counter so late answers can't undo newer ones; re-check on tap so a link works right after it is turned on |
| Several matching rows | Always ask | Rows with the same person and role open without asking. Failover uses the app's existing read rule (it covers Cloudflare 530 when a machine is off); any answer from the agent is final; different roles → ask |
| Multi-machine | "Survives machine boundaries by construction" | A table of where each kind of target lives and what happens through a machine that lacks it; a split-identity warning on the builder |
| Observability | None | One evidence row per server outcome; app counters, including rejected proofs |
| `/doc` page | Revived, with a host warning | Moved out (it would make instar.sh a forwarder); tracked as feedback fb-f607b9d8-7d9 |
| Parent principle | Sovereignty | An Instar Agent Is Always a Multi-Machine Entity |

## Iteration Summary

| Round | Reviewers | Design findings | Notes |
|---|---|---|---|
| 1 | GPT 6 Astra (codex); Claude clean door; security + adversarial; integration + scalability; decision + lessons | ~20 | Standards-Conformance Gate: ran (2 flags: equal-row prompt, observability; parent fit weak) |
| 2 | GPT; Claude clean door; security/integration; decision/lessons | 3 | Standards-Conformance Gate: ran (2 flags: topic-id bound, content locality) |
| 3 | GPT; Claude clean door; one all-lens internal reader | 1 (all three readers found it) | Standards-Conformance Gate: ran (2 flags: evidence window, content locality) |
| 4 | GPT (0 design); Claude clean door; all-lens internal | 2 | Standards-Conformance Gate: ran (results arrived after the round; nothing new) |
| 5 | GPT; Claude clean door; all-lens internal | 3 small | Standards-Conformance Gate: ran (2 flags: P20 "couldn't check" wording, one-try-per-tap) |
| 6 | GPT (0 design); Claude clean door; all-lens internal | 3 small, all wording or naming in the app layer | Standards-Conformance Gate: ran (3 flags: re-check concurrency, invalid-proof wording, evidence window; the first two were fixed, the third is under Left behind) |

From round 3 on, the findings stayed at about one narrow item per reader per round. Each was smaller than the one before, and each was about how the app layer is described, not about the architecture. The two security reviews and every later round agreed that the core design holds: a link names a self-certifying identity, the device resolves it locally, a fresh signed proof gates every binding, and instar.sh stores nothing. Under the fractal 80/20 rule, review stops here. Anything further is caught more cheaply by the app build and the live proof, which the spec requires before "done".

## Left behind (reviewed, deliberately not changed)

These are listed in the spec's own Left behind section:

- A target that lives on only one machine is "unavailable" when the link opens through another machine. That is how each target's own feature already works.
- The 60-second window on evidence rows. It matches the existing pairing evidence, and the app's counters are exact.
- `tg:<id>` assumes one Telegram supergroup.
- No warning when a peer machine has links turned off.
- Each row is tried once per tap.
- A bound but unreachable row does not trigger re-checks of id-less rows on other machines.

## Convergence verdict

**Converged** after 6 rounds, at 2026-11-17 ~17:00 PT. The design was approved by Justin as doc c101c6b8 ("approved", topic 144473, 15:56 PT). The spec changes no constitution files, so under the standing rule no further operator approval is needed for a non-constitution spec.
