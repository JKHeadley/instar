<!-- bump: patch -->
## What Changed

The Jev shadow row for `prompt-detect` now keeps its `producerCorrelationId` on multi-machine agents. The provenance validator only allowed letters, digits and `-`, but router-minted ids carry the pool machine segment (`d-m_03b30f-<uuid>`), so every real id was dropped and Jev answers could not be joined to PromptGate's terminal-input outcomes (0 of 77 rows on the Studio, 16 Nov). The validator now accepts `_`. Jev rows also record `jevServedModel`, the model name the Jev API answered with, beside the requested `jevModel`.

## What to Tell Your User

Nothing changes in how your agent behaves. A background measurement that compares a small helper model against the main one can now match its answers to what actually happened, which it could not do on agents running on more than one machine.

## Summary of New Capabilities

- Jev prompt-detect shadow rows join to their terminal-input outcome on multi-machine agents.
- Jev rows record the served model name (`jevServedModel`).

## Evidence

Studio provenance 16 Nov 02:22Z–18:55Z: 77 Jev `prompt-detect` rows, 0 with `producerCorrelationId`; real ids look like `d-m_03b30f-0a190cf4-…`. New unit test mints router and breaker ids with machine id `m_03b30f5b…` and asserts they survive `recordDecision`; the integration and e2e tests now run with that machine id and assert the persisted Jev row's id equals the incumbent/outcome id.
