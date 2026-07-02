<!-- internal-only -->
<!-- bump: patch -->

## What Changed

Ratifies six constitutional standards into `docs/STANDARDS-REGISTRY.md`, earned from the
2026-07-01 silent-Telegram-message-loss postmortem (operator-ratified, topic 29836):

- **A Refusal Stays a Refusal — conservation of negative outcomes** (Building): a terminal
  refusal/rejection/drop must stay distinguishable from success at every boundary; ack
  vocabularies name what was actually promised; a refusal affecting the verified operator
  is always loud.
- **Cross-Store Coherence Is an Invariant** (Building): any two stores answering the same
  question carry a declared, machine-checked agreement invariant.
- **Test Identity Never Enters Production State** (Building): live tests run in throwaway
  agent homes; fixture writes into real stores are refused structurally; durable-state
  touches open teardown obligations at write time.
- **A Dark Feature Guards Nothing** (Shipping): a load-bearing path depending on a
  dark/disabled feature forces a decision — graduate it or record accepted manual fallback;
  postmortems must ask which dark features would have prevented the incident.
- **Runtime End-to-End Proof — the canary standard** (Building): every critical
  user-visible outcome gets a synthetic full-path probe on a cadence; component liveness is
  never accepted as proof of outcome.
- **Session Input Is a Principal** (Substrate): extends Know Your Principal to session
  input channels — synthetic typers must be structurally distinguishable from the driver.

Also adds the postmortem the entries cite:
`docs/postmortems/2026-07-01-silent-telegram-message-loss.md`. Docs-only; no runtime change.

## Evidence

- Registry amendment follows the documented amendment loop (agent proposes with the story,
  operator ratifies — ratification 2026-07-01, topic 29836, decisions recorded per entry).
- Each entry names its enforcement arms honestly: live guards on the originating fleet
  (coherence audit, delivery canary, fixture-write guard) plus tracked upstream filings
  (fb-1e751537-655, fb-b15ac10b-85c, fb-dd043916-28f) for the structural layers; the
  conformance-coverage audit will classify the not-yet-landed guards as gaps by design.
- Side-effects artifact: `upgrades/side-effects/postmortem-standards-s1-s6.md`.
