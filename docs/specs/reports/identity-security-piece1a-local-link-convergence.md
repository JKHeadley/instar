# Convergence Report — The one-time local dashboard link

**Spec:** [docs/specs/identity-security-piece1a-local-link.md](../identity-security-piece1a-local-link.md)
**Slug:** `identity-security-piece1a-local-link`
**Converged at:** 2026-11-18T07:55:00Z
**Iterations:** 4 (after five rounds on the larger piece-1 spec it was split from)
**Final-round design findings:** 0 open. Round 4's one design finding (a timing anchor) was fixed in the text and covered by a test; no fifth round was run (see Proportion).

---

## ELI10 Overview

The agent's dashboard is locked with a PIN. If someone at the agent's computer types the PIN wrong too often, the dashboard stops letting that computer try for a few minutes. Today the dashboard can't tell the person at the computer from any other program or user account on the same computer, so any of them can use up those tries and lock the person out.

This spec adds one command, `instar dashboard open`. Usually the agent runs it for the person: it opens the dashboard on the computer's screen through a link that works once and for 15 minutes. Only the agent's own user account can make the link, and the command and the agent prove themselves to each other with a private key before anything is trusted. A browser that came in through the link gets its own allowance of PIN tries. The PIN is still required, and the link gives no other power.

It is the first small part of the approved identity design (piece 1). Later parts build on it: resetting a forgotten PIN at the computer, adding a security key, and the rest of piece 1's fixes. It deliberately does not authenticate the dashboard page itself to the browser (that is for the later sign-in pieces), and the Mac app button, `localhost` addresses and the WSL route come in their own small pieces.

## Original vs Converged

- **Originally** piece 1 was one spec with ten changes. **After review** it is a sequence of small specs, this one first. Why: five rounds kept finding new problems across all ten at once.
- **Originally** the link used `localhost` and the server would also listen on the second loopback address. **Now** the link uses the numeric `127.0.0.1`, and every link request must arrive on the server's own `127.0.0.1` socket. Why: `localhost` has two addresses, and a second listener brought its own problems (WebSockets, shutdown, restarts); one exact address avoids them.
- **Originally** minting used the agent's ordinary access token. **Now** it uses a private key only the agent's account can read, and the server signs its answer over the secret and the address, so the command never trusts an impostor. Why: the access token is readable by other accounts on many installs, and a squatting program could otherwise hand back a fake link.
- **Originally** a full table refused new links. **Now** the oldest unused link or credential is replaced, so repeated clicks never lock anyone out.
- **Originally** links survived a restart. **Now** a restart cancels every unused link, and a mint stamped before the server began listening is refused. Why: a program that grabbed the address during a restart could otherwise read a link and use it.
- **Originally** the person was told to run `instar dashboard open`. **Now** the agent runs a launcher the server writes at a fixed path. Why: on a standard install the `instar` command is not on the PATH at all.
- **Originally** a browser with an existing unlock cookie was judged on the link's budget too. **Now** a working cookie keeps exactly today's treatment, and a full link budget falls back to today's rules. Why: the link must never make unlock harder than it is without it.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, scalability, adversarial, integration, decision-completeness, lessons-aware, Astra, Gemini | 9 internal + 8 Astra + 3 Gemini | ~50 | all (redesigned mint, origin, capacity, unlock table). Standards-Conformance Gate: ran (6 flags; 3 addressed before freeze) |
| 2 | security, adversarial, integration, decision-completeness, lessons-aware, Astra, Gemini; scalability converged | 6 distinct internal + 8 Astra + 2 Gemini | ~45 | restart revocation, socket check, launcher, WSL routing, marker rule, tabs. Standards-Conformance Gate: ran (1 flag) |
| 3 | security (1); scalability, adversarial, integration, decision-completeness, lessons-aware converged; Astra 7 (5 outside this spec's scope), Gemini 1 | 1 internal | ~40 | pre-start replay, start-sweep after bind, no credential revival, residuals. Standards-Conformance Gate: ran (4 flags) |
| 4 | security (1, fixed); Astra 6 (4 outside this spec's scope, 2 repeats of addressed items) | 1 internal | ~10 | replay anchor at listen time, abused-marker row. Standards-Conformance Gate: ran (1 flag) |

The constitution flags in every round were Judgment Within Floors on fixed numbers; the decision-completeness and security lenses ruled each one a stated floor with an arbiter, not a defect.

## Full Findings Catalog

Every reviewer's full answer, per round, is kept in the build state folder (`.instar/state/identity-build-144636/reviews/p1a-r1` through `p1a-r4`), with the frozen subject and its hash for each round. The major findings and their resolutions are summarised in Original vs Converged above. Round-4 Astra items and their disposition:

- Contention and abused markers: abused-marker row added; capacity eviction is stated, an evicted grant costs one re-run.
- Listener identity through PIN entry: stated as a residual; authenticating the dashboard's listener belongs to pieces 4 and 6.
- Key and backup aliases: the directory, key and launch files are registered key material for the viewer, backups and sync; the key is refused if loosened.
- Restart and resource bounds: revocation runs only after this process holds the socket; all rows expire within 15 minutes.
- Authority/migration and team members/relay: outside this spec; they are pieces 1b-1f, which carry the round-5 findings of the larger spec.

## Proportion

Tier 2; spec ~170 lines; implementation ~1,200 lines across 9 source files plus tests. Four rounds of the six-round cap. Findings fell from 20 to 6 to 1 to 1 across internal reviewers; the last one was a one-line timing fix. Astra did not converge: its remaining items each round were mostly other parts of piece 1. A fifth round was not run (80/20 convergence: findings stopped dropping in kind, and the throwaway proof tests the fixed behaviour directly).

## Left behind

- Judgment Within Floors on the fixed numbers (10/10/8, 15 min, 60 s, 10 per 5 min, 250 ms, 30 min): each has a floor and an arbiter; Echo records measured launch-to-unlock times from the throwaway in the PR.
- Coverage `unknown` until proven: Linux desktop browsers, native Windows, the Mac app button (piece 3), WSL gateway acceptance (piece 1g).
- The prior-unlock cookie is not port-scoped: for the PIN-policy piece.
- `PinAttemptStore` starts empty on an unreadable file and keeps counting in memory on a failed write (as today).
- Old-generation budget keys are never cleared (one tiny entry per PIN change).
- Same-account programs can use up the verified-local budget; unlock then falls back to today's rules.

## Convergence Verdict

Converged at round 4. The last review round found one design item, fixed in the text with a test; nothing else in this spec's scope changes what gets built. The spec carries `approved: true` under the approved umbrella (Justin, 2026-11-17 19:34 PST, "approved, please enter a 24 hour autonomous session ... to build this") and Justin's standing guidance that only constitution changes need his approval. This spec changes no constitution text.
