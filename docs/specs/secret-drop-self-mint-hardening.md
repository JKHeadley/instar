---
title: "Secret Drop self-mint hardening — only a caller that proves the agent's key can reach a session; unproven requests stay bounded and clearly marked"
slug: "secret-drop-self-mint-hardening"
author: "echo"
parent-principle: "Session Input Is a Principal"
status: approved
approved: true
approved-by: "echo-chief-of-staff as maintainer (message 20572847, 2026-11-16): no constitution text, revertible fix to existing behaviour, not a new user restriction; condition: a pre-update session that hits the new check gets a plain line saying what to do, never a silent failure"
review-convergence: "2026-11-16T23:05:00Z"
eli16-overview: "docs/specs/secret-drop-self-mint-hardening.eli16.md"
review-iterations: 10
review-report: "docs/specs/reports/secret-drop-self-mint-hardening-convergence.md"
frontloaded-decisions: 7
cheap-to-change-tags: 0
contested-then-cleared: 1
lessons-engaged: "Signal vs Authority; Testing Integrity (three tiers, both sides of each boundary); Security Fixes Keep the Experience Whole; Never Silently Cut the Data a Decision Depends On; Verify the State, Not Its Symbol; An Instar Agent Is Always a Multi-Machine Entity"
---

# Secret Drop self-mint hardening

> **Disclosure note.** The repository is public and this fixes an issue that is not yet
> installed. This document names the class of problem and the shape of the mitigation
> only. Routes, limits, field names, the exact places caller text reaches, and the
> reproduction are kept in the maintainers' private security ledger (SEC-049, SEC-050)
> until the fix is merged and installed, and will be added here afterwards.

## Problem statement

**Class:** untrusted caller-supplied text can reach an agent session, and can cause a
full-permission session to be started, through a Secret Drop route whose only
authentication is "the request arrived over loopback."

Loopback is not proof that the agent asked. Two kinds of caller who cannot read the
agent's key can satisfy it:

1. **A local process running as a different user**, and **a web page the owner visits**
   (browsers can be made to send requests to local services). **The fix closes these.**
2. **A local process running as the agent's own user** can read the key and already
   controls the agent. **Named residual**, not closed here. The boundary drawn is
   user/network, not owner intent (owner intent is separate work, SEC-018).

The same path also let each unproven request start a session, which is a quota and
session-cap exhaustion risk.

## Mitigation shape

Authority is **decided once, when the drop is created, and stored with it**. Every later
step, and every place that could reach a session, checks the stored class itself; none
re-derives it from the request.

1. **Browser-proof admission.** The keyless route refuses any request that looks like it
   came from a browser or through a proxy, and accepts only this machine's own loopback
   address at its own port. This stops web pages. It does not stop a local process; item
   2 handles that.
2. **Authority classes.** A drop is *master* (the caller proved the agent's configured
   key), *dashboard* (a scoped dashboard credential), *owner phone*, or *keyless*
   (anything else, including every drop created before this change). The rule is total
   and fails closed: with no key configured, nothing is master. The agent's own helpers
   present the key, as they already do on every other call, so the owner's normal
   experience is unchanged.
3. **Only master drops reach a session.** Only a master drop can deliver a "secret
   received" notice into a session, or start or resume one. Every such path checks the
   stored class itself. This removes both the injection path and the session-start flood.
4. **Keyless drops still work, marked.** A keyless request still gets a working paste page
   (phone links and agent-to-agent transfers keep working), because the pasted value can
   only be read back with the agent's key. It cannot name a conversation or a browser
   typing site (refused with a plain message), and wherever the agent lists or reads it,
   it is tagged "unverified origin".
5. **Untrusted text is encoded at every place the agent reads it**, for every drop, as
   quoted data it cannot close or forge; secret values themselves are never altered. The
   paste page uses context-correct HTML encoding and shows a fixed warning for keyless
   drops. Identifiers that could corrupt stored data, break line-based output, or be
   unsafe to place in a command are refused with a plain reason; ordinary names in any
   language are accepted.
6. **Notice files go to a private, owner-checked location**, and reading a value with a
   scoped dashboard credential asks for the existing PIN step-up.

**Deliberately left for follow-up work** <!-- tracked: CMT-1870 --> <!-- tracked: CMT-1871 --> (they improve
the experience and do not change whether the hole is closed): a cross-machine listing of
received drops, server-generated field ids for keyless drops, an origin marker on the
owner's phone and console lists (CMT-1870), and retiring the keyless route once pre-update
sessions are gone (CMT-1871). Unverified requests already have their own share of the
pending cap.

## Decision points touched

| decision point | classification | justification |
|---|---|---|
| Which authority class is this drop? | **invariant; basis: external-constraint; evidence: timing-safe match against the configured non-empty key; a valid scoped credential; otherwise keyless** | Deterministic, fails closed. Proves possession of a same-disk secret, not owner intent (SEC-018). |
| Is this request admitted to the keyless route? | **invariant; basis: enumerable-domain; evidence: the request carries none of the markers a browser or proxy adds, and addresses this machine's loopback at its port** | Proves "not a browser, not proxied", not "the agent's own helper"; item 2 does not rely on it for that. Unknown ⇒ refuse. |
| Is this identifier / text acceptable? | **invariant; basis: external-constraint; evidence: values that corrupt the stored object or break line-structured sinks** | Reject only those classes; ordinary text in any language is accepted. |
| May this drop reach a session? | **invariant; basis: enumerable-domain; evidence: the stored authority class is master** | Checked by every path that could reach a session, so an older stored record cannot slip through. |
| Does a peer's signed submit prove the peer's key? | **invariant; basis: external-constraint; evidence: signature verification against the pinned key** | Unchanged. A separate encoding issue is tracked as SEC-056. |

## Multi-machine posture

machine-local-justification: hardware-bound-resource

- **Machine-local by design:** the keyless route and its in-memory pending pages; the
  route admits only this host's loopback.
- **Unified:** every stored drop keeps its existing cross-machine sync (unchanged), so a
  drop received on one machine is retrievable on another and survives the loss of its
  machine. The stored authority class travels with it.
- **Not changed here:** deleting on one machine does not remove synced copies on peers
  (no revoke verb); tracked separately.

## Frontloaded decisions

1. **Ships enabled, not dark.** It is correctness hardening; `git revert` backs it out and
   old code ignores the new stored markers. Any shipped helper script it touches rides the
   existing template refresh on update (the build confirms, or adds a migration step).
2. **User-visible effects (Security Fixes Keep the Experience Whole):**
   - *Updated helpers:* none. Receipts, phone links and peer transfers unchanged.
   - *Malformed identifiers:* a plain refusal; ordinary names, including non-English,
     unaffected. The build confirms no in-tree caller is hit.
   - *A session started before the update, until it restarts:* no receipt notice,
     browser-typing requests refused with a plain message, its drops marked unverified.
     Pages, phone access, transfers and stored values work as before. Unavoidable: that
     helper cannot prove it is the agent, and treating an unproven caller as the agent is
     the vulnerability itself.
   - *Dashboard scoped-credential mode (dark today):* reading a value asks for the
     existing PIN step-up.
3. **The pre-update transient** lasts one session lifetime; it is reported to the agent in
   the response, not only in logs. No forced restart.
4. **The keyless route is kept for now**, since pre-update helpers can only use it;
   removing it would break them rather than degrade them. A follow-up commitment <!-- tracked: CMT-1871 -->
   removes keyless creation in a release at least 30 days later.
5. **Live-proof matrix** covers the dashboard's test request, updated and simulated-old
   helpers, the phone's "Ask for a secret", and peer transfers.
6. **Peer-transfer compatibility is a release gate.**
7. **No new owner-tap surface.**

## Maturation plan

- **Tests (three tiers, both sides of every boundary):** unit for admission, class
  decision (including records created before the change), validation, the encoder,
  values never in a notice, listing or log while retrieval stays byte-exact, and the
  notice-location checks; integration for each class end to end (keyless never notifies
  or starts a session; master still does), restart durability of the stored class, and
  the plain refusals; e2e that the route
  is alive on the production init path and refuses a browser-shaped request. Existing
  tests touching these paths are updated deliberately, never by loosening a gate.
- **test-agent-live:** a throwaway agent runs the full matrix, including a browser-shaped
  request and a peer transfer.
- **dev-agent-live:** merged and live on Echo; Echo's own sealed-handoff receipt works.
- **fleet:** normal release after the above pass.
- **dark-window / ladder:** none (no feature flag; test agent → dev agent → fleet is the
  gate).
- **Agent awareness:** one `src/data/awareness/` entry: drops without a notice are still
  retrievable by their reference; "unverified origin" drops are retrieved for the owner
  and never acted on.

## Left behind (accepted residuals)

- **Same-user local process:** not blocked; gains nothing it lacked (SEC-018).
- **No-key-configured state:** every key-gated route is open locally in that state; this
  spec makes no owner-only claim there (SEC-001).
- **A different-user local process** can still create keyless requests up to the existing
  overall cap on pending requests (a nuisance, pre-existing). It cannot reach a session,
  choose a typing site, or read values. If the agent deliberately lists or reads such a
  request, its wording is shown as quoted, unverified data.
- **An owner can still be shown a keyless page**, with the fixed warning; a value pasted
  there goes only to the owner's own store.
- **Prompt injection through verified drops** is reduced by encoding, not proven
  impossible.
- **A prompt-injected session holding the key** can still name any conversation
  (pre-existing).
- **Consumed values linger on paired machines** (pre-existing, tracked).
- **SEC-056** (signed-submit encoding): separate fix.

## Carriers for the follow-up work <!-- tracked: CMT-1870 --> <!-- tracked: CMT-1871 -->

The follow-up work <!-- tracked: CMT-1870 --> <!-- tracked: CMT-1871 --> in this spec and the commitments that carry it (frozen excerpts from the registry, 2026-11-16):

> **CMT-1870** — "Build the deferred <!-- tracked: CMT-1870 --> keyless-request improvements: a cross-machine listing of received drops, server-generated field ids for keyless drops (so no caller-written field name is shown to the agent), and an origin marker on the phone/console waiting lists."

> **CMT-1871** — "In a release at least 30 days after the Secret Drop self-mint hardening release is installed fleet-wide, remove keyless request creation (the bearer-free mint route and the helper fallback)."

## Open questions

*(none — converged at round 10; see the report)*
