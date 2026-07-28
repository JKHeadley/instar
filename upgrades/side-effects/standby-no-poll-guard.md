# Side-effects review — standby-no-poll Telegram guard

## What was happening (real-hardware, 2026-05-29/30)

Telegram allows exactly ONE `getUpdates` long-poll per bot token. instar's
**lifeline** owns that poll (it starts the server child with `--no-telegram` and
forwards updates). There was no awake/standby gate on the poll: EVERY machine's
lifeline polled unconditionally. So bringing up a second machine (the Mac mini,
for session-pool dogfooding) meant two lifelines polling the same token → a
permanent **409-conflict war** and nondeterministic delivery — roughly half of
Justin's messages were grabbed by the mini (where no one was watching), and the
409 churn also drove ~10-minute server restarts. This recurred repeatedly because
the only mitigation was operator discipline (`launchctl disable` the mini's
lifeline), which does not survive a reboot/re-pair — and crucially, deploying new
code to the mini by kickstarting its launchd job RE-STARTED its poller.

It was also a structural dead-end for the session pool: the mini can only JOIN
the pool when it runs under its lifeline, but the lifeline is also what polls
Telegram — so "in the pool" and "polling" were the same switch. You could not
have a non-polling pool member.

## The fix

A per-machine LOCAL config flag splits those two concerns apart:

- **`src/lifeline/telegramPollOwnership.ts`** (new) — pure
  `shouldOwnTelegramPoll(config)`: returns `true` by DEFAULT (flag undefined /
  `multiMachine` absent), and `false` ONLY when
  `multiMachine.telegramPolling === false`.
- **`src/core/types.ts`** — `telegramPolling?: boolean` on `MultiMachineConfig`.
- **`src/lifeline/TelegramLifeline.ts`** `start()` — gates
  `flushStaleConnection()` + `this.poll()` on the predicate. When suppressed it
  sets `polling=false` and logs it; the server supervisor (`supervisor.start()`),
  queue replay, and the restart-signal loop all stay OUTSIDE the gate — so a
  standby still runs the full server, joins the session pool, and drains its
  queue; it simply never opens the Telegram poll.

A standby machine sets `multiMachine.telegramPolling: false` in its OWN config.
Because the decision is a local read (no shared/git-synced coordination), a
credential-less standby — the exact case that broke the git-based approaches —
can honor it.

## Blast radius

- **DEFAULT-SAFE: zero change for every existing agent.** The flag defaults to
  poll. A single-machine agent (no `multiMachine` block, or the flag unset) takes
  the identical `flush → poll` path as before. Only a machine that EXPLICITLY
  sets `telegramPolling:false` is suppressed. Verified both directions by the
  pure-predicate unit test.
- **No new route / schema / hook / skill.** One new config field (optional,
  default-poll) + one new pure module + a gated branch in the lifeline. No
  migration needed: absent flag = poll = today's behavior. (A future
  auto-elect-the-poll-owner-on-failover enhancement could set it automatically;
  this v1 is the manual per-machine flag, which is what unblocks the pool.)
- **The suppressed branch is not a silent no-op** — it logs
  `Telegram polling SUPPRESSED (standby: multiMachine.telegramPolling=false)` so
  the state is visible in the lifeline log.

## Tests (tiering note)

`TelegramLifeline.start()` is not cleanly unit-instantiable (its constructor does
`loadConfig` + agent-registry + state-dir side effects), and this change adds no
HTTP route — so the honest tiering is **unit + source-wiring**, not e2e/integration:

- `tests/unit/lifeline/telegramPollOwnership.test.ts` — the pure predicate, BOTH
  sides of the boundary: default-true (absent / undefined / explicit-true) and
  false-only-on-explicit-false, plus null/undefined-config fail-safe. 5 cases.
- `tests/unit/lifeline/standby-no-poll-wiring.test.ts` — pins the wiring against
  source: the gate delegates to `shouldOwnTelegramPoll(this.projectConfig)` (+ the
  import); `flush`+`poll`+`polling=true` are INSIDE the enabled branch; the
  suppressed branch sets `polling=false`, logs SUPPRESSED, and calls neither
  flush nor poll; `supervisor.start()` and queue replay stay OUTSIDE the gate. 6
  cases.

11/11 green; `tsc --noEmit` clean.
