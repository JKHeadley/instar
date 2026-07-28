# Side-Effects Review — Skip WHATWG fetch-blocked ports in agent port allocation

**Version / slug:** `fix-fetch-blocked-ports`
**Date:** `2026-06-02`
**Author:** `echo`
**Tier:** 1 (small, low-risk; ELI16 + side-effects, no converged spec)
**Parent principle:** Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions

## Summary of the change

Instar's multi-machine mesh does ALL cross-machine I/O over node's global `fetch`
(pairing `POST /api/pair`, lease broadcast/pull, heartbeat). Node's `fetch` (undici)
throws `TypeError: fetch failed { cause: 'bad port' }` for any URL whose port is on the
WHATWG Fetch spec "bad ports" list. The default agent port-allocation range (4040–4099)
**contains 4045** (NFS `lockd`, a blocked port), so the allocator could hand an agent a
port on which it can **never** be reached over the mesh — silently, because `curl`
ignores the blocklist so the endpoint looks healthy.

**Observed live (2026-06-02):** a freshly-paired throwaway test agent landed on 4045 and
could not be joined — `instar join` failed with "fetch failed" despite `curl` to the same
`/api/pair` returning 400. Moving it off 4045 fixed the join instantly.

### What changed
- `src/core/AgentRegistry.ts`: added `FETCH_BLOCKED_PORTS` (the WHATWG bad-ports set) +
  exported `isFetchBlockedPort(port)`. Both `allocatePort` and `allocatePortByName` now
  skip blocked ports (in addition to used + lsof-busy ones).
- `src/commands/server.ts`: an unconditional startup warning when `config.port` is a
  blocked port — the migration-parity path for EXISTING agents already on one (the
  allocator guard only protects newly-allocated agents).

## Decision-point inventory
- allocator: skip vs allocate a port → skip if on the blocklist (the check precedes the
  lsof probe, so it's deterministic).
- startup: warn vs silent → warn (loud, non-fatal) when an existing config sits on a
  blocked port; we do NOT auto-re-port (that would change a running agent's port — left
  to the operator).

## 1. Over-correction risk
The blocklist is the fixed WHATWG set; legitimate agent ports (4040–4044, 4046–4099, etc.)
are unaffected. Only 4045 falls in the default range. Skipping reduces the usable range by
one port — negligible (60→59).

## 2. Under-correction risk
Existing agents already on a blocked port aren't auto-fixed (that would change their port);
the startup warning surfaces it so the operator re-ports. Acceptable — auto-re-porting a
live agent is riskier than a loud warning.

## 3. Level-of-abstraction fit
The skip lives in the single port allocator both callers use; the warning at the single
server-start path. No scattering.

## 4. Signal vs Authority
Pure deterministic check against a fixed spec list — no LLM, no heuristic. Appropriate.

## 5. External surfaces
None. No route/config-schema change. `isFetchBlockedPort` is a new pure export.

## 6. Interactions with existing primitives
The allocator's existing used-port + lsof checks are unchanged; the blocklist is an
additional AND condition. The warning composes with the existing startup logs.

## 7. Rollback cost
Trivial: remove the `&& !FETCH_BLOCKED_PORTS.has(port)` clauses + the warning. No state.

## Migration parity
- New agents: allocator skips blocked ports (no action needed).
- Existing agents on a blocked port: the startup warning surfaces it (operator re-ports).
- Pure code; reaches existing agents on the normal dist update. No config/hook migration.

## Tests
`tsc --noEmit` clean. 34 `agent-registry` unit tests green, including 3 new: `isFetchBlockedPort`
both sides of the boundary (4045/6000/6697/2049 blocked; 4040/4046/4050/4099 not),
`allocatePort` throws rather than return a sole blocked candidate, and `allocatePort` skips
a blocked port to return the next usable one.
