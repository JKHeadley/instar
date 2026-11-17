# Convergence Report — The Instar Mac app creates the agent and becomes its first trusted device

## Cross-model review: codex-cli:gpt-6-astra

A real outside review ran through the agent's Codex CLI (GPT-6 Astra) in rounds 1 to 4. The first attempt in round 1 failed (`degraded: error`) because the agent home's built reviewer asked for a retired model (`gpt-5.5`); it was rerun from this worktree's fresh build, which maps to `gpt-6-astra`. Gemini was not signed in (`gemini-not-authed`).

## ELI10 Overview

Today a person who wants an Instar agent has to run a command in a terminal, install Node and tmux themselves, and then pair their phone through a web address and a code. This spec lets the Instar Mac app do all of it. The person presses **Create my agent**, picks a name and their AI account, signs in once in the browser, and a few minutes later the window is a chat with their new agent.

Two things make that possible. The Mac app downloaded from instar.sh runs outside Apple's sandbox, so it can set up Node, tmux and Instar in the person's own folder and run the existing installer. And the agent gets one new, tightly limited way to accept its first owner device: a one-time ticket that only the Mac's owner can read, used only from the same Mac, only within 30 minutes, and only while the agent has no owner device yet.

The tradeoff is a new route on the agent's server. It is closed on every existing agent (it answers "not found" unless a fresh ticket exists), and anything that could use it could already change the agent's files directly.

## Original vs Converged

- **The credential.** Originally the route trusted the agent's main token plus "the request came from this Mac". Reviewers pointed out the token alone does not prove who is asking, and proxy headers are not guaranteed. Now a one-time ticket file (readable only by the Mac's owner) is the credential, the app proves it holds its device key by signing the request, and the same-Mac check runs before anything touches the ticket.
- **Who calls it.** Originally the installer called the route. But the app's device key lives in the Secure Enclave and cannot leave the app, so only the app can sign. Now the installer leaves the ticket and the app enrolls itself.
- **Getting stuck.** Originally a success whose answer was lost would look like "this agent already has an owner" and leave the person with no way forward. Now a retry with the same key gets the same device back, a crash between the two writes is rebuilt from the ledger row, and `install --app-ticket --key` hands out a fresh ticket for the same key.
- **No half-made devices.** Originally the device was created pending and then approved, and a pending record can expire on restart. Now it is written active in one registry write, after the ledger row.
- **Damaged files.** A registry that cannot be read is now an error, never "no devices".
- **Machine binding.** A loopback address is the same on every machine, so the record also carries the machine id when the agent has one, and the record itself never leaves its own machine.
- **The app's own robustness.** Every wait has a cap, a quit at any point can be continued with the same key, Node is checked against a fingerprint before use, Instar counts as installed only after npm finished and the CLI answered, and only one setup runs at a time even across a force-quit.

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 0 (gate)  | Standards-Conformance Gate: ran (7 flags) | 7 | 0 | ticket, machine binding, refusal stays refusal, brakes on every wait, dark by construction, rollback keeps existing devices |
| 1         | internal security/integration; codex | 1 internal + 3 codex | 0 | ticket-only credential, app enrolls itself, same-key recovery, durable activation, exact paths, wording |
| 2         | internal; codex | 3 internal (already fixed in this round) + 3 codex | 0 | single active write, ledger-row rebuild, `--app-ticket`, same-Mac before ticket, pause/cap not applied |
| 3         | internal (converged, 8 details); codex | 0 internal + 3 codex | 0 | strict registry read, revocation check on retry, setup resume and lock, all 8 details |
| 4         | codex | 2 codex (app-side) | 0 | npm completion marker, child-aware setup lock, rollback wording |

Internal reviewers ran on Claude Opus 5.5 (this session's model). The Standards-Conformance Gate ran once, before round 1.

## Proportion

Tier 2 (security-sensitive: a new way to add an owner device). Spec about 150 lines; 4 review rounds against a cap of 6. The design findings narrowed every round (authentication model, then crash recovery, then file-level durability, then the app's own process handling), so the rounds were spent on real problems.

## Left behind

None. Every finding was applied.

## Full Findings Catalog

**Gate (Standards-Conformance, 7):** Judgment Within Floors (rate-limit number) → kept as a resource floor, justified. No Unbounded Loops → every wait capped with backoff. A Refusal Stays a Refusal → owner-device-exists is a failure, never done. Verify the State → machine id added; registry locality stated. Know Your Principal → ticket proves file ownership. Maturation Path → dark by construction (404 without a ticket); test agent first. UX reachability → kill switch stops only new enrollments.

**Round 1.** Internal: (DESIGN) lost success strands the person → same-key retry returns the device; (DETAIL) absent role means owner; the authenticator branch must run before `ownNames` and never fall through; deviceKind should not carry access; machine id may be null; ledger replicates, registry does not; reuse `hasForwardingHeaders`; app pins loopback origin; ticket write/expiry details. Codex: (DESIGN) resume after success; durable activation; exact install paths; (PRECISION) port-443 wording.

**Round 2.** Codex: (DESIGN) `localBinding` not persisted by create-then-mutate → one-write `createActiveLocalOwner`; pending records expire → no pending state; no ticket refresh after completion → `install --app-ticket`. Internal: same three, plus (DETAIL) ticket checks before same-Mac leak and allow burning failures → reordered; pause and pending cap do not apply; answers-file field names; `forApp` must survive `--resume`; decision table said "bearer".

**Round 3.** Codex: (DESIGN) damaged registry read as empty → strict read, 503, no write; retry ignores ledger revocation → revocation checked first; interruption before the installer starts → saved answers, staged Node, setup lock. Internal (converged): rebuild must keep the first-owner check and revoke an orphan row on refusal; label and machine id for the rebuild; ledger-unavailable leaked before the same-Mac check; `--app-ticket` scope; revoked app needs a new key; local devices get no notification token; 4 KB body parser; app handling of 429.

**Round 4.** Codex: (DESIGN, app) `cli.js` existing is not proof npm finished → completion marker after npm exit 0 and `--version`; a force-quit can leave npm or the installer running → the lock records the child and a new copy stops it first; (PRECISION) rollback wording on `--app-ticket`.

## Convergence verdict

Converged at round 4. The last internal read found nothing that changes what gets built, and the last outside read raised two app-side robustness points that are now in the spec; no finding is left behind. Spec is ready for approval.
