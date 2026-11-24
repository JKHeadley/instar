# Side-Effects Review — Permanent agent links (instar.sh/a), server and site

**Version / slug:** `permanent-agent-links`
**Date:** `2026-11-17`
**Author:** `echo`
**Second-pass reviewer:** `not required (no gate, sentinel, watchdog, session-lifecycle or messaging block/allow surface; the identity-proof design had two cross-family security reviews and six spec-review rounds)`

## Summary of the change

This adds an optional link that names an agent by its canonical identity (SHA-256 over its Ed25519 public key) and a page: `https://instar.sh/a#v=1&i=<id>&t=home|doc|conversation[&r=…][&c=…]`. Spec: `docs/specs/permanent-agent-links.md`, converged in 6 rounds and approved through the design approval.

Server side:
- `src/core/AgentLinks.ts`: the v1 grammar parser and builder, the strict identity read, and the proof transcript and signature.
- `GET /mobile/agent-link/identity` in `src/server/mobilePairingRoutes.ts`. It is device-signed and active-only, with a guest tier, an allowlist entry and evidence rows. It returns the id, the public key, and an Ed25519 signature over `instar-agent-link-proof-v1\n<id>\n<deviceId>\n<verified host>\n<nonce>`.
- `POST /agent-links` in `src/server/agentLinkRoutes.ts`. It is Bearer-only and returns `{url, appUrl}`, plus a `split-identity` warning built from the identity-coherence health.
- Config type `agentLinks.enabled`. It defaults to off, is read live, and is wired in `AgentServer.ts`.
- Awareness entry `src/data/awareness/agent-links.md`.
- Ladder entry `agentLinks`, set to `default-off-by-preference`.

Site side:
- A static `site/public/a/index.html` (a plain file, so the site build injects no script into it) with a same-origin `site/public/a.js`. It makes no network request and never redirects.
- AASA: `/a` and `/a/` for the iPhone app, and a new Mac app entry.

The app handlers (iPhone and Mac) are a separate change in the app repo, built against this spec.

**Size and effort:** about 12 files, about 900 lines including tests. Tier 2: identity and a published link format. 6 spec review rounds, with a flat one-item-per-round tail from round 3 on, stopped under the 80/20 rule.

## Decision-point inventory

- Link parser accept/reject (`parseAgentLink`, server and page): **add**. Pure syntax over a frozen finite grammar. An invalid link opens nothing.
- Identity route outcomes (off → nonce → verified host → identity → sign): **add**. Each step is a fixed refusal with no judgment involved.
- Identity file choice (`readLinkIdentity`): **add**. It is strict and refuses rather than guess, and it never writes.
- Device middleware (`DEVICE_ALLOWLIST`, `TEAM_ROUTE_TIERS`): **pass-through**. There is one new allowlisted GET at guest tier, and the middleware logic is unchanged.

---

## 1. Over-block

The parser refuses some links a human might consider valid:
- a `%`-encoded character other than `:` in `r`/`c`, such as an app that encodes every character;
- Slack conversation ids;
- topic ids above 2^53.

All of these are documented in the spec, and none is produced by the builder. The identity route refuses an agent whose `identity.json` is unusable even when the legacy Threadline file is fine (`identity-unreadable`). That is deliberate: it avoids serving an id peers don't know. The feature stays off for that agent until its identity is repaired.

## 2. Under-block

- A link holds no access, so a leaked link discloses only the agent id and page id, as the privacy statement says. A comment key also discloses its author key, so the builder includes it only when asked.
- The page's no-network guarantee depends on instar.sh serving the page unmodified. That is stated in the spec.
- Two agents running as the same OS user can read each other's identity file. This change leaves that unchanged; it is stated as out of scope.

## 3. Level-of-abstraction fit

The proof reuses the existing device-signature middleware for authentication and its verified host (`instarDeviceHost`), and it adds no second host-normalization rule. Identity is read through the existing validating reader (`readIdentityKeyFile`, with `repair:false`). The split warning reads the existing `IdentityCoherenceDetector.health()` rather than probing peers itself. Evidence goes through `featureEvidence`, the same log the pairing routes use. Nothing here re-implements an existing primitive.

## 4. Signal vs authority compliance

- [x] No — this change has no block/allow surface over agent behavior or information flow.

The only refusals are syntactic (grammar) and cryptographic (identity possession). A judgment at either point would itself be the vulnerability. The split-identity warning is a signal on the builder's answer and blocks nothing.

## 4b. Judgment-point check

No new static heuristic sits at a competing-signals decision point on the server. The app-side choice among several matching pairing rows is a judgment-candidate whose arbiter is the person, as declared in the spec's decision table. That choice lives in the app change, not here.

## 5. Interactions

- Adds one route to the device middleware's allowlist and team tiers. Existing routes are unaffected.
- The identity route signs with the agent's identity key under a domain-separated prefix that no other Instar signing format uses: not rotation, recovery, ASP or Threadline. It cannot act as a signing oracle, because callers choose only the 32-byte nonce.
- `featureEvidence` rows are keyed per outcome and device and limited to one per 60 s, the same window the pairing evidence uses.
- The identity read happens per request and never writes a file, so it cannot race the identity adoption or repair writers.

## 6. External surfaces

- A new public link format on instar.sh (`/a`). Its AASA file now names the Mac app id. The page is static, with a CSP of `connect-src 'none'`, and it does not redirect.
- Two new agent routes; the phone route is off unless `agentLinks.enabled` is true.
- No timing dependencies. The page works when the agent is offline (it only hands off to the app).

## 7. Multi-machine posture (Cross-Machine Coherence)

- **The identity** is unified across machines through the existing identity handover. This change stores no identity state. A machine with a split identity serves its own id, and the builder warns `split-identity` using the coherence detector's observed fingerprints; unknown peers produce no warning.
- **`agentLinks.enabled`** is machine-local config, like all config. If it is off on one machine, that machine's phone rows go `off`, and links resolve through machines where it is on.
- **Generated URLs** name the agent, never a machine, so they survive address changes and machines being added or removed. Whether a target exists on the machine the app picks is the target feature's own replication; that is documented in the spec's table.
- **Notices:** none emitted.
- **Durable state:** none on the server. App bindings are device-local, in the app change.
- **Status surfaces:** no `/status`, `/health`, `/capabilities` or `/channels` answer changes. Evidence is in `logs/feature-evidence.jsonl` per machine, which is the existing per-machine log.

## 8. Rollback cost

Set `agentLinks.enabled: false`. It is read live, so no restart is needed, and both routes then answer `agent-links-off`. Rows already bound in apps go `off` at their next refresh; until then a tap only navigates, and the server checks access. Reverting the site commit removes `/a` and the AASA entries. No data migration is needed and no state needs repair.

## Conclusion

The change is safe to ship dark. It is opt-in per agent, adds no block/allow authority, and every refusal is syntactic or cryptographic. The app handlers and the live proof follow in the app repo before the feature is called done.

## Second-pass review (if required)

Not required. See the header.

## Evidence pointers

- Unit: `tests/unit/agent-links.test.ts` (grammar vectors shared with `site/public/a.js` in `tests/fixtures/agent-link-vectors.json`, builder, strict identity read with each refusal, nonce, transcript, proof verify and refuse).
- E2E: `tests/e2e/agent-links-alive.test.ts` (production `AgentServer`, a real paired phone, the proof verifies over the phone's own transcript, a wrong host fails, Bearer gets 403, the builder works, off gives `agent-links-off`, one evidence row per outcome).
- Ladder registry tests: `feature-ladders-coverage`, `MaturationLadder`, `FeatureMaturationPlanGate-ladder`.
- Identity single-writer guard: `tests/unit/threadline/identity-single-writer.test.ts` names `core/AgentLinks.ts` as a read-only importer of the key-file module and asserts it reads with `repair: false` and has no write call (Local Verify fix 2026-11-18: the guard's fixed importer list had not been updated for the new reader).
- `tsc --noEmit` clean.

## Refresh against main

The merge keeps current server imports and adds the agent link routes. It preserves all current feature ladder entries and adds the existing default-off agent link entry. The independent review found no change to identity verification, bearer authentication, the signed-device requirement or the default-off setting. Focused checks passed: 53 unit, 4 HTTP and 3 production server tests.
