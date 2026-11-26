# Side-Effects Review — reject a quick-tunnel URL that is not an assigned hostname

## Summary of the change

`CloudflareQuickProvider` accepted whatever URL the `cloudflared` wrapper emitted
on its `url` event. Under Cloudflare rate-limiting the wrapper emits the API base
it was talking to — `https://api.trycloudflare.com` — which is not a tunnel: every
request to it answers `405` from Cloudflare's own API.

Accepting it made `TunnelManager` report `running: true`, `state: "active"` while
holding an address that could never serve a byte. The change adds
`isAssignedQuickTunnelUrl()` and rejects a non-conforming URL through the existing
`classifyError` path, so the lifecycle classifies the failure and backs off
instead of latching a false healthy.

**Found live, 2026-10-21.** Two operator links in a row were built on that dead
host — a private view, and a Secret Drop form requesting a payment card. The
operator would have tapped a dead link to hand over a credential. `GET /tunnel`
reported `state: "active"` while `lastFailureReason` already read `"rate-limited"`.

## Decision-point inventory

One: *is this emitted string an assigned quick-tunnel hostname?* Deterministic,
no model, no config.

## 1. Over-block

Could this reject a URL that would have worked?

The accept condition is: `https`, host ends `.trycloudflare.com`, exactly one
label before it, label is not `api`. Every real assigned quick tunnel has that
shape (`https://<words>.trycloudflare.com`). The only way to over-block is if
Cloudflare changes the assigned-hostname format — in which case quick tunnels
would be rejected rather than silently dead, which is the safe direction and
surfaces immediately through the existing rate-limit/back-off path.

`api` is excluded by name rather than by heuristic, so no legitimate assignment
can collide with it unless Cloudflare assigns a tunnel literally named `api` —
and that host is already taken by their API.

## 2. Under-block

Could a dead URL still get through? Yes, in principle: a URL with the correct
*shape* that nonetheless does not route (an expired assignment, a tunnel killed
after handshake). This check validates **form, not reachability**, and claims
nothing more. A reachability probe was considered and rejected for this change:
it would add a network round-trip to tunnel start, and the failure it would catch
is already covered by the manager's existing disconnect handling. The narrow,
observed bug is the one fixed.

## 3. Level-of-abstraction fit

The check sits at the provider boundary, which is where the untrusted string
enters the system. Validating at the point of entry means every downstream
consumer — `/tunnel`, private views, Secret Drop, the dashboard — inherits the
guarantee without each re-checking. Had this been placed in a link-building
helper instead, each new caller would have to remember it.

## 4. Signal vs authority compliance

This is **deterministic string validation holding blocking authority**, which the
signal-vs-authority standard permits: the rule is total and decidable, with no
inference step. `isAssignedQuickTunnelUrl` is a pure function of its input, and
its verdict is indistinguishable from the ground truth it claims ("is this the
shape of an assigned hostname") — it does not estimate reachability, which *would*
be an inference and therefore unsuitable for a block.

The authority it holds is also conservative: rejecting routes into an existing
failure path that already knows how to classify and back off. It cannot deny a
working tunnel, only refuse a malformed one.

## 5. Interactions

- **`classifyError`** — rejection flows through it, so a rate-limited start is
  still classified as rate-limited; the stderr tail is preserved and passed.
- **`TunnelLifecycle`** — now sees a failed start where it previously saw a
  successful one, which is the point. Back-off and fallback already handle this.
- **Relay/consent path** — unchanged. A genuinely failed tunnel can now reach the
  consent-gated backup relay, which it could not while falsely reporting active.
- **`tunnel.stop()`** is called before rejecting so the child process is not
  orphaned.

## 6. External surfaces

No API shape changes. `GET /tunnel` will report an honest failure state where it
previously reported a false active. That is a visible behaviour change for anyone
reading that endpoint — and the intended one.

## 7. Multi-machine posture (Cross-Machine Coherence)

Per-machine and self-contained. Each machine validates its own tunnel's URL; no
shared state, no lease interaction, no replication. A machine with a dead tunnel
now reports dead rather than active, which makes the *pool* view more honest too —
previously a peer could advertise a working ingress it did not have.

## 8. Rollback cost

Single file, one static method plus one guard clause. Reverting restores the old
accept-anything behaviour. No migration, no persisted state, no config key.

## Verification performed

- `tests/unit/cloudflare-quick-url-validation.test.ts` — 9 cases, all passing:
  the real-hostname accepts, the observed `api.trycloudflare.com` regression, the
  apex, multi-label hosts, two suffix look-alikes (`evil-trycloudflare.com`,
  `trycloudflare.com.attacker.test`), plaintext http, non-URL junk, and case
  handling.
- The look-alike cases matter specifically: a naive `endsWith('trycloudflare.com')`
  would accept `evil-trycloudflare.com`. The implementation checks
  `.trycloudflare.com` with the leading dot and requires a single label.
- Live evidence for the bug itself: `GET /tunnel` on this machine returned
  `{"url":"https://api.trycloudflare.com","lifecycle":{"state":"active",
  "lastFailureReason":"rate-limited"}}`, and `curl` against that host returned
  HTTP 405 with Cloudflare error 10005.
