<!-- bump: patch -->

## What Changed

Fixed a fleet-wide silent config drop: `sessions.componentFrameworks` (the
documented `.instar/config.json` surface for per-component framework routing —
"run my sentinels on Codex") was never copied from the config file by
`Config.load`, so the IntelligenceRouter's live read always saw undefined and
the file setting did NOTHING on every deployed agent since the feature
shipped. The loader now carries the field (object-typed values only; absent →
omitted, pinned by a no-phantom-field test), with an exact-gap regression test
that loads a REAL config file through `loadConfig()` — the path the feature's
original in-memory-config tests never exercised.

## Summary of New Capabilities

- **componentFrameworks file-config now works** — setting
  `sessions.componentFrameworks` in `.instar/config.json` (e.g.
  `{"categories": {"sentinel": "codex-cli"}}`) actually routes internal
  components after a server restart, as the docs always claimed.

## What to Tell Your User

Only if they previously tried per-component framework routing and concluded it
didn't work: it was a config-loading bug, now fixed — their config.json
setting will take effect after this update.
