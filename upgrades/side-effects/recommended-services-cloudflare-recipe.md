# Side-Effects Review — Cloudflare fixed-address recipe (dark), the Cloudflare work done by the server

**Tier 2 by risk** (an API token stored in the vault; DNS and tunnel objects created in a Cloudflare account; this agent's tunnel block rewritten; a planned restart; possible money, gated on the person's yes), with second-pass review. Spec: `docs/specs/recommended-services.md` (catalog row `cloudflare-domain`, `wayIn`; Yes; No "Never strand the owner"; cost confirmed before buying). ELI16: `docs/specs/recommended-services-cloudflare-recipe.eli16.md`. Dark: the catalog row keeps `setupRecipe: null`; only a proving agent reaches it.

**Size:** 4 source files (1 new), 4 test files (2 new); about 230 lines of source. **Effort:** no spec rounds; 1 commit attempt expected.

## Summary

- `cloudflareDomain.ts` (new): `CloudflareApi` (verify token, zone by longest suffix, tunnel by name, create, run token, ingress, proxied CNAME put/delete, tunnel delete) over `realCloudflareApi` (token in the `Authorization` header only; every network failure is `undefined`/`unknown`, never a throw); `CloudflareSurface` (tunnel block read/write/restore, one public read, restart, port); `tunnelNameFor`, `validHostname`, `parseCloudflareSecret`, `CloudflareWork`.
- `recipes.ts`: `cloudflare-v1` (`secretName: 'cloudflare_domain'`, one JSON value: token + host name): brief (two account choices presented as good; price and yes before any purchase; sign-in and card through Secret Drop; the key route then the sync route; never a token on a command line); `verify` = a named tunnel configured AND `GET https://<hostname>/health` answers (unknown on silence; a refused stored token named); `sync` = the whole Cloudflare job, stops at the first refusal before any write, remembers its work, writes the tunnel block, requests a restart; `stop` = restore the previous block (quick when none), delete setup's DNS record and, only if setup created it, the tunnel; delete the value; forget; only when `setUpHere`.
- `recommendedServiceRoutes.ts`: the key route refuses a Cloudflare value `parseCloudflareSecret` cannot read (400, before storing) and refuses to replace a named tunnel the person had (`already-held`, mirroring Telegram's guard); `cloudflareWork` kept in the setup state (`setupState.ts` field, never with a token) so a switch-off undoes exactly that; `machineId` passed to recipes.
- `routes.ts`: the real surface: `realCloudflareApi()`, `ctx.config.tunnel` read once at boot so the block this process wrote or restored is remembered (`tunnelWrittenHere`), `writeConfigAtomic` through the pure `namedTunnelBlock`/`restoredTunnelBlock` helpers (relay and notice settings kept, `configFile` carried for a restore, never a token in the restored block), `fetch` of `/health` with an 8 s timeout, `ctx.requestSupervisedRestart`.

## Decision-point inventory

- `cloudflare-v1.verify` — add — pass/fail/unknown from one public read; `absent` only when no named tunnel is configured.
- key-route Cloudflare branch — add — refuses an unusable value; the existing `already-held` rule is unchanged.
- `sync` — add — fails closed at the first refusal; writes only after every Cloudflare step succeeded.
- `stop` — add — under the routes' existing way-in hold.

## 1. Over-block

- Host names must be lower-case with two labels or more; a name with a scheme, path or upper case is refused. The brief tells the session the form.
- A fixed address the person had (a named tunnel configured before setup, `absentBeforeSetup` not set) is never replaced, even when it does not answer: the key route answers `already-held` (second-pass finding; the first draft had no guard), so the setup session stops. Deliberate: a half-working address is the person's.
- A zone the token cannot see fails the sync with "No Cloudflare zone holds <name>"; a token scoped to the wrong zone is the usual cause and the brief names the permissions.

## 2. Under-block

- `verify` passes on any 200 from `/health` at the name. Another server answering at that name (a stale CNAME) would pass; the sync's own CNAME write makes that unlikely, and `/health` carries no identity to compare. Noted; the name is the person's and setup just wrote it.
- The run token is written into `config.json` as a plain value, exactly as a hand-configured named tunnel is today; the pairing migration moves config-held secrets to the vault later. Pre-existing shape.
- The restart is a request to the supervisor; if nothing picks it up, the named tunnel starts at the next restart and the check keeps reporting "does not answer yet". The row then reads as not working until then, honestly.
- The purchase path lives in the session (a browser), not in code: the brief's "never buy without the yes" is a session rule, like the other recipes' browser steps. The server never spends money.
- The switch-off runs while this server's own connector is still connected (the restart that stops it is the last step, because it ends the process), so Cloudflare **usually refuses** the tunnel delete; the person is told plainly that the tunnel (unused and free) stays in their account, and a later yes finds it by name. Only a DNS record setup created is deleted (`createdDns`); a record that already pointed at the tunnel is left.
- A second machine of the same agent gets its own tunnel name (`instar-<agent>-<machine>`), so two connectors never share one tunnel (Cloudflare would balance traffic onto a standby).

## 3. Level-of-abstraction fit

The Cloudflare API work, the config write and the restart are server work (a session must never edit `config.json` or hold the token outside one call); the sign-in and any purchase stay in the session's browser, where Secret Drop and the person's yes live; the existing `TunnelManager` consumes the block unchanged.

## 4. Signal vs authority compliance

- [x] No — no block/allow surface over content. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

- **Way in (`wayIn`):** the routes hold a switch-off until `otherRouteWorks('cloudflare-domain')` (a messaging channel); pinned by the integration test.
- **TunnelManager:** reads the block at boot; the recipe never touches the running tunnel, only the config and the restart request. The quick-tunnel provider and relays are untouched; relay/notice settings are carried over on write and restore.
- **Daily refresh:** `sync` is idempotent (finds the tunnel by name, updates the CNAME in place) and leaves an unchanged block alone, so the existing daily call writes nothing and asks for no restart; a changed run token or name is written and restarted into, once.
- **A corrected host name** (the key route allows a correction before the first pass): the second sync deletes the record setup made for the old name and keeps the first run's undo record (`previousTunnel`, `createdTunnel`), so a later switch-off still restores what the person had.
- **Offers:** the row becomes available only after the flip; dark here.

## 6. External surfaces

- Dark on the fleet.
- On a proving agent: a tunnel and a DNS record in a Cloudflare account; this agent's `tunnel` block written; one planned restart; possibly a domain purchase, only on the person's yes to a stated price.
- `POST /recommended-services/cloudflare-domain/key` (JSON value as plain text), `POST /recommended-services/cloudflare-domain/sync`.
- **Operator surface (Mobile-Complete):** yes/no on the confirm page; sign-in and card through Secret Drop; the host name and account choice in chat; nothing API-only.

## 6b. Operator-surface quality

The session's closing message gives the new address plainly; a refusal names the step (zone, tunnel, route, DNS, token) in one sentence.

## 7. Multi-machine posture

- The tunnel block is **per machine by design** (`machine-local-justification: physical-credential-locality`: a named tunnel's run token identifies one connector, and the name resolves to the machine running it); the parent spec names the address services this way. A second machine takes its own yes and gets its own tunnel name, so the two never collide.
- The choice and the stored value replicate through the existing ledger and secret sync; `cloudflareWork` is in the per-machine setup state beside the other machine-local fields.

## 8. Rollback cost

A revert removes the recipe, the key-route check and the surface; a tunnel block already written stays and keeps working (it is an ordinary named tunnel). Setup-state fields are ignored by older code. Cloudflare objects left by a reverted build are visible in the person's account and removable by hand or by a later switch-off.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: one restart request per sync or switch-off, both on a person's action through the routes or the existing daily refresh; every Cloudflare call is one bounded HTTP request with a 20 s timeout. Not a self-triggered loop.

## Found problems, triaged

- The first draft's `sync` requested a restart on every daily refresh → fixed in this change: an unchanged block is left alone (unit test pins it).
- The first draft stored the previous block's run token in the setup state (a second on-disk copy outside the vault) → fixed: `PreviousTunnel` carries no token, and a hand-made named tunnel is never replaced, so none is needed.

## Second-pass review

Independent read (reviewer subagent, 2026-11-08), tests run. API shapes confirmed against Cloudflare (zone lookup, `cfd_tunnel` create with `config_src: cloudflare`, configurations PUT, proxied CNAME to `<id>.cfargotunnel.com`, token in the header only).

**Concern raised:** (1) nothing enforced "a fixed address the person had is never replaced": `verify` failed without `absent`, setup started, the key route had no guard, and `sync` wrote over the person's block, while `configFile` was dropped so a credentials-file tunnel could not be restored; (2) `remember` overwrote the undo record on a corrected re-sync, losing the first `previousTunnel`/`createdTunnel` and orphaning the old DNS record. **Resolved:** the key route answers `already-held` for a pre-existing enabled named tunnel; `TunnelSettings` carries `configFile` and the restore helper writes it back; `sync` keeps the first run's undo record, deletes the superseded record it created, and `createdDns` is tracked so a pre-existing record is never deleted. Notes taken: the tunnel delete usually fails while the connector is up (said plainly to the person, and the ELI16 says the tunnel stays, unused and free); the previous run token is no longer written to the setup state; the tunnel name is per machine; the config-block logic is extracted into pure helpers with unit tests, and the real client's create, ingress, token and delete-order calls are pinned.
