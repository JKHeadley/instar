# Side-effects review — WS5.2 Account Follow-Me operator code paste-back

Spec: `docs/specs/ws52-code-paste-back.md` · ELI16: `docs/specs/ws52-code-paste-back.eli16.md`
Parent principle: Operator-Surface Quality (constitution → Interaction family)

## What the change is

The account-follow-me `url-code-paste` login is a two-part flow: (1) the operator opens the
verification URL and authenticates, (2) the provider hands back an authorization code that must
be pasted into the waiting `claude auth login` process. The dashboard card surfaced part 1 but
had no field for part 2, so the operator (live proof 2026-06-18) ended up routing the code through
Telegram and the agent relayed it by hand. This adds: a code field on the card, a target-local
route that types the code into the waiting pane and drives to a real outcome, and a fronting relay
so the operator's single dashboard hands the code one authed hop to the machine owning the pane.

Files: `src/server/routes.ts` (two routes + per-login mutex), `src/core/FrameworkLoginDriver.ts`
(shared `enrollPaneSessionName` helper), `src/commands/server.ts` (use the shared helper),
`dashboard/subscriptions.js` (code field + `wireCodeSubmit`). Tests: route integration,
render unit, controller-wiring unit, helper unit.

## 1. Over-block — legitimate inputs rejected that shouldn't be

The code-shape validation rejects any value containing whitespace or control chars. Some users
paste a code with surrounding whitespace — handled: the **client trims** leading/trailing
whitespace before submitting, and the server validates the trimmed value, so harmless surrounding
whitespace is tolerated; only embedded whitespace/control chars (which would break pane input) are
rejected. The validation is reject-unsafe, not enumerate-allowed (FD11), so unusual but valid
provider code charsets (punctuation, URL-safe base64) are accepted.

## 2. Under-block — failure modes still missed

- A genuinely malformed but whitespace-free code is accepted and typed into the pane; the provider
  rejects it and the login stays open. Mitigation: the client surfaces an honest "re-tap the
  sign-in link" message on a non-validated outcome; no false "done".
- If the pane reconstruction were wrong, the code would go nowhere. Mitigated structurally: the
  pane name is derived through the single shared `enrollPaneSessionName` helper used by BOTH the
  spawn and this route (cannot drift), plus a pane-existence check (409 if not waiting).

## 3. Level-of-abstraction fit

Correct layer. The routes sit alongside the existing `/subscription-pool/follow-me/enroll/*`
routes and reuse the proven follow-me machinery: the S7 email-gate (`completeFollowMe`) is the
account validator, `SubscriptionPool.add` the sink, `resolvePeerUrls()` the cross-machine hop,
`SessionManager.sendInput` (already argv-safe) the pane delivery. No new subsystem; the only new
shared primitive (`enrollPaneSessionName`) de-duplicates a formula that previously lived in two
places.

## 4. Signal vs authority compliance

No brittle blocking authority added. The routes are dev-gated (503 when off) and deny-by-default
via the existing enroll gate. They carry **no new credential-returning authority**; they add a
**narrow paste-back authority** (typing the operator's own single-use code into the operator's own
login) bounded by: dev-gate, Bearer-auth, the `url-code-paste` kind guard, the pending-login
lookup, the pane-existence check, the single-token code-shape validation, and the per-login
in-flight mutex. The actual account-acceptance decision remains the S7 identity-oracle email gate
(unchanged) — file-existence is only a trigger, never the validator.

## 5. Interactions

- Reuses `completeFollowMe` → identical email-gate behavior as the existing complete route
  (validated/held/HIGH-attention-on-mismatch). No new account ever bypasses S7.
- The per-login in-flight mutex prevents two rapid submits from interleaving into one pane; the
  client also disables the button on submit (defense in depth).
- A successful submit removes the pending login (via `completeFollowMe`), so a replay is a 404 —
  one-shot by construction, layered on the provider's single-use code.
- No shadowing/double-fire with the reissue/complete sweep: on poll-timeout the route returns
  `submitted` and the existing sweep finishes the login (the route does not duplicate that path).

## 6. External surfaces

- New dashboard UI element (code field + Submit button) on the Subscriptions tab pending-login
  card — operator-facing, off-chat. No raw internals exposed (login id / machineId are
  de-emphasized data attributes, not displayed). Operators act in taps + a single paste.
- The OAuth authorization code travels over the Bearer-authed API + authed mesh hop ONLY, never
  any chat/messaging surface. It is never stored or logged (value redacted; only a greppable
  terminal-outcome key is logged).
- No change visible to other agents.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local execution, proxied-on-WRITE by design (FD9). The login pane is inherently
machine-local (a tmux pane on the target's disk). The operator's SINGLE fronting dashboard calls
the relay; the relay forwards one authed hop to the pane's owning machine via `resolvePeerUrls()`
(self → loopback). No durable state is introduced that could strand on a topic transfer (the only
state is the existing `PendingLogin`); no URLs are generated that must survive a machine boundary;
an offline target returns an honest 502, never a false ok. Single-machine agents: the relay calls
local — a no-op difference.

## 8. Rollback cost

Cheap. The feature is dev-gated (`multiMachine.accountFollowMe`) and dark on the fleet. Back-out
is reverting the four source files; no data migration, no persistent schema, no agent-state repair
(the only state touched is the existing transient `PendingLogin`, unchanged in shape). The static
dashboard JS is served from disk per-request, so a client revert needs no restart.

## Cross-model review note

Codex (gpt-5.5) reviewed across rounds: round 1 surfaced 6 findings (pane-name drift, code
escaping, replay/one-shot, authority framing, weak completion oracle, UX code ambiguity) — all
addressed (shared helper, code-shape validation, kind guard + login-removal one-shot, S7-as-
validator clarification, client copy). Round 2 surfaced MINOR refinements (concurrent-submit
mutex, explicit charset/cap, client trim, "submitted"-is-success-pending, authority wording) —
all addressed (mutex code + FD10–FD12 + Decision-Points rewording). Gemini degraded (timeout) and
is recorded as such. The Standards-Conformance Gate flagged Observability (addressed via the
greppable terminal-outcome log).
