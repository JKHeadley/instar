# Side effects: Cloudflare fixed-address recipe marked live-proven

**Tier 1.** 4 files changed, about 20 lines (catalog row, one unit test, one integration test, one e2e test). One review pass, one commit attempt expected. Proportionate.

## Summary
`src/recommended/catalog.ts`: the `cloudflare-domain` row changes `setupRecipe` from `null` to `cloudflare-v1`, with the live-proof citation in a comment. `isServiceAvailable()` is unchanged; it now returns true for this row on every agent. All nine catalog rows are now available. Live proof: 2026-11-16 16:49-16:58 UTC on a throwaway built from main 8bbc4f3db plus this row (yes with PIN, token via Secret Drop, tunnel + DNS created, server check pass from the public internet, independent 200, switch-off removed DNS record and tunnel and restored the quick tunnel).

## Phase 1: decision point?
Only in the narrow sense that availability decides whether the confirm page accepts a yes. No gate logic is added or changed; this flips the data the gate reads, on the evidence it was designed to wait for.

## 1. Over-block
None. The change only widens availability.

## 2. Under-block
When the temporary address is rate-limited, the yes page and the Secret Drop only open on the agent's own machine or over Tailscale (seen in both live runs). The agent says so plainly and offers the at-machine route; filed as fb-77724a08-a6a. Existing behaviour, unchanged here.

## 3. Level-of-abstraction fit
Right layer: the catalog is the single source of what is proven.

## 4. Signal vs authority
No new authority. The person's yes stays the only thing that starts setup; offers stay behind `recommendedServices.offers.enabled` (off by default).

## 5. Interactions
`offerTextHash` covers only person-facing text, which is unchanged, so no existing yes is invalidated. Setup rewrites the agent's `tunnel` block to a named tunnel and asks for a planned restart; a hand-made named tunnel is never replaced (existing recipe rule), and the switch-off restores the previous block.

## 6. External surfaces
Visible to users: the dashboard section and confirm page show Cloudflare as available. After a yes, setup creates a tunnel and a proxied DNS record in the person's Cloudflare account (or buys a domain only after a priced yes).

## 7. Multi-machine posture
The catalog is code, identical on every machine of a version. The tunnel name carries the machine id (`tunnelNameFor`), so each machine gets its own tunnel; setup state is machine-local by design because the tunnel runs on that machine.

## 8. Rollback cost
Revert the one line (hot-fix release). A person who already set it up keeps a working address; the switch-off route remains.
