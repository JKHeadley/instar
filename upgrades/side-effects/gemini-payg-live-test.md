# Side-Effects Review — the user-role live test of the Gemini pay-per-use lane, and what it found

**Version / slug:** `gemini-payg-live-test`
**Date:** `2026-11-20`
**Author:** `Echo (build lane echo-gemini-payg-build, live-test builder)`
**Spec:** `docs/specs/gemini-payg-metered-lane.md` §8 "The run boundary" (Run 1 step 2: the user-role live test of the whole setup flow on the throwaway pair) and release check (b) (the holder-death drill); §4 (the no-echo transfer), §6 (lease echo, forwarding), §11 Setup flow. `docs/specs/live-user-channel-proof-standard.md` §4.4–4.6 (signed artifact, risk categories, BLOCKED rules, volatile scenarios on throwaway agents only).
**Tier:** 2 (money release path). Size: 3 new scripts, 1 new template script, 5 changed source/dashboard files, 4 new + 4 updated test files.
**Second-pass reviewer:** see the end of this file.

## Summary of the change

The lane was driven end to end AS THE USER on throwaway agents: two real `node dist/cli.js server start --foreground` processes in two temp homes, paired as one agent's two machines over the real mesh (a LAN rope; loopback ropes are refused by design), a fleet-default agent, a single-machine agent, a fake Google, and headless Chromium on the real dashboard. That found four defects in the shipped lane, fixed here, and produced two signed artifacts.

1. **The live-test runner** (`scripts/gemini-payg-live-test.mjs`, `scripts/gemini-payg-live-test-lib.mjs`, `scripts/gemini-payg-fake-google-preload.mjs`; all new, none shipped to agents as runtime code).
   - Throwaways are made with `instar init --expires-in 6h` under `$TMPDIR`, with an isolated `HOME`, a child environment that is an ALLOWLIST (no `ANTHROPIC_*`, `XAI_*`, … reaches a throwaway), a `secret-tool` shim that always fails (the vault uses its per-agent file key and never reads or writes the real OS keyring), a stand-in `claude` CLI that answers every evaluation with a fixed `{"fire":false}` verdict and spends nothing, and failing `codex`/`gemini`/`grok` shims. Tunnel, auto-update, feedback, dispatches and the Threadline relay are off.
   - The fake Google is a loopback HTTP server. A test-only `--import` preload points `fetch` for `generativelanguage.googleapis.com` at it, and refuses every other Google host. Production code has no base-URL setting and none is added.
   - The runner is the supervisor that respawns a server which exits on a restart request (what launchd / the lifeline does on a real agent); the exit itself is the server's own `ForegroundRestartWatcher` acting on the flag the commit wrote.
   - Scenarios are recorded with deterministic evidence through a `ScenarioMatrix` (PASS needs evidence; a failed check is a FAIL that stays FAIL; BLOCKED needs a known kind and reason and is refused for happy-path / channel-parity). The two artifacts are written with `LiveTestArtifactStore` into the holder's state folder, signed with the holder's machine key — the key its release recorder verifies with. `--record-into <stateDir>` writes the drill artifact into another agent's store signed with THAT agent's key (never the default).
2. **Fix: the Spend tab had no screen for the setup plan** (`dashboard/index.html`, `dashboard/spend-arming.js`). The card links to the Spend tab; the tab never rendered `gemini-payg-setup` or took its PIN. A panel now sits first under the Spend header, shown only while a proposal waits here and no door is set up. It renders the plan fresh on every open (`expectedProposalHash` = the persisted proposal), leads with the first-screen line, shows the server's text verbatim, commits `{planId, nonce, pin, proposalHash}` to `/routing-spend/money-layer/commit`, and after a scheduled restart says "no second PIN is needed" and reloads when the server is back. A plan used up or overtaken by another approval (`consumed`, `unknown-plan`, `source-state-drift`) never says "nothing has changed". Long unbroken ids and the 64-hex fingerprint wrap at 390 px (`overflow-wrap:anywhere`), and the panel is held to the screen width: on a phone the dashboard's header (pre-existing, dashboard-wide) makes the single grid column 520 px wide, so without the hold the first-screen line ran off the right edge at 390x844 (measured live; screenshot kept).
3. **Fix: the money layer failed its boot probe after every restart on a multi-machine agent** (`src/core/MeteredSpendGate.ts`). `liveKeyChecks` applied the lease self-fence to the reserved `PROBE_DOOR`; the lease input is the metered door's designation echo, unconfirmed at boot, so `runCapGateProbe` refused for the wrong reason (`lease-liveness-unconfirmed`) and the layer stayed `probe-failed` until an operator re-checked. The probe door (machine-local, $0.01 cap, no provider) is now exempt from the fence; every real door still self-fences.
4. **Fix: Gemini routes 408'd at the 30 s default** (`src/server/middleware.ts`). The `/intelligence/gemini` prefix (the second opinion, `/review`, and the loopback-only `/status` read, which is harmless at a long budget) and `/routing-spend/release-proof` get `GEMINI_PAYG_ROUTE_TIMEOUT_MS = 990 000` (above the transport's 900 s ceiling plus the 60 s forwarding allowance). Before, a forwarded call to a dead holder answered 408 instead of `holder-unreachable`, and any call longer than 30 s was cut off at the client while it ran (and was paid for) on the holder.
5. **Fix: the documented no-echo transfer had no target** (`src/templates/scripts/secret-set.mjs`, new; `src/commands/init.ts`; `src/core/PostUpdateMigrator.ts`). §4 names `secret-drop-retrieve.mjs … --run -- secret-set.mjs gemini_api_key_payg`; no such script existed. It reads stdin only, refuses a TTY, refuses any second argument (a value on argv), validates the key path, removes exactly one trailing newline, writes through `SecretStore.set`, prints only the key name and length to stderr. Installed by `init` and always overwritten by `migrateScripts` (migration parity).
6. **Read-only observability** (`src/server/geminiPaygGoLiveWiring.ts`): `GET /routing-spend/gemini-payg/release` on the holder adds `lease: { confirmedAgoMs, windowMs, confirmed }` — the gate's own self-fence input. The drill reads it to see the echo re-confirm after the holder returns. Nothing gates on it.

## Decision-point inventory

- Gate lease self-fence: now skipped for `PROBE_DOOR` only (refusal-only path; narrower than before for exactly one synthetic door).
- Request-timeout budget for three route prefixes (not a decision on money; how long the HTTP layer waits).
- Dashboard: whether to show the setup panel (`geminiSetupShouldRender`) — display only; the server renders and refuses.
- `secret-set.mjs` argument validation (refusal-only).

## 1. Over-block

- None added. The probe exemption removes a false refusal; the route budgets remove a false timeout.
- The setup panel hides itself when the release view says a door is set up; a holder whose release view cannot be read hides the panel (the operator can still reach the plan by the card's route). Acceptable: the card is the delivery.

## 2. Under-block

- `PROBE_DOOR` admits without lease confirmation. It has no provider, a $0.01 cap and is designated to the machine itself by `ensureProbeDoor`; an admit there cannot bill, because no provider or route calls out through that door (the reservation only books against its own $0.01 cap). `applyGoLiveSetup` refuses the probe door, so the lane's setup can never land on it.
- A 990 s route budget lets a hung forwarded call hold a request slot longer. The forwarding loop's own deadline (generate timeout + 60 s) still ends it first; the budget is only the outer wall.
- `secret-set.mjs` overwrites an existing value for the same key without asking (a re-mint replaces the key — the intended use). It cannot read or print anything.

## 3. Level-of-abstraction fit

The probe exemption sits in the gate's one self-fence check, next to the existing probe-door caller exemption. The timeout budget sits in the single override map. The dashboard helpers are pure functions in `spend-arming.js` (tested with JSDOM); the page only wires them.

## 4. Signal vs authority compliance

No new authority. The lease field is a read of the gate's existing input. The dashboard derives nothing from a form: the server's plan is shown and the commit carries only the plan identity, the PIN and the proposal hash. The runner's stand-in model is on throwaways only.

## 4b. Judgment-point check

The only LLM judgment touched is the Work Board B25 judge on the throwaway, answered by the stand-in model. Its own judgment is not under test and the artifact says so in the scenario's evidence (`b25Judge`). A money-approval card is not a spec-approval ask, so "no hold" is also the correct verdict.

## 5. Interactions

- Every pool agent with money on now passes its boot probe immediately (before: `probe-failed` until a manual re-check). That is the state the go-live (Run 2: `enforcementReady`) already assumed.
- Dashboard: one more panel on the Spend tab, hidden unless a proposal waits on this machine.

## 6. External surfaces

None on a real agent. The runner talks only to loopback/LAN throwaway processes and a loopback fake Google; it sends no message to any channel.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The live test loaded the served Spend tab at 390x844 and 1280x728 and asserted the first-screen line is inside the first screen and that the panel does not scroll sideways; the screenshots are kept with the run. The panel's words after each outcome are asserted in the matrix (wrong PIN, winner, the losing tab).

## 7. Multi-machine posture

The fixes are per-machine code. The drill proves the posture on a real pair: a dead holder ⇒ the non-holder answers `holder-unreachable`, holds stops for the spender, never spends; the holder back ⇒ the echo re-confirms and forwarding resumes.

## 8. Rollback cost

Revert the commit. The probe exemption's revert brings back `probe-failed` on pool agents after a restart (no money moves either way). `secret-set.mjs` stays on disk on updated agents until a later migration removes it; it is inert unless called.

## Class-Closure Declaration

- **defectClass:** `unbounded-self-action` — **closure:** `n/a` (negative declaration). No self-triggered loop is added: the src changes are a gate-check exemption (the `PROBE_DOOR` lease fence), request-timeout budgets, a read-only status field, an install step and a one-shot stdin vault-write script. The only restart involved is the existing operator-PIN commit route, unchanged. The respawning in this change lives in the test runner (it plays the supervisor for throwaway processes) and is bounded by the run itself.

## Spec deltas (recorded for the spec owner)

- §8 "Delivery" assumed a Spend-tab plan view that did not exist; it exists now (panel described above).
- §4's `secret-set.mjs` now exists with the stdin-only contract above.
- §8 "PROBE_DOOR is unaffected" is now true in code for the lease self-fence too.

## Tests

- Unit: `tests/unit/secret-set-script.test.ts` (new: stdin-only write, argv refusal, newline rule, migrator install), `tests/unit/spend-arming-gemini-setup.test.ts` (new: render, commit body, after-commit words, refusal words incl. the race, first-screen placement), `tests/unit/gemini-payg-live-test-lib.test.ts` (new: the matrix honesty layer, throwaway config, plan checks), `tests/unit/gemini-payg-money-model.test.ts` (probe passes with an unconfirmed lease while the metered door self-fences), `tests/unit/AgentServer-outbound-timeout.test.ts` (the three Gemini route budgets).
- Integration: `tests/integration/gemini-payg-go-live-plan.test.ts` (the release view's lease field: unconfirmed before the echo, confirmed after a peer answers; the non-holder names the holder).
- Live: `scripts/gemini-payg-live-test.mjs` — the run, artifacts and hashes are named in the PR body / builder report.

## Second-pass review

### Reviewer verdict (independent subagent)

**Verdict: CONCUR WITH CONCERNS.** I checked the code, not the description. **Probe exemption** (`MeteredSpendGate.ts:561`): the only caller of `gate.admit` with `PROBE_DOOR` is `runCapGateProbe`. `GeminiApiProvider` and `geminiPaygWiring` hard-code `GEMINI_API_DOOR`. On the caller-facing path, `callerAdmissionRefusal` refuses the probe door twice: the `probe` caller is reserved, and the door has no policy, which `RoutingSpendCapsStore.refuseIfReservedProbe` makes impossible to set. `applyGoLiveSetup` refuses the probe door and key. So no paid path or caller-named door reaches the exemption. Designation, freeze and cap validity still run for the probe, and every other door still reads `leaseConfirmedAgoMs()`. The new unit test fails without the fix: with the lease unconfirmed, the probe would refuse `lease-liveness-unconfirmed`. **Route budget**: `resolveRequestTimeout` matches the exact path or `prefix + '/'`, so siblings keep the default (pinned by the test). `meteredLaneRuntime.deadlineFor` is at most 900 s + 60 s = 960 s, which is under 990 s, so the forwarding deadline ends a forwarded call first. **`secret-set.mjs`**: reads stdin only and refuses a TTY or a second argument. Nothing goes to stdout, and stderr carries only the key path, the length and `err.name`. `SecretStore.read()` throws rather than mint a key when no master key is reachable, so a vault error never re-keys or empties the store. It uses the same dist resolution as `secret-get.mjs`. `init` installs it on both paths and `migrateScripts` always overwrites it. `src/templates` is in package `files`, and `lint-metered-secret-readers` is OK. **Release `lease` field**: a GET-only read behind `isDesignatedHere()`, try/catch to null. **Spend panel**: all server text goes through `el()`/`textContent`. The commit body is exactly `{planId, nonce, pin, proposalHash?}`. There is no second PIN prompt (the commit route schedules its own restart), and `/health.uptime` is in ms. **Runner**: throwaways live under `$TMPDIR` with an isolated HOME, an allowlisted env, a shimmed `secret-tool`/`claude`/`codex`/`gemini`/`grok`, and tunnel, updates, feedback and relay off. The preload swaps the lazily-read global `fetch`, which the transport uses. It refuses Gemini with no loopback origin and refuses every other Google host. The ScenarioMatrix fails a row that has no evidence, any throw, and a BLOCKED happy-path or channel-parity row. Unit runs: secret-set, spend-arming setup, live-test lib, money model and outbound timeout, 126/126 green. The `gemini-payg-go-live-plan` integration file is 9/9 green.

1. [minor] `dashboard/index.html:10224`: a forwarded render (`plan.forwarded === true`, from `wrong-machine` → `forwardSetupRender`) still shows the PIN box here. Committing it fails `unknown-plan`, and the panel then says "already used — may have just been approved from another tap", which is false. It is hard to reach, because a proposal is always built with `selfMachineId`. Fix: when `plan.forwarded`, show `plan.note` and no PIN row.
2. [minor] `dashboard/index.html:10222`: every Spend-tab open (and every arming-step reload) POSTs a fresh render. That spends the machine-wide `planRenderPerHour: 20` budget shared with the arming plans. Once it runs out, the panel shows the raw `plan-render-rate` code. Fix: reuse an unexpired `__gpSetupPlan` for the same `proposalHash`, or render on a "Show the plan" tap. Map 429 codes to plain words ("try again in a few minutes").
3. [minor] `dashboard/spend-arming.js:300`: the fallback puts the raw server code in front of the operator ("…: lock-not-held. Nothing has changed."). It also says "Nothing has changed" on a network failure (`Failed to fetch`) during a commit, which can be false. Fix: say "could not be confirmed — reload to see where it stands" for commit-time transport errors, and keep codes out of the visible text. `pin-lockout` also lands on "PIN was not accepted" (line 293). It should say to wait.
4. [minor] `src/templates/scripts/secret-set.mjs:46`: the comment says the key-path check "keeps a pasted VALUE in argv from being written as a key name". But a Google key shape (`AIza` + 35 `[A-Za-z0-9_-]`) matches the regex exactly. A key pasted as the single argument is then stored under itself, and the success line prints it to stderr. The argv exposure has already happened by then, but the echo puts the key in the transcript too. Fix: refuse known secret prefixes (`AIza`, `sk-`, `ghp_`, `xox`) and paths over ~64 chars, or print only the key-path length on success. Add the unspaced key to the refusal test. The TTY refusal is also untested.
5. [minor] `scripts/gemini-payg-live-test.mjs:122`: `XDG_RUNTIME_DIR` passes through to throwaways, and nothing isolates tmux. Throwaway servers therefore share the operator's real user D-Bus/systemd bus and the real tmux server (`/tmp/tmux-UID`). Fix: drop `XDG_RUNTIME_DIR` and set `TMUX_TMPDIR` to `ROOT/tmux`, as `localVerify/orchestrator.ts` does. Today nothing exploits it: `secret-tool` is shimmed, the systemd restart path is keyed on the isolated HOME, and session names are prefixed per project.
6. [minor] `scripts/gemini-payg-live-test.mjs:441`: `recordInto` re-signs the drill artifact with a real agent's key without checking `art.allPass`, and nothing in the artifact marks it as recorded from a throwaway pair. That is consistent with spec §8 row 4 ("run on the test-agent pair"), and the real recorder still refuses a non-all-PASS artifact. Fix: refuse to record unless `art.allPass`, and stamp `recordedFrom: <throwaway machineId>` into the artifact.
7. [minor] `src/server/middleware.ts:903`: the `/intelligence/gemini` prefix also gives `GET /intelligence/gemini/status`, and any future subpath, the 990 s budget. That is harmless for a loopback-only read, but this file's §"Summary" item 4 lists only `/review`. Fix: either list `/intelligence/gemini/review` explicitly instead of the prefix, or correct the description.
8. [minor] `src/commands/init.ts:959`: in `initExistingProject`, `installSecretSet` sits between `installSecretGet` and its "Created secret-get.mjs" line, and secret-set itself gets no "Created" line. Cosmetic.

### Folded after review

1. [minor] **Folded.** A plan rendered on another machine (`plan.forwarded`) shows its note and no PIN box (`dashboard/index.html`). Test: `spend-arming-gemini-setup.test.ts` "a plan rendered on another machine…".
2. [minor] **Folded (narrowed).** A render refused by the rate limit (`plan-render-rate`, 429, lockout) now reads "Too many attempts just now. Wait a few minutes…". Reusing an unexpired plan instead of re-rendering on every open is not done: the spec asks for a FRESH plan each time the page opens (preconditions re-run), and the plan budget is 20 an hour.
3. [minor] **Folded.** No raw server code reaches the operator. A commit whose answer was lost says "could not be confirmed … reload to see where it stands", never "nothing has changed"; a lockout says to wait. Tests added.
4. [minor] **Folded.** `secret-set.mjs` refuses a key path over 64 characters or shaped like a credential (known prefixes, or a long mixed-case alphanumeric token), without repeating it. The refusal test now includes an unspaced Google-shaped value (assembled at run time) and asserts stderr never contains it; the TTY guard is pinned ahead of the stdin read and the vault write.
5. [minor] **Folded.** The runner no longer passes `XDG_RUNTIME_DIR`, and sets `TMUX_TMPDIR` to a private folder under the run root.
6. [minor] **Folded.** `--record-into` refuses a drill artifact that is not all-PASS and stamps `recordedFrom` (throwaway holder machine id, run id, source content hash) into the copy it signs.
7. [minor] **Folded (description).** Summary item 4 now names the `/status` read the prefix also covers; the prefix stays, so any later Gemini sub-route that waits on a paid call is covered.
8. [minor] **Folded.** `initExistingProject` prints the secret-get line after its install and a "Created" line for secret-set.

After the folds the live test was re-run on fresh throwaways (see the builder report for the run id, artifact paths and content hashes).

