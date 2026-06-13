# WS5.2 account follow-me security — plain-English overview

## What this is

You run several subscription logins (e.g. multiple Claude accounts) pooled on one
machine. "Account follow-me" is the seamless idea that an account you enrolled on
one machine should be usable by the same agent on your other machines, so you
never re-set-up per machine. Because that borders on **credentials/logins crossing
machines**, the parent multi-machine spec deferred it to a dedicated security
round — this is that round (CMT-1413). It is a **spec for review, not a build**;
no credential-bearing code is authorized by it.

## The key realization

instar's subscription pool deliberately stores each account's login **location**
(its config-home), **never a token**. So "follow-me" is really **two separate
things that must never be conflated**:

- **(A) Registry follow-me (metadata only):** a redacted projection — id, nickname,
  email, provider, quota/status — replicates so a peer machine knows the account
  exists and how loaded it is. The config-home path is stripped (it's meaningless
  on another machine, and shipping it would invite the exact "just point at the
  path" leak the boundary forbids). Cheap, always-on.
- **(B) Actually having a usable login on the other machine:** the default and
  only ships-now-eligible mechanism is **re-mint per machine** — the operator
  drives a fresh enrollment (phone-first device-code/URL, never a pasted token)
  on the recipient, pre-authorized by a mandate. **Credentials are re-minted per
  machine, never transported.**

## The contradiction it caught and resolved

The convergence found a **direct, load-bearing contradiction** in the codebase:
the subscription-pool source header says a future sync will "ship each account's
credential blob over E2E secret-sync," while the parent spec says "OAuth
config-homes never cross machines." The spec resolves it authoritatively: the
parent-spec invariant wins for Anthropic — follow-me defaults to re-mint; the
"ship the credential blob" path survives only as a **second mechanism (A),
default-OFF, behind a per-provider allowlist with Anthropic excluded** (Anthropic's
ToS prohibits relocating Claude OAuth tokens). A build-round obligation requires
the contradicting source comment to be corrected in the same PR that wires any
follow-me path, so the two documents stop disagreeing.

## Safeguards in plain terms

Threat-modeled: a compromised/added peer harvesting a credential, a forged "enroll
this account" instruction, replay to a de-authorized machine, credential residue
after de-pairing, confused-deputy quota abuse, and headless-enrollment phishing.
Enrollment is operator-initiated and PIN/mandate-authenticated — a peer can never
enroll an account onto itself over the mesh. Phase-C clean: headless enrollment on
cloud VMs, no LAN/2-peer assumption, bounded per-account budget.

## What you actually need to decide

When ready: approve this spec (discharges the CMT-1413 WS5.2 deferral) or send it
back; and note that the actual build's first PR must be the hardened-envelope +
grant/epoch primitives with NO live-credential wiring (prove the mechanism before
any credential path exists). The flag `multiMachine.accountFollowMe` stays
reserved-dark until then. Sealed-credential transport stays default-off and
Anthropic-excluded unless you explicitly allowlist a non-Anthropic provider.
