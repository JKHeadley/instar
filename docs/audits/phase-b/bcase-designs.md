Genuinely need a focused B-case: 1 of 7. Misclassified: 6 of 7.

Read of "currently pass": an always-firing detector exits/returns violation for every scanned input. Under the current clean-repo lint/test controls I found, six of these would fail already, so they are not strictly missing a B-case for the "fires on everything" failure mode. They may still deserve smaller fixture-level B-cases for readability and precision. The one real gap is the reviewer ratchet: current tests prove errored reviewers abstain, but do not prove usable reviewer output is not tagged as abstained.

Controls run:
- Tree provenance: `git log -1 --format='%h %ci'` -> `2197591 2026-08-05 02:19:20 +0000`.
- CrashLoopPauser control: `grep -rl CrashLoopPauser src | wc -l` -> `4`.
- Clean detector controls all exited 0: `node scripts/check-capability-registry-read-model.mjs`, `node scripts/lint-no-direct-url-log.js`, `node scripts/lint-no-mainthread-cartographer-walk.js`, `node scripts/lint-no-unbounded-llm-spawn.js`, `node scripts/lint-no-unfunneled-tmux-literal-send.js`, `node scripts/lint-no-unfunneled-topic-creation.js`.

## 1. tests/unit/capability-registry-read-model-ratchet.test.ts

Misclassified: yes. This file is already a clean-repo allow assertion, not a positive-only violation fixture.

Violation detected: a non-producer/non-core source authority-consumes the advisory capability registry by fetching `/capability-registry`, calling axios on it, or using `capabilityRegistry.(admit|route|place|snapshot|classifyMachine)(...)`; the detector expression is at `scripts/check-capability-registry-read-model.mjs:15`, with exemptions at `scripts/check-capability-registry-read-model.mjs:16-17`.

Compliant form it must allow: the producer route in `src/server/routes.ts:2123` may define `router.get('/capability-registry', ...)`, and core classification/read-model internals such as `src/core/CapabilityRegistry.ts:303-330` may call `classifyMachine()` and `snapshot()`.

Would always-fire currently pass? No. The test executes the script at `tests/unit/capability-registry-read-model-ratchet.test.ts:6` and expects clean output at `tests/unit/capability-registry-read-model-ratchet.test.ts:7`; the script exits 1 when offenders exist at `scripts/check-capability-registry-read-model.mjs:22`. The clean control also exited 0 with "advisory surface has no authority consumers."

B-case assertion sketch: not strictly needed for fires-on-everything. Optional focused fixture:

```ts
expect(runCheckWithFixture("src/server/routes.ts", "router.get('/capability-registry', handler)")).toExit0();
expect(runCheckWithFixture("src/core/CapabilityRegistry.ts", "capabilityRegistry.snapshot()")).toExit0();
```

## 2. tests/unit/reviewer-fail-closed-ratchet.test.ts

Genuinely needs focused B-case: yes.

Violation detected: every registered reviewer must return `abstained:true` on a forced generic LLM error; the throwing provider is at `tests/unit/reviewer-fail-closed-ratchet.test.ts:28-34`, the registered classes are at `tests/unit/reviewer-fail-closed-ratchet.test.ts:36-46`, and the assertion is at `tests/unit/reviewer-fail-closed-ratchet.test.ts:55-61`. The special risk is override subclasses listed at `tests/unit/reviewer-fail-closed-ratchet.test.ts:65-75`, especially the manual catch in `src/core/reviewers/escalation-resolution.ts:148-167`.

Compliant form it must allow: a usable LLM response such as `{"pass": true, "severity": "warn", "issue": "", "suggestion": ""}` or `{"pass": false, "severity": "block", "issue": "x", "suggestion": "y"}` must produce a normal verdict without `abstained:true`. The base reviewer returns normal parsed results without an abstain field at `src/core/CoherenceReviewer.ts:237-244`.

Would always-fire currently pass? Yes, for the ratchet's intended invariant. The ratchet only drives forced errors and only asserts `result.abstained` is true at `tests/unit/reviewer-fail-closed-ratchet.test.ts:57-61`. Existing ordinary reviewer tests use valid JSON, for example `tests/unit/CoherenceReviewer.test.ts:392-395` and `tests/unit/CoherenceReviewer.test.ts:430-433`, but they mostly assert prompt/model behavior, not that `abstained` is absent. I also ran an absence control: `rg` found no `abstained` false/undefined or `not.toHaveProperty('abstained')` assertions in tests. Some pass/fail assertions constrain pass preservation for particular reviewers, for example `tests/unit/CoherenceReviewer.test.ts:657`, but not the abstain tag.

B-case assertion sketch:

```ts
const result = await reviewerWithValidJson.review(ctx);
expect(result.abstained).not.toBe(true);
```

For the table-driven ratchet, run at least all `REVIEWER_CLASSES` with a valid JSON response and assert no `abstained:true`; include a `pass:false` JSON case for any override that can otherwise preserve `pass` while tagging abstain.

## 3. scripts/lint-no-direct-url-log.js

Misclassified for fires-on-everything: yes, if the lint chain is part of current validation. It lacks a small fixture-level B-case, but a detector that flags every scanned source file would fail the clean lint run.

Violation detected: logging a literal credentialed URL or logging a risky URL variable without the redaction funnel; patterns at `scripts/lint-no-direct-url-log.js:29-33`, offender pushes at `scripts/lint-no-direct-url-log.js:55-58`, and failing exit at `scripts/lint-no-direct-url-log.js:63-68`.

Compliant form it must allow: logging a URL only after redaction, for example `src/commands/machine.ts:393` uses `redactUrlsInText(...)` for clone errors and `src/commands/machine.ts:459` logs `redactUrl(repoUrl)`.

Would always-fire currently pass? No, under `npm run lint`: `package.json:31` includes `node scripts/lint-no-direct-url-log.js`, and the clean control exited 0. An implementation that pushed every scanned line into `offenders` would exit 1 at `scripts/lint-no-direct-url-log.js:67`.

B-case assertion sketch:

```ts
writeSrc("ok.ts", "console.log(redactUrl(repoUrl));");
expect(run("node scripts/lint-no-direct-url-log.js ok.ts")).toExit0();
```

Note: the current script does not accept explicit files; a fixture B-case would first need a test seam or temp project root.

## 4. scripts/lint-no-mainthread-cartographer-walk.js

Misclassified for fires-on-everything: yes, if the lint chain is part of current validation. It lacks a focused fixture B-case.

Violation detected: in main-thread surfaces only, calls to `.staleNodes(`, `.loadIndex(`, `.freshnessHealth(`, or `.scaffold(` without a nearby `lint-allow-carto-heavy:` justification; forbidden files are at `scripts/lint-no-mainthread-cartographer-walk.js:46-55`, enforcement is at `scripts/lint-no-mainthread-cartographer-walk.js:68-94`, and the failing exit is at `scripts/lint-no-mainthread-cartographer-walk.js:96-100`.

Compliant form it must allow: bounded/snapshot request-path code, especially `src/server/routes.ts:7246-7255` reading the cheap snapshot and `src/server/routes.ts:7258-7262` using `root.tree.loadIndexBounded(byteCeiling)`. The script intentionally does not match `loadIndexBounded`, per `scripts/lint-no-mainthread-cartographer-walk.js:52-54`.

Would always-fire currently pass? No, under `npm run lint`: `package.json:31` includes `node scripts/lint-no-mainthread-cartographer-walk.js`, and the clean control exited 0. A rule that flags every forbidden file would exit 1 at `scripts/lint-no-mainthread-cartographer-walk.js:99`.

B-case assertion sketch:

```ts
write("src/server/routes.ts", "const loaded = root.tree.loadIndexBounded(byteCeiling);");
expect(runLint()).toExit0();
```

Also useful: assert an allowed justified heavy call passes when the same or preceding lines include `// lint-allow-carto-heavy: boot-only`.

## 5. scripts/lint-no-unbounded-llm-spawn.js

Misclassified for fires-on-everything: yes, if the lint chain is part of current validation. It has an A-case fixture but no focused B-case.

Violation detected: direct construction of `ClaudeCliIntelligenceProvider`, `CodexCliIntelligenceProvider`, `GeminiCliIntelligenceProvider`, or `PiCliIntelligenceProvider` outside the allowlist; provider class list at `scripts/lint-no-unbounded-llm-spawn.js:38-45`, allowlist at `scripts/lint-no-unbounded-llm-spawn.js:50-61`, pattern at `scripts/lint-no-unbounded-llm-spawn.js:66-69`, and failing diagnostic at `scripts/lint-no-unbounded-llm-spawn.js:120-135`. The current A-case fixture is `tests/integration/spawn-cap.test.ts:185-210`.

Compliant form it must allow: constructing providers inside the factory and returning them through `wrapForFunnel(...)`, for example `src/core/intelligenceProviderFactory.ts:139-144`, `src/core/intelligenceProviderFactory.ts:166-187`, `src/core/intelligenceProviderFactory.ts:192-199`, `src/core/intelligenceProviderFactory.ts:204-211`, and `src/core/intelligenceProviderFactory.ts:231-241`.

Would always-fire currently pass? No, under `npm run lint`: `package.json:31` includes `node scripts/lint-no-unbounded-llm-spawn.js`, and the clean control exited 0. However, the explicit fixture test at `tests/integration/spawn-cap.test.ts:186-209` would still pass if the explicit-file path flagged everything, so a focused B-case is still worthwhile beside that A-case.

B-case assertion sketch:

```ts
writeTmp("ok.ts", "const p = buildIntelligenceProvider({ framework: 'claude-code' });");
expect(execFileSync(node, [lint, okFile])).not.toThrow();
```

Optionally include an allowlisted factory fixture with `new ClaudeCliIntelligenceProvider(...)` at `src/core/intelligenceProviderFactory.ts` and assert it exits 0.

## 6. scripts/lint-no-unfunneled-tmux-literal-send.js

Misclassified for fires-on-everything: yes, if the lint chain is part of current validation. It lacks a focused lint-fixture B-case, though the funnel itself is well tested.

Violation detected: a source line containing both `send-keys` and a `'-l'`/`"-l"` flag without `buildLiteralSendArgs`; matching is at `scripts/lint-no-unfunneled-tmux-literal-send.js:55-61`, and the failing exit is at `scripts/lint-no-unfunneled-tmux-literal-send.js:65-75`.

Compliant form it must allow: chunking and funneling through `buildLiteralSendArgs`, for example `src/providers/adapters/openai-codex/control/inputInjection.ts:76-80`. The funnel builder itself intentionally emits `['send-keys', '-t', target, '-l', '--', chunk]` at `src/core/tmuxLiteralSend.ts:127-128`, and `tests/unit/tmux-literal-send.test.ts:85-89` asserts the expected argv shape.

Would always-fire currently pass? No, under `npm run lint`: `package.json:31` includes `node scripts/lint-no-unfunneled-tmux-literal-send.js`, and the clean control exited 0 after scanning 1629 files. A rule that flags every `send-keys` mention would exit 1 at `scripts/lint-no-unfunneled-tmux-literal-send.js:75`.

B-case assertion sketch:

```ts
writeSrc("ok.ts", "execFileSync(tmux, buildLiteralSendArgs(target, chunk));");
expect(runLint()).toExit0();
```

Also assert non-literal key sends pass: `['send-keys', '-t', target, 'Enter']`.

## 7. scripts/lint-no-unfunneled-topic-creation.js

Misclassified for fires-on-everything: yes, if the lint chain is part of current validation. It lacks a focused fixture B-case.

Violation detected: direct Telegram `createForumTopic` API invocation outside the allowlist, including `apiCall('createForumTopic')`, raw `/bot.../createForumTopic` URLs, or `{ method: 'createForumTopic' }`; allowlist at `scripts/lint-no-unfunneled-topic-creation.js:39-53`, patterns at `scripts/lint-no-unfunneled-topic-creation.js:58-65`, enforcement at `scripts/lint-no-unfunneled-topic-creation.js:97-121`, and failing exit at `scripts/lint-no-unfunneled-topic-creation.js:124-128`.

Compliant form it must allow: budgeted funnel calls like `this.telegram.findOrCreateForumTopic(...)` in `src/scheduler/JobScheduler.ts:1710-1717` and `src/scheduler/JobScheduler.ts:1731-1737`, or direct `TelegramAdapter.createForumTopic(...)` method calls through an adapter object rather than raw Bot API calls.

Would always-fire currently pass? No, under `npm run lint`: `package.json:31` includes `node scripts/lint-no-unfunneled-topic-creation.js`, and the clean control exited 0. A detector that flags every `createForumTopic` mention would fail on current allowed call sites and exit 1 at `scripts/lint-no-unfunneled-topic-creation.js:127`.

B-case assertion sketch:

```ts
writeTmp("ok.ts", "await telegram.findOrCreateForumTopic(name, color, { label: 'job-topics' });");
expect(execFileSync(node, [lint, okFile])).not.toThrow();
```

Also assert `await telegram.createForumTopic(name, color, { origin: 'user' });` passes, because the lint bans raw Bot API invocation, not the adapter funnel.

## Honest Input Check

I spot-checked more than the requested two by reading all seven files. The input is partially wrong:

- `tests/unit/capability-registry-read-model-ratchet.test.ts` already is a compliant-input allow check over the current repo: it expects the checker to print the clean message (`tests/unit/capability-registry-read-model-ratchet.test.ts:6-7`), and the checker exits nonzero on offenders (`scripts/check-capability-registry-read-model.mjs:22`).
- The five lint scripts are also constrained by the clean lint chain in `package.json:31`; I ran each clean control and all exited 0. That is an unusual broad B-case rather than a focused fixture-level B-case.
- `scripts/lint-no-unbounded-llm-spawn.js` has a positive fixture at `tests/integration/spawn-cap.test.ts:185-210`, but no focused compliant fixture beside it.
- `tests/unit/reviewer-fail-closed-ratchet.test.ts` is the real focused B-case gap: it checks forced-error abstains, but there is no direct assertion that valid reviewer output is allowed through without `abstained:true`.
