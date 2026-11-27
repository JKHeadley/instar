# Side effects: the relay's A2A bridge keeps bounded, caller-scoped state (SEC-134)

In plain words: the relay forgets callers and conversation names it has not seen for a while, and a conversation name now belongs to the caller who used it.

Tier 1. Size: 1 source file (`src/threadline/relay/A2ABridge.ts`), 1 test file extended.

## What changes
- Rate limiter: empty windows are deleted; `check` reads without creating; a sweep at most once a minute drops keys whose newest event is over an hour old; a hard ceiling of 50,000 keys drops the oldest-inserted keys beyond it. Limits and their numbers are unchanged. Under a flood of new addresses past the ceiling, the oldest addresses' windows are forgotten first, which is the cost of a fixed memory bound.
- Caller address: the first `x-forwarded-for` entry is used only when `net.isIP` accepts it, otherwise the socket address. The header itself is still caller-supplied when the relay is reached without a proxy that overwrites it; trusting it only from a known proxy is a relay-wide follow-up (RelayServer derives addresses the same way), filed as its own finding.
- Context map: keyed by caller address (the same address the rate limiter uses), agent id and contextId. Max 10,000 entries, LRU eviction, 24-hour idle lifetime. Messages with no contextId (or an empty one) are no longer stored, since nothing can look them up. The unused reverse lookup (`getContextId`) is removed.
- A contextId must be a string of at most 256 characters; otherwise -32602 and nothing is forwarded.
- Behaviour a caller can notice: the same contextId from a different address (for example a client whose address changes between networks), or after 24 idle hours, or after eviction, starts a new thread (`isNewThread: true` in the forwarded metadata), as a first message does.
- Runs only in the relay process. Agents are unaffected until the relay is redeployed; no agent-side change, no state migration.

## Multi-machine posture
Relay process memory only; machine-local by design (one relay process holds its own in-memory bridge state, as before).

## Signal vs authority
Resource bounds and scoping on existing state. The contextId refusal is a size/type check on untrusted input.

## Rollback
Revert the commit and redeploy the relay.

## Tests
- `tests/unit/threadline/relay/A2ABridge.test.ts`: 32 pass, including 11 new SEC-134 cases (limiter forgets idle callers, sweep never lifts an active hour limit, key ceiling, checks create nothing, map cap and lifetime, contextless not stored, caller and agent scoping, thread kept for the same caller, bad forwarded address falls back, contextId refusal).

## Second-pass review

**Reviewer:** independent Claude reviewer subagent, two rounds. Round 1 concurred with notes: the forwarded caller address is client-supplied, so limiter memory was bounded only by time; the ELI16 omitted that an address change starts a new thread; three test gaps. All applied here (valid-IP check, 50,000-key ceiling, doc wording, five new tests). Round 2 concurred with no blocking items.

Recorded for the relay-wide follow-up: trust the forwarded header only from a known proxy and normalise address forms (for example an IPv4-mapped IPv6 address and its IPv4 form) at the same time. Under a flood past the ceiling, eviction is first-seen order and can drop one of an address's two windows; that is the stated cost of the fixed bound and adds nothing beyond what a forged header already allows.
