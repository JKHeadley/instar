## What Changed

The benchmark predictions mirror now carries a `zombie-classify` entry, so the Benchmark-Divergence Detector has something to compare against for the second of its two enrolled decision points. It had been reporting `precondition-failed` for that pair since enrollment — correctly, since no baseline existed. Half the enrolled surface was measuring nothing.

## Summary of New Capabilities

- `GET /benchmark-divergence` can now produce a real verdict for the external-hog kill/leave classifier instead of a standing `precondition-failed`.

## What to Tell Your User

Nothing to do. This is internal measurement plumbing — the detector is observe-only, dev-gated, dark on the fleet, and gates nothing.

## Evidence

The baseline could not simply be re-run, because the existing case set was not testing the live decision.

**Prompt drift, and a shape change.** The benched template was 2029 chars against a live prompt of 1373. The old cases fed the model `pid`, `parentPid`, `cpuPercent` and `elapsed`. The live prompt carries seven derived booleans plus the matched allowlist class, and deliberately withholds the identity tuple — the model does not need it, and omitting it denies an injection payload a concrete target to name in its logged reason.

**Population mismatch.** Only an allowlist-matched candidate ever reaches a model: `identityFor` returns null otherwise and the scan tick surfaces the process without classifying it. Four of the eight original cases describe processes no model is ever consulted about.

The boundary is the allowlist match **alone**, not the whole floor — an easy thing to get wrong, and it was gotten wrong once during this work. `evaluateKillFloor` runs separately, and a kill requires `floor.permitted && verdict === 'kill'`. A candidate the floor will veto is still a real question put to a real model, and its answer still worth grading. Reading floor-veto as "never asked" would have silently deleted three legitimate cases.

**Two findings from the rebuilt set:**

One case is unpassable by construction. `buildClassifierPrompt` renders every boolean with `=== true`, so an *unknown* owner state and a *known-false* owner state both print `owner_app_running: false`. Two cases carrying opposite expected answers render byte-for-byte identical prompts. That is a defect in the prompt, not the models — logged as ACT-1212. It is harmless today: the floor vetoes an unknown required field outright (`field-unknown:ownerAppRunning`), so the model's answer there is never enacted. Which is precisely why it would never surface from outcomes.

All three models tested, across two families, recommend `kill` on a case whose fact block states plainly `sustained_high_cpu: false`. Also not enactable — the floor hard-vetoes on that exact fact. Also invisible from outcomes alone.

**Scored population** is the 10 `production-candidate` cases. Excluded and retained in the task file as evidence rather than deleted: 4 `floor-excluded` (no model consulted), 1 `invalid-unwinnable` (above), and 2 `contested-expectation` — cases authored expecting `leave` for argv describing work in flight, where every model answered `kill` and had the better argument, since reaching a kill requires an orphaned owner and a language server indexing for a closed editor is burning cores on results nobody will collect. Those expectations were withdrawn rather than scored; encoding them would have published a confident and false claim about model behaviour.

`gemini-2.5-flash` records `n=6` rather than 10 because four calls errored. Stamped as 6 rather than padded — the detector's noise-awareness only protects anything if the sample size it is given is true.

**Not changed:** the classifier prompt itself. Fixing the unknown-vs-false flattening alters the prompt hash and invalidates this baseline, so it belongs in its own gated change with its own re-stamp, not bundled here.
