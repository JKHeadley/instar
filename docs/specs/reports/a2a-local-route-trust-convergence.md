# Convergence Report — A2A local-route trust

## Cross-model review: codex-cli:gpt-6-astra (RAN — one round)

One review round, as scoped for this small fix (tracking action ACT-056):

- The Standards-Conformance Gate (92 standards), run three times: on the first draft and after each revision.
- One external GPT-tier review through the agent's codex CLI (`gpt-6-astra`), verdict MINOR ISSUES.

No internal reviewer subagents ran. The round stopped under the 80/20 convergence standard: the remaining findings are limits the change cannot remove, and they are stated in the spec.

## ELI10 Overview

Two agents on the same computer can hand each other messages directly. That direct route treated every sender as a known agent. The relay route checks a trust list and turns away agents that are not on it. So an agent that the relay check would turn away could still get in through the direct route.

The fix makes the direct route read the same trust list and apply the same rule. Because most agents on one computer have never been added to each other's lists, switching the rule on at once would stop conversations that work today. So it starts in watch-only mode on development agents: every message is still delivered, and each one that would be turned away is logged and counted. Refusing starts only when someone turns watch-only mode off.

## Original vs Converged

- **The trust level told to the receiving session.**
  - First draft: the resolved level, whatever it was.
  - Converged: the resolved level, never above `verified`. The route cannot prove who is sending, so a caller that claims a trusted agent's name must not be described to the session as more trusted than the route describes everyone today.
- **What `wouldRefuse` means.**
  - First draft: "working traffic that enforcing would stop".
  - Converged: "attempts the trust check would refuse". It is counted before the duplicate checks, so the log lines that name the sender are what the rollout acts on.
- **How the two routes relate.**
  - First draft: "the two routes on one machine give one answer".
  - Converged: for one fingerprint profile and one operation, the direct route when enforcing and the relay gate give the same answer. They can still pick different profiles, and the direct route honours a grant by name, which the relay gate does not. Both differences are stated.
- **What happens after a refusal.**
  - First draft: the sender falls back to the relay, "where the relay gate applies the same rule".
  - Converged: the relay leg is judged again under the relay's own rules and may accept the message. This was measured: a first-contact relay sender skips the relay gate, is passed as `verified` and gets a `verified` profile. An end-to-end test now covers the fall-back, and a second one covers a stale registry entry.

## Findings and what was done

| Source | Finding | Outcome |
|---|---|---|
| Standards gate | Know Your Principal: trust is granted from a caller-claimed name or fingerprint | Partly fixed: the stated level is capped at `verified`, and the spec shows the check can only remove admission. The claim itself stays unauthenticated; see below. |
| Standards gate | Multi-machine: the decision is machine-local | Posture rewritten with the concrete reason (loopback-only route, one trust manager per machine shared with that machine's relay gate, standby is a counted no-op). The gate still flags it; see below. |
| Cross-model | `wouldRefuse` does not measure working traffic | Fixed (reworded; rollout acts on the log lines). |
| Cross-model | The route-parity invariant was too strong | Fixed (narrowed; the name step documented as an intended difference and tested). |
| Cross-model | Refusal conservation across the fall-back needed an end-to-end case | Fixed (two e2e cases; the spec states that relay acceptance after a local refusal is permitted). |

## Second-pass code check (after the build)

An independent reviewer subagent read the code and the side-effects artifact and concurred with no blocking findings. Its six non-blocking findings were all fixed in the build and are reflected in the spec: the name step no longer reaches a fingerprint-keyed profile by display name; an unusable body `type` is refused as the relay gate refuses it; a sender named after an object built-in no longer throws; the asserted fingerprint is lower-cased for the lookup; and the 403 body no longer carries the trust level.

## Still open after this round (disclosed, not hidden)

1. **The direct route cannot prove the sender.** The standards gate still marks "Know Your Principal" as a possible violation and rates the parent-principle fit "weak". That is accurate. A caller that can read this agent's token file and names a peer the agent trusts avoids the refusal. Before this change every caller avoided it, so the change narrows the exposure and adds none. Closing it needs a signed envelope on the direct route, recorded on ACT-067.
2. **Trust profiles are per machine.** The gate still marks the multi-machine standard as a possible violation. The check reads whatever its machine's trust manager holds and adds no store of its own, so replicating trust profiles is a change to the trust manager, not to this check. A relay standby has no trust manager and is a counted no-op.
3. **The relay's first-contact branch.** Found while testing this change: a relay sender whose keys are not yet known skips the relay gate and is passed as `verified`. This spec leaves it unchanged and records it on ACT-056.

## Approval

Approved for building under the operator's standing approval for the agent-comms track (2026-10-06 18:57, Telegram topic 122413: "Yes, I approve. Please don't let me be the bottleneck here.").
