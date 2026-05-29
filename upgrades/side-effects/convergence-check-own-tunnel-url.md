# Side-Effects Review — Convergence Check Own Tunnel URL Allowlist

**Version / slug:** `convergence-check-own-tunnel-url`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required by tooling`

## Summary of the change

This change updates the shipped `convergence-check.sh` template so URL provenance accepts the agent's own configured tunnel hostname and Cloudflare quick-tunnel hosts while preserving unfamiliar-domain blocking. It adds unit coverage in `tests/unit/convergence-check.test.ts` for configured tunnel URLs, quick-tunnel URLs, and missing-config fallback.

## Decision-point inventory

- `convergence-check.sh` URL provenance check — modify — deterministic pre-message quality gate deciding whether a URL host is familiar enough to send without warning.

---

## 1. Over-block

This reduces the observed over-block where self-generated Secret Drop and private-view links on the agent's tunnel were classified as fabricated. Remaining over-block: if an agent serves a user-facing link through a tunnel hostname that is not in config and is not a Cloudflare quick-tunnel hostname, the check may still flag it.

---

## 2. Under-block

The under-block risk is allowing a bad URL on the agent's own configured tunnel host. That risk is bounded because the hostname belongs to the agent's server, and the path still points back to this agent rather than an arbitrary external domain. A random unfamiliar domain still flags.

---

## 3. Level-of-abstraction fit

This is a deterministic structural check over URL host provenance, so the shell pre-message gate is the right layer. It does not try to judge message meaning; it only distinguishes known host classes from unknown host classes.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no conversational block/allow surface.

This is a hard provenance invariant, not a semantic judgment. The check stays narrow and deterministic: exact configured host, loopback, known public domains, and Cloudflare quick-tunnel hosts.

---

## 5. Interactions

- **Shadowing:** This runs before the server-side tone gate. It only prevents false URL-provenance blocks before the message reaches the tone gate.
- **Double-fire:** No double action. The convergence check either passes or reports a warning; normal message delivery then proceeds.
- **Races:** The script reads config at send time. If the config is temporarily absent or malformed, it falls back to existing behavior.
- **Feedback loops:** Positive loop: agents can use Secret Drop and private views instead of less safe credential or report-sharing workarounds.

---

## 6. External surfaces

Users can receive self-generated tunnel links for Secret Drop and private views through the normal messaging path. Other unfamiliar URLs are unchanged and still flagged. Existing agents receive the fix because PostUpdateMigrator overwrites the convergence-check template during migration.

---

## 7. Rollback cost

Rollback is a normal hot-fix revert. No data migration or state repair is required. During rollback propagation, agents may again over-block their own tunnel links.

---

## Conclusion

The change is clear to ship. It addresses the observed Secret Drop and private-view false-positive without broadly weakening URL provenance.

---

## Second-pass review (if required)

**Reviewer:** `not required by tooling`
**Independent read of the artifact:** `not required`

---

## Evidence pointers

- `tests/unit/convergence-check.test.ts`
