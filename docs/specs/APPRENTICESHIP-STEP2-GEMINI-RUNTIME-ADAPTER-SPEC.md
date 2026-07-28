---
title: "Apprenticeship Step 2 — Gemini CLI Runtime Adapter (keystone Face 1)"
status: draft
tier: 2
parent: APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
parent-principle: "The Body and the Mind"
step: 2
approved: true
approver: justin
approved-at: "2026-06-02T06:22:00Z"
approval-basis: "Justin pre-approved all specs for the 12h autonomous run (topic 13435, 2026-06-01); full /spec-converge + codex cross-model ran (converged, codex-cli:gpt-5.5); Justin reviews after the fact."
author: Echo
date: 2026-06-01
topic: 13435
slug: APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC
companion: APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.eli16.md
eli16-overview: APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.eli16.md
builds_on:
  - APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md
  - APPRENTICESHIP-STEP0-RETRO-HARVEST-SPEC.md
review-convergence: "2026-06-02T06:21:55.509Z"
review-iterations: 2
review-completed-at: "2026-06-02T06:21:55.509Z"
review-report: "docs/specs/reports/APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC-convergence.md"
cross-model-review: "codex-cli:gpt-5.5"
---

# Apprenticeship Step 2 — Gemini CLI Runtime Adapter

**Parent:** `APPRENTICESHIP-PROGRAM-PROJECT-DESIGN.md` (Tier-3 umbrella, approved 2026-06-02)
**Parent principle:** **The Body and the Mind** — the runtime adapter *is the body* for a new
framework. A framework can only become an Instar agent once its body exists; the agent-facing
layer (the "mind" surfaces: Attention Queue, Coherence Gate, Playbook, etc.) is *already built*
and framework-agnostic. Onboarding a framework therefore is **not** re-building the mind — it is
building the body that lets the existing mind run on a new substrate.
**Step:** 2 of 5 — the **keystone Face 1** of the apprenticeship (the umbrella's §"Step 2").
**Author:** Echo · **Topic:** 13435 · **Companion ELI16:**
`APPRENTICESHIP-STEP2-GEMINI-RUNTIME-ADAPTER-SPEC.eli16.md`

> **The gemini meta-lesson, stated up front.** The single biggest meta-lesson from onboarding
> Codex (proven 2026-06-01, `proven_codex_full_parity`): *the real work of onboarding a framework
> IS the runtime adapter* — process spawn, the hook-stdout contract, native-loop autowiring,
> context/compaction-signal synthesis, native-module/ABI concerns — **NOT** the agent-facing
> layer. Codex reached **full agent-facing parity** with zero new agent-facing code; all five
> primitives (Attention Queue, Coherence Gate, Playbook, Tunnel/Dashboard, Codex-usage) worked
> the moment the adapter underneath them spoke Codex's surface. This step is the *first executable
> proof* of that meta-lesson for a second non-Codex framework: stand up the Gemini CLI body, and
> the existing mind comes along for free.

> **Convergence note (round 1 → v2).** Code-grounded reviewers found that v1 built its
> framework-registration surface map from `ls src/providers/adapters/openai-codex/` — the *adapter*
> directory — rather than from the actual framework-aware codebase. That produced two structural
> errors this version corrects: (1) v1 **missed the silent-failure surfaces** — the
> framework-blind code paths (resume, recovery-verification, process-detection) that a new framework
> breaks *without a compile error*, which are exactly the codex-harvest landmines the apprenticeship
> exists to engage rather than re-discover; and (2) v1 **overclaimed compiler-enforcement** — only
> the `never`-exhaustive switches keyed on `IntelligenceFramework` are compiler-forced; the ~10
> parallel hardcoded `'claude-code' | 'codex-cli'` unions are silent fall-throughs that must be
> hand-audited. v2 adds §4.0 (framework-monitoring surfaces the codex onboarding had to fix), a
> drift canary (§4.0.4) that converts the silent-failure surfaces into test-forced ones, an explicit
> hand-audit list (§4.3), corrects the registry-vs-`buildIntelligenceProvider` path confusion (§3.2,
> the registry adapter is dormant — the alive proof flows through a new `GeminiCliIntelligenceProvider`
> class), hardens security (§3.3, §3.8: yolo-mode pinning, unconditional billing-key delete, output
> cap, hooks-observe-only-by-default), promotes the hook-contract/normalizer to required canaries
> (§5, §13), and either scopes-in or names the native loop driver (§9). Full changelog: §15. Every
> file:line in this version is verified against the live tree (see §4.0a for the path corrections).

---

## 1. Problem

The apprenticeship's mentee is **Gemini CLI** (umbrella §"Roles"). Before Codey can mentor Gemini
through real Instar work — and before Echo can run the differential overseer loop on Gemini's
streams — Gemini must actually be able to *run as an Instar agent*. Today it cannot:

- `IntelligenceFramework` is the union `'claude-code' | 'codex-cli'`
  (`src/core/intelligenceProviderFactory.ts:28`, verified). There is no `'gemini-cli'` member, so the
  live intelligence path (`buildIntelligenceProvider`, `:68`) cannot name Gemini, and there is no
  `GeminiCliIntelligenceProvider` class (the codex equivalent `CodexCliIntelligenceProvider` exists
  at `src/core/`) for it to construct.
- There is **no** `src/providers/adapters/gemini-cli/` adapter. (Note the nuance the v1 spec missed:
  the provider registry is **dormant in production** — `server.ts` (~`:2432`) registers no adapters,
  so `registry.resolve(...)` is the parity-harness surface, not the live call path. The adapter still
  must be built — it's the stub-vs-real authority and the future-routing target — but the *alive*
  gap is the missing `GeminiCliIntelligenceProvider`, not registry registration. See §3.2.)
- **A new framework silently breaks several framework-blind code paths — without a compile error.**
  Resume (`ThreadResumeMap.jsonlExists:353`), rate-limit + compaction recovery-verification
  (`RateLimitSentinel:475`, `CompactionSentinel:444`), and process-detection
  (`frameworkProcessSignals.ts:89`) all hardcode Claude/Codex layouts and fall through to a wrong/
  default path for any unknown framework. These are the **codex onboarding landmines** the
  apprenticeship exists to engage up front (§4.0) rather than rediscover in production — they are the
  single most important class of work this spec adds over v1.
- The plumbing that DOES already exist is partial and tantalizing: `detectFrameworkBinary('gemini')`
  is already wired in `src/core/Config.ts` (the `FrameworkBinary` union at line 117 includes
  `'gemini'`, and the known-location probe at line 171 checks `~/.gemini/bin/gemini`, both verified);
  `FRAMEWORK_SHADOW_FILES` already maps `gemini-cli → GEMINI.md` (`IdentityRenderer.ts:40`); and
  `route.ts:47` `KNOWN_FRAMEWORKS` even lists `'gemini-cli'` already — but its `resolveFramework`
  (`:57`) has no gemini branch (silent fallthrough), and the `cli.ts:313,348` arg-parse allowlists
  actively **reject** `gemini-cli`. So a few pieces land for free, several are half-wired traps, and
  nothing *consumes* binary detection because the union, the provider class, and the adapter don't
  exist.

Gemini CLI itself is present and working on the dev box (verified facts, do **not** re-derive):

- **v0.25.2 at `/opt/homebrew/bin/gemini`, authed (`~/.gemini`).**
- One-shot transport **verified**: `gemini -m gemini-2.5-flash "<prompt>"` → clean stdout, exit 0,
  stderr line `Loaded cached credentials`.
- Surfaces (from `gemini --help`): positional / `-p` one-shot; `--resume latest|N` +
  `--list-sessions` + `--delete-session`; `gemini hooks <cmd>` (a **native** hook subsystem —
  unlike Codex's strict single Stop-hook); `gemini mcp`; `-y/--yolo` + `--approval-mode
  default|auto_edit|yolo`; `-m/--model`; `--experimental-acp` (Agent Client Protocol).

So the binary works one-shot today; what's missing is the **adapter** that turns that binary into
a registered Instar provider with capabilities, observability, and control primitives — the body.

This step builds a **minimal-viable Gemini CLI runtime adapter** that (a) registers the framework
through the existing 6 extension points, (b) implements transport + config + capability declaration,
and (c) implements the *buildable* observability/control primitives (event normalizer, hook
receiver via native `gemini hooks`, session resume, compaction synthesis). It does **not** claim
full behavioral parity — that is sequenced as ongoing apprenticeship work (§9, §11).

## 2. Goals / Non-goals

**Goals**

- **G1 — Framework registration + the framework-blind surfaces.** Add `'gemini-cli'` to
  `IntelligenceFramework`, wire the registration points (§3.2), **fix the framework-monitoring
  surfaces a new framework silently breaks (§4.0)**, and discharge the §4.3 hand-audit of the ~10
  parallel hardcoded unions the compiler does *not* catch — so every framework-aware path names and
  routes to Gemini without a silent fall-through.
- **G2 — Transport (the ALIVE path).** A `GeminiCliIntelligenceProvider` class (constructed by
  `buildIntelligenceProvider`, the live path — §3.2) wrapping a one-shot that spawns the verified
  **canonical argv** `gemini -m <model> --approval-mode default -p <prompt>` (§3.3 — the
  `--approval-mode default` pin is part of the canonical form), closes stdin, env-allowlists +
  **unconditionally deletes the Google/Gemini billing vars** (Rule-1a precedent), byte-caps output,
  and returns the trimmed final message.
- **G3 — Config.** A `gemini-cli` adapter config: binary detection via the existing
  `detectFrameworkBinary('gemini')`, a model map (`resolveModelForFramework` extension), timeouts.
- **G4 — Capability declaration.** An honest `capabilitySet` that declares **only** what is
  implemented — declared-but-stubbed is a capability-declaration lie under the parity harness's
  stub-vs-real check (the same rule the Codex adapter follows, `openai-codex/capabilities.ts`).
- **G5 — Buildable observability/control primitives + drift canaries.** Event normalizer (with
  required `geminiEventNormalizerCanary`), hook receiver leveraging native `gemini hooks`
  (**observe-only by default**, with required `geminiHookContractCanary`), session resume via
  `--resume`/`--list-sessions`, and a compaction-signal synthesizer.
- **G6 — "Feature is alive" proof.** An agent configured `framework: gemini-cli` completes a one-shot
  end-to-end **through `buildIntelligenceProvider` → `GeminiCliIntelligenceProvider`** (not the
  dormant registry) — the umbrella's Step-2 acceptance: the body works.
- **G7 — Honest parity tracking.** Two `programNeeds` entries (§9, Step-0 schema): the parity gap
  (`target: ongoing`) AND the named native loop driver (`need-gem-002`, Step-4 prerequisite) — so
  neither is a private intention. Step 1's gate must cite these need-ids.

**Non-goals**

- **N1 — Full 35-primitive behavioral parity.** This is explicitly the apprentice's continued job
  (umbrella §"Step 2" is the keystone *start*, not its completion). The spec *tracks* the gap; it
  does not pretend to close it (§9, §11).
- **N2 — The mentorship/overseer loop itself.** Codey-mentors-Gemini and Echo's differential
  overseer are Steps 3–5 (umbrella). This step is the body only.
- **N3 — Agent-facing features.** Per the meta-lesson, the mind is already built and
  framework-agnostic. This step adds **zero** new agent-facing endpoints or skills. (The
  agent-awareness updates in §8 are about the *framework option becoming selectable*, not new
  capabilities.)
- **N4 — ACP (`--experimental-acp`) integration.** Gemini's Agent Client Protocol is a richer
  bidirectional transport. It is noted as a *future* richer-transport option (§11) but is out of
  scope for the minimal body.
- **N5 — Multi-framework concurrency hardening.** The shared-config last-writer-wins class of bug
  the codex adapter guards against (`codexThreadlineMcpFlags`) is noted as a risk (§10) but its
  Gemini equivalent is deferred to parity work unless live testing forces it sooner. <!-- tracked: programNeeds -->

## 3. Design overview

The codex adapter (`src/providers/adapters/openai-codex/`) is the precedent. It is organized as a
factory (`index.ts`) that builds a `Map<CapabilityFlag, impl>` and returns a `ProviderAdapter`
(`{ id, capabilities, primitive(flag) }`) conforming to `src/providers/registry.ts`. The factory
imports one creator per primitive from four subdirectories: `transport/`, `capability/`,
`observability/`, `control/`, plus `integration/`. Capabilities are declared separately in
`capabilities.ts` and **must match** the impls the factory actually sets (honest declaration).

The Gemini adapter mirrors this exact shape at `src/providers/adapters/gemini-cli/`, but declares
a **smaller, honest** capability set for the minimal body, with the rest tracked as ongoing (§9).

### 3.1 Adapter directory structure (mirrors openai-codex)

```
src/providers/adapters/gemini-cli/
  index.ts            # factory createGeminiCliAdapter(config) → ProviderAdapter
  config.ts           # GeminiCliConfig + configFromEnv (binary detect, model map, timeouts)
  capabilities.ts     # geminiCliCapabilities = capabilitySet([...]) — honest, minimal
  errors.ts           # GEMINI_CLI_ID const + mapExecError(err, stderr)
  models.ts           # resolveCliModelFlag + tier→model map (gemini-2.5-flash default)
  credentials.ts      # env-allowlist rationale (Rule-1a analog for the Gemini credential)
  transport/
    geminiSpawn.ts        # spawn + stdin.end() + buildGeminiChildEnv (env allowlist)
    oneShotCompletion.ts  # gemini -m <model> -p <prompt>, read trimmed stdout
  observability/
    eventNormalizer.ts    # Gemini output line → CanonicalEvent | null (ProviderRawEvent fallback)
    hookEventReceiver.ts  # event-bus receiver; supportedEventKinds() from native `gemini hooks`
    sessionPaths.ts       # locate Gemini session/rollout files under ~/.gemini
    sessionId.ts          # synthetic SessionHandle ↔ Gemini session id binding
  control/
    geminiHardKill.ts     # SIGTERM→SIGKILL escalation (analog of control/hardKill.ts)
    compactionLifecycle.ts# synthesize pre-compact from context-usage tracking
  integration/
    sessionResumeIndex.ts # --resume latest|N / --list-sessions / --delete-session programmatic
```

The Codex adapter ships ~50 files (35-of-36 primitives). The Gemini **minimal body** ships only
the subset above; everything else is §9 ongoing work. The factory only `impls.set(...)` the
primitives that exist, and `capabilities.ts` only declares those flags — so the registry honestly
reports the rest as unavailable (exactly how the Codex adapter reports its four asymmetric gaps).

### 3.2 The six framework-registration points (G1)

Grounded directly against the live tree (file:line verified, §4.0a). Each is a small, surgical edit
— but two of them (points 2–3) are the path-confusion v1 got wrong, corrected here.

> **The path correction (HIGH).** There are **two** provider surfaces, and they are not the same
> path. (a) The **provider-registry adapter** (`src/providers/adapters/<framework>/`, resolved via
> `registry.resolve(...)`) is **DORMANT in production**: `server.ts` (verified at the Phase-5
> policy-install, ~line 2432) installs the routing policy but **registers no adapters** against the
> production registry — *"no adapters are registered against the providers registry yet."* So
> `registry.resolve()` is a parity-harness / future-routing surface, not the live call path. (b) The
> **live** intelligence path is `buildIntelligenceProvider({ framework })`
> (`intelligenceProviderFactory.ts:60`), whose `case 'codex-cli'` constructs a dedicated
> **`CodexCliIntelligenceProvider`** class (`src/core/CodexCliIntelligenceProvider.ts`, verified) —
> this is what the reviewers, sentinels, reflect, and route all actually call. The minimal body's
> **alive proof therefore flows through a `GeminiCliIntelligenceProvider` class**, not through the
> registry adapter. The registry adapter matches codex's own dormancy and exists for the parity
> harness; without the `GeminiCliIntelligenceProvider` class there is **no production transport** and
> the Tier-3 alive proof cannot pass. The class is therefore a **BLOCKING prerequisite**, promoted
> out of "open decision" (it was §14.1 in v1).

1. **`IntelligenceFramework` union** — `src/core/intelligenceProviderFactory.ts:28` (verified:
   `export type IntelligenceFramework = 'claude-code' | 'codex-cli';`). Extend →
   `... | 'gemini-cli'`. This forces the *`never`-exhaustive* switches (the
   `_exhaustive: never` at `intelligenceProviderFactory.ts:87`, and the
   `Record<IntelligenceFramework, …>` maps in `frameworkSessionLaunch.ts` at `:242`/`:429` and
   `skillParityRule.ts:584`, and the monitoring `Record` maps in
   `frameworkProcessSignals.ts:89` + `frameworkActivitySignals.ts:99`) to a compile error until
   Gemini is handled. **⚠ This is the ONLY compiler-forced wiring.** The ~10 *parallel* hardcoded
   `'claude-code' | 'codex-cli'` unions are **not** caught by the compiler — see the hand-audit list
   in §4.3. (There is also a **second, duplicate** definition of `IntelligenceFramework` at
   `src/messaging/shared/telegramRelayPrompt.ts:28` — verify whether it must also be extended or
   re-pointed at the canonical one; it is its own union literal, so the compiler will **not** flag it.)

2. **The provider-registry adapter (DORMANT — parity-harness surface)** —
   `src/providers/adapters/gemini-cli/index.ts` exporting `createGeminiCliAdapter(partialConfig)`,
   mirroring `createOpenAiCodexAdapter` (`openai-codex/index.ts:73`). Builds the `impls` map, returns
   `{ id: GEMINI_CLI_ID, capabilities: geminiCliCapabilities, primitive }`. This is the
   stub-vs-real authority surface and the future routing target — but it is **not** what the alive
   proof exercises (see point 3). It matches codex's registry dormancy.

3. **(§3.2.3) `buildIntelligenceProvider` case + the `GeminiCliIntelligenceProvider` class (ALIVE
   path, BLOCKING)** — `intelligenceProviderFactory.ts:68` switch (verified `case 'claude-code'` / `case
   'codex-cli'` / `default: { const _exhaustive: never = framework; }`). Add a `case 'gemini-cli'`:
   detect the binary (`detectFrameworkBinary('gemini')`), return null if absent (the established
   "binary not installed → null" contract — `case 'codex-cli'` does exactly this), else construct a
   **`GeminiCliIntelligenceProvider`** (the new class, parallel to `CodexCliIntelligenceProvider`,
   `src/core/GeminiCliIntelligenceProvider.ts`) wrapped with `wrapIntelligenceWithCircuitBreaker`
   (same as both existing cases). Extend `frameworkFromEnv` (`intelligenceProviderFactory.ts:99`,
   verified — currently only maps claude/codex) to map `'gemini-cli' | 'gemini'` → `'gemini-cli'`.
   - **`GeminiCliIntelligenceProvider`** wraps the verified one-shot transport (§3.3) behind the
     `IntelligenceProvider` interface. It MAY delegate to the registry adapter's `OneShotCompletion`
     primitive (single source of transport truth) or carry its own thin spawn — a build-time
     factoring call, but the **class itself is required**, not optional. The codex equivalent
     (`CodexCliIntelligenceProvider`) is the proof this is the live surface.

4. **Session-launch builder** — `frameworkSessionLaunch.ts:242` `BUILDERS:
   Record<IntelligenceFramework, Builder>` (verified) and the `HEADLESS_BUILDERS:
   Record<IntelligenceFramework, HeadlessBuilder>` at `:429` (verified). Add
   `'gemini-cli': geminiCliBuilder` / `geminiCliHeadlessBuilder`. **These two `Record` maps ARE
   compiler-forced** (adding the union member without the entry is a type error). Extend
   `resolveModelForFramework` (`frameworkSessionLaunch.ts:38`, verified — currently
   `if (framework === 'claude-code') … if (framework === 'codex-cli') …`, an `if`-chain **not** a
   `never`-switch, so a missing `gemini-cli` branch falls through silently to the claude defaults —
   **hand-audit item**, §4.3) with a `framework === 'gemini-cli'` branch mapping the generic tiers
   to Gemini model ids (e.g. `gemini-2.5-flash` for fast/balanced, a `gemini-2.5-pro`-class id for
   capable — exact ids **verified against the live binary at build time**, §6).

5. **`SUPPORTED_FRAMEWORKS`** — `src/core/TopicFrameworksStore.ts:52` (verified:
   `SUPPORTED_FRAMEWORKS: ReadonlyArray<IntelligenceFramework> = ['claude-code', 'codex-cli']`).
   Append `'gemini-cli'`. This is what makes a topic bindable to Gemini and what the store's
   validation (`:112`, verified `.includes(v)`) accepts. The array is typed
   `ReadonlyArray<IntelligenceFramework>`, so the compiler permits the append once the union has the
   member — but it does **not** force the append (an empty/short array still type-checks).

6. **CLI `--framework` option (multiple silent-rejection sites)** — verified: `src/commands/init.ts:101`
   (`framework?: 'claude-code' | 'codex-cli' | 'both'`) + `resolveEnabledFrameworks` at
   `src/commands/init.ts:111` (**not** `src/core/init.ts` — v1's path was wrong; there is no
   `src/core/init.ts`). Accept `'gemini-cli'`. **⚠ Critically, the arg-parse allowlists in
   `src/cli.ts` will REJECT `gemini-cli` before it reaches anything else:** `cli.ts:313`
   (`const allowed = ['claude-code', 'codex-cli'];` for `setup`) and `cli.ts:348`
   (`const allowed = ['claude-code', 'codex-cli', 'both'];` for `init`) both error out on an
   unlisted value. Also `setup.ts:136` `runSetup(opts?: { framework?: 'claude-code' | 'codex-cli' })`
   and `route.ts:57` `resolveFramework` (verified: no gemini branch → silent fallthrough to
   `'claude-code'`, even though `route.ts:47` `KNOWN_FRAMEWORKS` *already lists* `'gemini-cli'` and
   `:53` `KNOWN_MODELS` lists `gemini-2.5-pro` — a half-wired state) and `reflect.ts:356`
   (`frameworkFromEnv() ?? 'claude-code'` + `:359` hardcodes the claude binary path). Every one of
   these is enumerated in the §4.3 hand-audit checklist.

### 3.3 Transport (G2)

`transport/oneShotCompletion.ts`, modeled on `openai-codex/transport/oneShotCompletion.ts`:

- **Command — ONE canonical argv (pinned, no ambiguity).** The builder emits **exactly** this form
  and no other: `gemini -m <model> --approval-mode default -p <prompt>`. The `-p/--prompt` flag is
  the documented one-shot entrypoint and takes the prompt as its **sole value** — so the prompt is a
  single argv element and **`--` is NOT used** (the end-of-options separator is only meaningful for a
  *positional* prompt, and the canonical form never uses a positional). The `--approval-mode default`
  pin is part of the canonical argv itself, not an optional add-on (see the yolo-safety bullet
  below). Unlike Codex's `--output-last-message <file>` indirection, the verified Gemini one-shot
  writes the final message to **stdout** directly (clean stdout, exit 0). So the adapter reads
  `stdout`, trims, and returns it — simpler than Codex's tmpfile dance. The build verifies this exact
  invocation is the stable one-shot against the live binary (§6); if a positional prompt is ever used
  instead (it is not the canonical path), `--` MUST precede it so a leading-dash prompt can't be
  re-parsed as a flag.
- **One-shot prompt is exactly one argv slot (MED d).** Because the canonical form passes the prompt
  as the value of `-p`, the prompt occupies **exactly one argv element** and a leading-dash prompt
  (`"--help me"`, `"-y do X"`) can never be re-parsed as a flag — a thin but real argument-injection
  boundary. **The injection/argv unit test asserts against THIS exact builder output:** the prompt is
  exactly one argv element (the value of `-p`), `--approval-mode default` is present, and the argv
  contains no `-y`/`--yolo` (and no `--approval-mode yolo`/`auto_edit`). The `-p` vs `--` ambiguity is
  resolved: with `-p` the `--` separator is unnecessary and absent; `--` is only required on the
  non-canonical positional path (where it must precede the positional prompt).
- **stdin discipline:** reuse the codex lesson exactly. `transport/geminiSpawn.ts` uses
  `spawn(...)` and calls `child.stdin.end()` immediately so the binary doesn't block waiting for
  EOF (the `codexSpawn.ts` header documents this exact failure mode; whether Gemini exhibits it is
  verified at build, but ending stdin is harmless and defensive regardless).
- **Timeout + abort:** port `spawnCodexAndWait`'s structure (SIGTERM→SIGKILL on timeout,
  AbortSignal handling, stdout/stderr capture). The "Loaded cached credentials" stderr line is
  benign noise — the normalizer/transport must not treat non-empty stderr as failure when
  `exitCode === 0`.
- **Output-byte cap (MED b — improves on codex).** `spawnGeminiAndWait` MUST bound captured stdout
  (and stderr) with a hard byte cap, truncating with a marker once exceeded. **This is an explicit
  improvement over the codex precedent**, whose `Buffer.concat` of stdout chunks is **unbounded** —
  a runaway/looping child could OOM the supervising process. The cap is a config field
  (`maxOutputBytes`, sane default e.g. 8 MiB); a unit test feeds an over-cap stream and asserts the
  capture stops at the cap and is flagged truncated.
- **Approval-mode hard-pin at the call site (HIGH — yolo safety).** Gemini's one-shot supports
  `-y/--yolo` and `--approval-mode default|auto_edit|yolo`; `yolo`/`auto_edit` let the model take
  filesystem/exec actions without confirmation. The one-shot transport MUST **hard-pin
  `--approval-mode default` at the call site**, mirroring codex's `oneShotCompletion.ts:36`
  (`const sandbox = this.config.defaultSandboxMode ?? 'read-only';` — the safe mode is pinned where
  the argv is built, not left to a default that a caller can override). `yolo`/`-y` is gated as a
  **capability-only mode** — the exact analog of how codex's `danger-full-access` sandbox is a
  capability the registry must explicitly declare, never the default and never reachable from
  `OneShotCompletion`. A unit test asserts the one-shot argv **never** contains `-y`, `--yolo`, or
  `--approval-mode yolo` (the analog of codex's sandbox-pin assertion).
- **TWO PATHS — the agentic SESSION launch DOES auto-approve (the one-shot lockdown is NOT the
  whole story).** The hard-pin above is scoped to the one-shot *evaluation* path only. The
  **agentic session** (`geminiCliBuilder` — Gemini running AS an Instar agent, which Codey drives
  through real work in Step 4) launches with `--yolo`, exactly as the fleet already launches
  Claude agents with `--dangerously-skip-permissions` and codex agents with
  `--dangerously-bypass-approvals-and-sandbox`. An autonomous agent that blocks on per-tool
  confirmation cannot operate; withholding yolo from the agentic launch would make Gemini a
  second-class agent and silently break the live mentorship. So: **one-shot evaluation =
  `--approval-mode default`, no tools (the lockdown); agentic session = `--yolo` (auto-approve,
  fleet-consistent).** (Caught in convergence review: the first build over-applied the one-shot
  lockdown to the agentic builder — corrected so the session path matches claude/codex.)
- **Credential env-allowlist (Rule-1a analog) + UNCONDITIONAL billing-key delete (MED a).**
  `buildGeminiChildEnv` constructs an **explicit allowlist** (not a blocklist) of env vars that flow
  to the child, exactly like `buildCodexChildEnv` (`codexSpawn.ts:129`, verified). Gemini auths via
  `~/.gemini` cached OAuth credentials; the allowlist passes the filesystem/locale/terminal vars +
  benign `GEMINI_*` knobs and drops everything else. **In addition, the build MUST unconditionally
  hard-delete the known Google/Gemini billing-capable vars from the child env** — mirroring codex's
  `buildCodexChildEnv` which runs `delete env.OPENAI_API_KEY; delete env.OPENAI_ORG_ID; delete
  env.OPENAI_PROJECT_ID;` (verified, `codexSpawn.ts:143–147`) **regardless of allowlist contents**.
  The concrete allowlist-delete set (commit this, do not leave it "to verify"):
  `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `GOOGLE_APPLICATION_CREDENTIALS`, `GOOGLE_GENAI_USE_VERTEXAI`,
  `GOOGLE_CLOUD_PROJECT` are **always deleted** from the child env. Any of these present would
  silently route Gemini onto a billed API path instead of the cached-OAuth/subscription path — the
  exact Codex Rule-1 leak class. **The key-leak canary is REQUIRED, not conditional** (§5, §13): a
  `geminiKeyLeakageCanary` (analog of `openaiKeyLeakageCanary.ts`) asserts none of these vars ever
  reaches the child env. The build still verifies *whether* a given var actually overrides cached
  OAuth in Gemini (§6) — but the delete + canary are unconditional regardless of that finding,
  because the cost of a false-negative (silent billing) is asymmetric.

### 3.8 The `gemini hooks` untrusted-code-execution boundary (security)

Gemini's native `gemini hooks` subsystem is a richer surface than Codex's single Stop-hook — and
that richness is a **liability as well as an asset**. A hook is, by definition, a command Gemini (or
its model output) can cause to be **executed**. Two hard rules:

- **The hook receiver is OBSERVE-ONLY by default — not merely "as a fallback."** v1 framed
  observe-only as the degraded path taken *only if* Gemini's hook-return contract turns out
  incompatible with `{decision: approve|block}`. v2 inverts that: `hookEventReceiver` ships
  **observe-only as the default posture** (emit normalized events to the bus, inject no decisions),
  and decision-injection is a **separately gated, capability-declared** behavior enabled only after
  the hook-return contract is characterized *and* judged safe (§6 canary). Observing is always safe;
  injecting decisions into an executor is not.
- **Never write an executable hook command from session- or model-derived content.** The adapter
  MUST NOT register/emit any hook whose command string is derived from session output, model
  responses, prompts, or any non-constant runtime content. Hook command strings, if the adapter ever
  writes them at all, come only from constant, code-reviewed templates. A unit test asserts the
  hook-registration path rejects/ignores any non-constant command source. (This closes the
  arbitrary-code-execution path the richer subsystem otherwise opens.)

### 3.4 Config (G3)

`config.ts` mirrors `openai-codex/config.ts`:

- `GeminiCliConfig`: `geminiPath` (from `detectFrameworkBinary('gemini')` — already wired),
  `defaultModel?` (default resolves to the verified-working `gemini-2.5-flash`),
  `defaultApprovalMode?` (`'default' | 'auto_edit' | 'yolo'` — Gemini's native approval surface,
  the analog of Codex's sandbox modes; `'default'` is the safe one-shot default), timeouts
  (`defaultOneShotTimeoutMs`, etc.), `defaultWorkingDirectory?`.
- `configFromEnv(env)`: read `GEMINI_PATH` override → fall back to `detectFrameworkBinary('gemini')`
  → `'gemini'`. **Never** hardcode `/opt/homebrew/bin/gemini` in the config (the codex config's
  header is explicit about why developer-specific paths leak across installs; detection is the only
  correct path — the verified location is a *fact for this box*, not a value to bake in).
- `models.ts`: `resolveCliModelFlag(modelOrTier)` + the tier→model table, kept in sync with the
  `resolveModelForFramework('gemini-cli', ...)` branch from §3.2.4 (single source of truth — the
  codex adapter keeps these aligned between `models.ts` and `resolveModelForFramework`).

### 3.5 Observability primitives (G5, buildable subset)

- **`eventNormalizer.ts`** — `normalizeGeminiEvent(line): CanonicalEvent | null`, modeled on
  `openai-codex/observability/eventNormalizer.ts`. Codex emits a documented JSONL `--json` event
  vocabulary; **Gemini's machine-readable output schema for the event stream is NOT yet known** and
  MUST be discovered by running the binary at build (§6, §10). The normalizer follows the codex
  invariant exactly: recognized shapes → typed `CanonicalEvent`; **unrecognized lines →
  `ProviderRawEvent`, never dropped silently** (the codex normalizer's Rule-3.1 rationale: silent
  corruption if a new event type isn't recognized). A canary (analog of
  `canary/codexEventNormalizerCanary.ts`) asserts the recognized vocabulary against a known-shape
  prompt — **added once the live schema is characterized**, not guessed.
- **`hookEventReceiver.ts`** — event-bus-backed receiver mirroring
  `openai-codex/observability/hookEventReceiver.ts`. Codex declares the 5 hook kinds it actually
  emits; **Gemini's advantage is its richer native `gemini hooks` subsystem** (more than Codex's
  single Stop-hook). `supportedEventKinds()` returns the set Gemini *actually* emits, **determined
  from the live `gemini hooks` contract at build** (§6). The native subsystem is a likely *parity
  win* over Codex (more lifecycle coverage for free) — but the precise event names and the
  hook-return JSON shape (does Gemini honor Claude/Codex-compatible `{decision: approve|block}` and
  exit-code-2 semantics, or its own?) are **unknowns to verify**, not assert.
- **`sessionPaths.ts` / `sessionId.ts`** — locate Gemini session/rollout files under `~/.gemini`
  and bind a synthetic `SessionHandle` to a Gemini session id, mirroring the codex
  `observability/sessionPaths.ts` + `sessionId.ts`. The on-disk layout is **discovered at build**
  (Codex's is `$CODEX_HOME/sessions/YYYY/MM/DD/rollout-...jsonl`; Gemini's is unknown until probed,
  but `--list-sessions` gives the programmatic listing regardless of on-disk layout — §3.6).

### 3.6 Control primitives (G5, buildable subset)

- **`integration/sessionResumeIndex.ts`** — programmatic resume, mirroring
  `openai-codex/integration/sessionResumeIndex.ts`. Gemini exposes this **natively and cleanly**:
  `--list-sessions` (enumerate), `--resume latest|N` (resume), `--delete-session` (prune). This is
  a parity *win* — Codex's adapter had to walk the filesystem and treat the SQLite index as a
  Phase-5 optimization; Gemini gives first-class CLI verbs. The primitive wraps those verbs.
- **`control/compactionLifecycle.ts`** — synthesize the pre-compact signal, mirroring
  `openai-codex/control/compactionLifecycle.ts`. Codex has no native pre-compact hook and
  synthesizes the notice by tracking `turn.completed.usage.context_window_used` against a
  threshold. **Whether Gemini has a native pre-compact hook** (it might, given the richer `gemini
  hooks` subsystem) is an unknown — **if** a native hook exists, the receiver surfaces it directly
  and this synthesizer is unnecessary; **if not**, the codex synthesis pattern is ported. The build
  checks the `gemini hooks` event list first (§6); the spec declares whichever is real, not both.
- **`control/geminiHardKill.ts`** — SIGTERM→SIGKILL escalation, a near-verbatim port of
  `openai-codex/control/hardKill.ts` (process-level, framework-agnostic). Interrupt/timeout-bound
  follow the same ports where the minimal body needs them.

### 3.7 Capability declaration (G4) — the acceptance floor, split MANDATORY vs CONDITIONAL

`capabilities.ts` exports `geminiCliCapabilities = capabilitySet([...])` declaring **only** the
primitives the factory actually wires for the minimal body. The Step-2 acceptance floor is split into
two tiers so Step 2 is **not held hostage to Gemini's poorly-documented internals** — requiring a
primitive whose live contract is unknown (the `gemini hooks` return shape, the compaction event,
the `~/.gemini` on-disk session layout) as a *hard* floor would make shipping the alive proof
contingent on reverse-engineering surfaces that can only be characterized by live probing.

**MANDATORY floor (required for the alive proof + safety — ships in Step 2, non-negotiable):**

```
OneShotCompletion          (transport, G2 — the alive proof itself)
SessionId                  (observability — bind a SessionHandle to a gemini session id)
HardKill                   (control — SIGTERM→SIGKILL, framework-agnostic port)
```

…plus, outside the capability *set* but part of the same MANDATORY acceptance floor (these are the
wiring the body cannot ship without, not capability flags):
- **Config + binary detection** — `detectFrameworkBinary('gemini')`, the model map, timeouts (§3.4).
- **The framework registration** — the factory `buildIntelligenceProvider` case + the
  `GeminiCliIntelligenceProvider` class (the ALIVE path), the §4.3 hand-audit list discharged, and
  the compiler-forced `BUILDERS`/`Record<IntelligenceFramework,…>` maps + model-map entries (§3.2).
- **Safety** — the env-allowlist + unconditional billing-var delete, the `--approval-mode default`
  yolo-pin, the output-byte cap, the credential canary (§3.3).
- **The framework-blind resolver fixes** — the `ThreadResumeMap` gemini path, the `RateLimitSentinel`
  + `CompactionSentinel` recovery branches, the `frameworkProcessSignals` + `frameworkActivitySignals`
  entries, and the §4.0.4 **drift canary** (§4.0). These close the silent landmines and are
  non-negotiable.

**CONDITIONAL floor (ship in Step 2 ONLY if its live contract is characterized *within* Step 2 —
otherwise explicitly sequenced to a later step with a `programNeeds` entry, never shipped
half-built):**

```
HookEventReceiver          (observability — native `gemini hooks`; depends on the §6 hook-return
                            contract + event-kind set, both UNKNOWN until live probing)
CompactionLifecycle        (control — native pre-compact event vs codex-style synthesis is UNKNOWN
                            until the §6 hook-event list is read)
SessionResumeIndex         (integration — `--list-sessions`/`--resume` verbs are known, but the FULL
                            `~/.gemini` session-layout parsing the resolver depends on is UNKNOWN
                            until the layout is probed)
```

**The conditional rule (explicit):** a conditional primitive is declared in `capabilities.ts` **only
when its live contract is characterized within Step 2** (the event-kind set / hook-return shape /
on-disk layout discovered against the live binary, with its drift canary added — §5, §6). If a
conditional primitive's contract is **not** characterized within Step 2, it is **NOT declared and NOT
shipped half-built** — it is explicitly sequenced to a later step and recorded as a `programNeeds`
entry (§9), so the gap is *tracked*, not silently half-implemented. An uncharacterized conditional
primitive failing to ship is a **clean, expected outcome**, not a Step-2 failure (§13).

Plus any of `LiveOutputStream` / `ConversationLogReader` / `BashExecution` / `WebAccess` /
`ToolAccess` that the build can implement *honestly* against the live binary. **Everything not in
the declared set is NOT declared** — the parity harness then truthfully reports those capabilities as
unavailable on the Gemini adapter (the same honesty contract enforced by the parity harness's
stub-vs-real check; `openai-codex/capabilities.ts` documents declaring "only what's actually
implemented"). The capability declaration is the harness/future-routing surface (§3.2 — the
production registry is dormant); the live transport runs through `GeminiCliIntelligenceProvider`
regardless. The full target set the Codex adapter reaches is §9 ongoing work.

## 4. Implementation notes

### 4.0 Framework-monitoring surfaces the codex onboarding had to fix (BLOCKING)

> **This is the apprenticeship's whole point.** The codex retro-harvest (Step 0) is a ledger of the
> landmines a new framework silently steps on. A new framework breaks each of these **without a
> compile error** — it just goes silently wrong at runtime, fleet-wide. The apprenticeship exists to
> *engage* these known landmines up front, not re-discover them by failing in production a second
> time. Every surface below is verified in the live tree (file:line) and each was a codex onboarding
> task. The Gemini body MUST add a gemini branch to each, or it inherits the exact codex bug.

These are **not** caught by the `IntelligenceFramework` union extension. They are framework-keyed
*behavioral branches* (`framework === 'codex-cli' ? … : <claude-default>`) that fall through to the
Claude path for any unknown framework:

**§4.0.1 — Resume is silently broken (codex task #24, re-opened for gemini).**
   `src/threadline/ThreadResumeMap.ts:353` `jsonlExists(uuid)` (verified) hardcodes a
   **Claude-layout-then-codex-layout** probe: it checks `~/.claude/projects/**/<uuid>.jsonl`, then
   falls through to `findRolloutFileSync(uuid)` for the codex
   `$CODEX_HOME/sessions/.../rollout-…jsonl` layout (import at `:22`), and otherwise `return false`.
   **There is no gemini path** → for a gemini session `jsonlExists` always returns `false` → the
   resume entry at `:161` (`!this.jsonlExists(entry.uuid)`) treats every gemini thread as
   expired/missing → **resume breaks fleet-wide for gemini**, exactly the codex-compat root that was
   task #24 (`MEMORY`/ledger: codex-resume-jsonl-exists). The body MUST add a **gemini-layout
   dispatch routed through the new adapter's `sessionPaths.ts`** (the layout the adapter discovers in
   §3.5), not a third hardcoded probe inline. (Verify the parallel `TopicResumeMap` if it carries the
   same method — the harvest names both.)

**§4.0.2 — Rate-limit + compaction recovery-verification are framework-blind (codex tasks #26/#33).**
   - `src/monitoring/RateLimitSentinel.ts` (verified): the recovery-verification transcript resolver
     branches `if (this.deps.getSessionFramework?.(sessionName) === 'codex-cli') return
     findNewestRolloutSync(this.deps.codexHome);` (`:475`) and the vendor-label resolver branches the
     same at `:463`; everything else **falls through to the unchanged Claude transcript path**. A
     gemini session has neither a Claude transcript nor a codex rollout → the
     "is it producing output again?" growth signal reads the wrong file → **recovery verification
     silently fails for gemini**.
   - `src/monitoring/CompactionSentinel.ts` (verified): identical shape —
     `if (this.deps.getSessionFramework?.(sessionName) === 'codex-cli') return
     findNewestRolloutSync(this.deps.codexHome);` (`:444`, import `:38`), else the Claude path.
   - The body MUST add a **gemini branch** to both resolvers that reads the gemini session's
     transcript/rollout via the adapter's `sessionPaths` (whatever the §3.5-discovered layout is, or
     the `--list-sessions`-backed path). This is the same fix that closed #33 for codex.

**§4.0.3 — Process-detection map is compiler-forced (codex parity, names the gemini pattern).**
   `src/monitoring/frameworkProcessSignals.ts:89` (verified — **note: `src/monitoring/`, not
   `src/core/`** as a draft might assume) holds
   `const PROCESS_SIGNALS: Record<IntelligenceFramework, FrameworkProcessSignal> = { 'claude-code':
   …, 'codex-cli': … };`. Because it is keyed on `IntelligenceFramework`, **adding `'gemini-cli'` to
   the union forces a `GEMINI_CLI_SIGNAL` entry here at compile time** (this one the type system
   *does* catch). The spec NAMES the required entry so the build doesn't guess. The
   `FrameworkProcessSignal` shape (verified `:24–53`) requires:
   - `framework: 'gemini-cli'`, `displayName: 'Gemini'`
   - `psGrepNeedle: '[g]emini'` (bracket-trick so grep doesn't match its own command line)
   - `binaryPattern: /(^|\/)gemini(\s|$)/` (bare / path-tail / bare-token, mirroring
     `/(^|\/)codex(\s|$)/`)
   - `nodePattern: /@google\/gemini-cli|gemini-cli\/(cli|bin)/` (node/npx-wrapped invocation — the
     exact form is verified against the installed package at build, mirroring codex's
     `/@openai\/codex|codex-cli\/cli|codex-cli\/bin/`)
   - `exclusionSubstrings: ['gemini-mcp']` at minimum (the `gemini mcp` server shares the prefix and
     must NOT be counted as a framework session — directly analogous to codex's `'codex-mcp'`
     exclusion). Add any other prefix-sharing helper the build observes.
   - **Also** the sibling activity-signal map `src/monitoring/frameworkActivitySignals.ts:99`
     (`ACTIVITY_SIGNALS: Record<IntelligenceFramework, FrameworkActivitySignal>`, verified —
     another compiler-forced map the draft omitted) needs its gemini entry.

**§4.0.4 — DRIFT CANARY — convert the silent-failure surfaces into test-forced ones (the "Wall is a
   Hypothesis" / L5 lesson).** The three resume/recovery resolvers above are framework-keyed *string
   branches*, so the compiler is blind to a missing gemini case — they are silent until a gemini
   session hits them in production. Per the Wall-is-a-Hypothesis standard
   (`docs/specs/wall-is-a-hypothesis-standard.md`) and the codex harvest's L5 lesson (a "wall" you
   assert without a test is a hypothesis), the build MUST add a **drift canary**: a unit test that
   **enumerates every member of `IntelligenceFramework`** and, for each, asserts the resume map + both
   recovery sentinels resolve to that framework's **correct** transcript/rollout — wired in
   `ThreadResumeMap.jsonlExists`, `RateLimitSentinel`, and `CompactionSentinel`. When a future
   `IntelligenceFramework` member is added with no resolver, the canary **fails CI** — turning the
   class of silent framework-blind fall-through into a test-forced one. This is the structural
   generalization of the per-surface fixes: it future-proofs Step 3+ frameworks too.
   - **The canary asserts resolver OUTPUT, not just branch identity (CRITICAL — semantic
     correctness).** A test that only asserts "the gemini input resolves to a *non-Claude* path" is a
     weak canary: it passes even when the resolver dispatches into the gemini branch but returns the
     **wrong** gemini session (wrong path, wrong session-id, stale layout). That is exactly the
     "Wall-is-a-Hypothesis" failure the canary exists to prevent — a green test asserting only that "a
     gemini branch exists." Instead, the canary feeds each resolver a **synthetic fixture** (a
     fabricated `~/.gemini` session-layout dir / a known session-id) and asserts the resolver returns
     the **CORRECT resolved path/session for that gemini input** — the right file under the right
     layout, the right session-id binding — not merely "a gemini branch was taken." The fixture is
     hermetic (no live binary, no real `~/.gemini`); it characterizes the *contract* the resolver must
     honor. Each framework gets its own per-framework resolver contract this way, so a regression that
     silently resolves the wrong session fails CI just like a missing branch does.
   - Ledger / Step-0 harvest pointers: `task:#24` (jsonlExists resume root), `task:#26` + `task:#33`
     (RateLimitSentinel/CompactionSentinel recovery-blindness), `task:#28` (loop driver, §9). These
     are exactly the `programNeeds`/evidence-pointer ids the Step-0 retro-harvest schematizes
     (`ledger:<id>` / `pr:<n>` / `task:#N`); §9 cites them in the `programNeeds` block.

### 4.0a File:line path corrections vs the v1 draft (grounding)

v1 mislocated several files (it mapped from the adapter dir, not the framework-aware tree). Verified
corrections, so the build edits the right files:

| Surface | v1 said | Verified actual |
|---|---|---|
| `resolveEnabledFrameworks` | `src/core/init.ts:111` | `src/commands/init.ts:111` (no `src/core/init.ts` exists) |
| `frameworkProcessSignals.ts` | `src/core/frameworkProcessSignals.ts:89` | `src/monitoring/frameworkProcessSignals.ts:89` |
| `StuckInputSentinel.ts` | (`src/monitoring/`) | `src/core/StuckInputSentinel.ts` (codex branch at `:228`) |
| `Config.ts` resolvers | `~345,359` | `checkFrameworkPrerequisite:320`, `resolveConfiguredFramework:358` |
| arg-parse allowlist | (unlocated) | `src/cli.ts:313` (setup) + `:348` (init) — both reject `gemini-cli` |
| second `IntelligenceFramework` def | (unmentioned) | `src/messaging/shared/telegramRelayPrompt.ts:28` (duplicate union) |
| `ACTIVITY_SIGNALS` map | (unmentioned) | `src/monitoring/frameworkActivitySignals.ts:99` (compiler-forced) |
| `skillParityRule` renderers | (unmentioned) | `src/providers/parity/rules/skillParityRule.ts:584` (`Record<IntelligenceFramework, …>`, compiler-forced) |

### 4.1 The 10-point add-framework checklist (from mapping the codex adapter)

The six **registration** points are §3.2; the remaining four are the adapter-internal builds:

| # | Point | File / location | Type of change | Compiler-forced? |
|---|-------|-----------------|----------------|------------------|
| 1 | `IntelligenceFramework` union | `intelligenceProviderFactory.ts:28` | type extension | — (the gate) |
| 2 | Registry adapter (DORMANT) | `src/providers/adapters/gemini-cli/index.ts` (new) | new file | no |
| 3 | `buildIntelligenceProvider` case + `GeminiCliIntelligenceProvider` class | `intelligenceProviderFactory.ts:68` + `src/core/GeminiCliIntelligenceProvider.ts` (new) | switch case (forced) + new class (the ALIVE path) + `frameworkFromEnv:99` | switch: **yes**; class: no (hand) |
| 4 | Session-launch builders | `frameworkSessionLaunch.ts:242` + `:429` | `Record` entries | **yes** (both maps) |
| 4b | `resolveModelForFramework` | `frameworkSessionLaunch.ts:38` | `if`-chain branch | **no** (silent fall-through) |
| 5 | `SUPPORTED_FRAMEWORKS` | `TopicFrameworksStore.ts:52` | array append | no (short array type-checks) |
| 6 | CLI `--framework` (multi-site) | `commands/init.ts:101,111` + `cli.ts:313,348` + `setup.ts:136` + `route.ts:57` + `reflect.ts:356` | literal-union + resolve | **no** (silent reject/fallthrough) |
| 7 | Capability declaration | `gemini-cli/capabilities.ts` (new) | honest `capabilitySet` | parity-harness, not tsc |
| 8 | Transport primitive | `gemini-cli/transport/*` (new) | spawn + one-shot | no |
| 9 | Config | `gemini-cli/config.ts` (new) | detect + model map + timeouts | no |
| 10 | Observability/control primitives | `gemini-cli/observability/*`, `control/*`, `integration/*` (new) | the buildable subset | no |
| 11 | **Process/activity signals** | `monitoring/frameworkProcessSignals.ts:89` + `frameworkActivitySignals.ts:99` | `Record` entries (§4.0.3) | **yes** |
| 12 | **Resume + recovery resolvers** | `ThreadResumeMap.ts:353` + `RateLimitSentinel.ts:475` + `CompactionSentinel.ts:444` | gemini branch (§4.0.1–2) | **NO — silent (the landmines)** |

**The honest compiler-enforcement claim (CRITICAL correction).** v1 claimed "adding to
`IntelligenceFramework` forces the rest at compile time." **That is false.** Only the
`never`-exhaustive switch (`intelligenceProviderFactory.ts:87`) and the `Record<IntelligenceFramework,
…>` maps (`frameworkSessionLaunch.ts:242`/`:429`, `frameworkProcessSignals.ts:89`,
`frameworkActivitySignals.ts:99`, `skillParityRule.ts:584`) are compiler-forced. **Everything else
is a silent fall-through** — a `framework === 'codex-cli' ? … : <claude-default>` branch, an
`if`-chain, an arg-parse allowlist, or a parallel hardcoded `'claude-code' | 'codex-cli'` literal
union — none of which the compiler relates to the canonical union. Those are enumerated as an
explicit **hand-audit checklist** in §4.3. The drift canary (§4.0.4) is what converts the
behavioral-branch class (resume + recovery resolvers) from "silent" into "test-forced," because the
type system cannot. **Structure > Willpower** still holds — but the structure is *compiler maps +
the drift canary + the hand-audit list*, not the union alone.

### 4.2 Reuse the codex lessons verbatim where they're framework-agnostic

- `spawnCodexAndWait`'s timeout/abort/capture structure → `spawnGeminiAndWait` (process-level,
  framework-agnostic).
- The env-allowlist *posture* (allowlist + defensive hard-delete of billing-capable keys) → the
  Gemini credential boundary. The *contents* differ; the *shape* is identical.
- `control/hardKill.ts` SIGTERM→SIGKILL → `geminiHardKill.ts` (near-verbatim).
- The normalizer's "unrecognized → ProviderRawEvent, never drop" invariant → the Gemini normalizer
  verbatim.

### 4.3 The silent hand-audit checklist (the compiler will NOT catch these)

The ~10 parallel hardcoded `'claude-code' | 'codex-cli'` unions + framework-keyed branches below are
**not** related to the canonical `IntelligenceFramework` union by the type system. Each is verified
in the live tree; each must be hand-edited (or, for the resume/recovery resolvers, fixed *and*
covered by the §4.0.4 drift canary). **Build rule:** the union extension does not make these
type-error; only this list + the canary guarantee they're handled.

| File:line | What | Failure if missed |
|---|---|---|
| `src/core/types.ts:65` | `framework?: 'claude-code' \| 'codex-cli'` (session) | gemini session field rejected |
| `src/core/types.ts:114` | `frameworkBinaryPaths?: { 'claude-code'?; 'codex-cli'? }` | no slot for gemini path |
| `src/core/types.ts:123` | `frameworkDefaultModels?: { 'claude-code'?; 'codex-cli'? }` | no slot for gemini model |
| `src/core/types.ts:134` | `framework?: 'claude-code' \| 'codex-cli'` (spawn opts) | gemini spawn rejected |
| `src/core/types.ts:2055` | `topicFrameworks?: Record<string, 'claude-code' \| 'codex-cli'>` | gemini topic binding rejected |
| `src/core/types.ts:2136` | `enabledFrameworks?: ('claude-code' \| 'codex-cli')[]` | gemini-only install impossible |
| `src/core/Config.ts:320` | `checkFrameworkPrerequisite` switch (`'claude-code'`/`'codex-cli'`) | gemini prereq never checked |
| `src/core/Config.ts:358` | `resolveConfiguredFramework` (param + body literal unions) | gemini config value ignored → defaults claude |
| `src/commands/init.ts:111` | `resolveEnabledFrameworks` switch | gemini choice → default claude |
| `src/core/FrameworkSessionStore.ts:25` | `SessionFramework = 'claude-code' \| 'codex-cli'` + switch `:101` | gemini session-framework unrepresentable |
| `src/core/PreCompactionFlush.ts:76` | `framework?: 'claude-code' \| 'codex-cli'` + branch `:271` | gemini pre-compact flush wrong path |
| `src/core/ResumeValidator.ts:42` | `framework?: 'claude-code' \| 'codex-cli'` | gemini resume validation defaults claude |
| `src/core/StuckInputSentinel.ts:228` | `pending.framework === 'codex-cli'` detection branch | gemini stuck-input detected via claude strategy |
| `src/core/PostUpdateMigrator.ts:113` | `getEnabledFrameworks()` filter → keeps only `'claude-code'\|'codex-cli'` (`:121–123`) | **SILENTLY FILTER-DROPS `gemini-cli`** from enabled list → gemini-gated migrations never run for existing agents |
| `src/cli.ts:313` | `const allowed = ['claude-code','codex-cli']` (setup) | `--framework gemini-cli` rejected at arg-parse |
| `src/cli.ts:348` | `const allowed = ['claude-code','codex-cli','both']` (init) | `--framework gemini-cli` rejected at arg-parse |
| `src/commands/setup.ts:136` | `runSetup(opts?: { framework?: 'claude-code'\|'codex-cli' })` | gemini setup param rejected |
| `src/commands/route.ts:57` | `resolveFramework` no gemini branch (despite `KNOWN_FRAMEWORKS:47` already listing it) | silent fallthrough to `'claude-code'` |
| `src/commands/reflect.ts:356` | `frameworkFromEnv() ?? 'claude-code'` + `:359` hardcodes claude path | reflect always uses claude |
| `src/messaging/shared/telegramRelayPrompt.ts:28` | duplicate `IntelligenceFramework` union definition | the relay-prompt union is independent of the canonical one |

> **The PostUpdateMigrator filter-drop is the most dangerous** of these because it is a *correctness*
> bug for existing agents, not a startup error: `getEnabledFrameworks()` reads the persisted
> `enabledFrameworks`, then `.filter((f): f is 'claude-code' | 'codex-cli' => f === 'claude-code' ||
> f === 'codex-cli')` — so a `gemini-cli` entry is silently dropped, and any migration gated on
> "gemini enabled" never fires on update. Extend the predicate to include `'gemini-cli'` (Migration
> Parity, §8). This is the structural twin of the codex `getEnabledFrameworks` gating at `:1842`/
> `:4214`.

## 5. Testing (3-tier — NON-NEGOTIABLE per the Testing Integrity Standard)

**Tier 1 — Unit (`tests/unit/`)** — pure logic, no live binary:

- `geminiSpawn` arg-construction (asserts against the **canonical argv** of §3.3,
  `gemini -m <model> --approval-mode default -p <prompt>`): given a model + prompt, that exact
  `gemini` argv is built; stdin is ended; the prompt occupies **exactly one argv slot** (the value of
  `-p`, with no `--` separator on the canonical path); `--approval-mode default` is present; the env
  passed to the child contains only allowlisted vars and the build **unconditionally deletes** each
  of `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`/`GOOGLE_GENAI_USE_VERTEXAI`/
  `GOOGLE_CLOUD_PROJECT` (the **required** `geminiKeyLeakageCanary` analog of
  `openaiKeyLeakageCanary`, asserted as a unit test — MED a).
- **Yolo-mode safety (HIGH):** the one-shot argv **never** contains `-y`, `--yolo`, or
  `--approval-mode yolo`; `--approval-mode default` is present (pinned at the call site). Mirrors the
  codex sandbox-pin assertion.
- **Output-byte cap (MED b):** feeding `spawnGeminiAndWait` an over-cap stream stops capture at
  `maxOutputBytes` and flags the result truncated (the codex `Buffer.concat` is unbounded — this
  test guards the improvement).
- **Hooks observe-only + constant-command (MED c) — required IF `HookEventReceiver` is shipped
  (CONDITIONAL, §3.7):** `hookEventReceiver` emits events but injects no decision by default; the
  hook-registration path rejects/ignores any command string derived from non-constant (session/model)
  content. If the hook-return contract is **not** characterized within Step 2, the receiver is
  deferred (a `programNeeds` entry, §9) and this test is deferred with it — not shipped against an <!-- tracked: programNeeds -->
  invented contract.
- `eventNormalizer`: known recognized shapes → expected `CanonicalEvent`; an unrecognized line →
  `ProviderRawEvent` (never null-dropped); blank/ANSI noise → `null`. (Driven by **fixture lines
  captured from the live binary at build**, §6 — not invented shapes. The `ProviderRawEvent`-never-
  drop invariant makes the normalizer *correct* even before the full event vocabulary is
  characterized, so the normalizer itself is MANDATORY-safe; the recognized-shape canary is
  CONDITIONAL on §6 characterization.)
- `config.configFromEnv`: `GEMINI_PATH` override honored; falls back to `detectFrameworkBinary`;
  default model resolves to `gemini-2.5-flash`; no hardcoded absolute path present.
- `resolveModelForFramework('gemini-cli', tier)`: each generic tier maps to the intended model id;
  a raw model id passes through.
- **DRIFT CANARY (§4.0.4) — REQUIRED, asserts OUTPUT not just branch identity:** a test enumerates
  every `IntelligenceFramework` member and, for each, feeds `ThreadResumeMap.jsonlExists`,
  `RateLimitSentinel`, and `CompactionSentinel` a **synthetic fixture** (a fabricated session-layout
  path / known session-id) and asserts the resolver returns the **CORRECT resolved path/session for
  that framework's input** — not merely "resolves to a non-Claude branch." A resolver that dispatches
  into the gemini branch but returns the **wrong** gemini session fails this test, just as a missing
  branch does. Adding a future framework member with no resolver (or a wrong one) **fails CI**. This
  is the semantic-correctness, test-forced conversion of the §4.0.1–2 silent landmines (per-framework
  resolver contract, hermetic — no live binary).
- **Wiring-integrity tests** (required for every DI'd component): the factory's `impls` map sets a
  non-null impl for every flag in `geminiCliCapabilities`, and declares no flag it doesn't
  implement (the honest-declaration invariant, asserted both directions).

**Tier 2 — Integration (`tests/integration/`)** — the registry + framework selection pipeline:

- Register `createGeminiCliAdapter(...)` on a `Registry`; `registry.resolve({ requires:
  [OneShotCompletion] })` returns the Gemini adapter (and `pinTo: GEMINI_CLI_ID` works). *(Registry
  is the parity-harness surface, §3.2 — this proves the adapter is well-formed, not that it's the
  live path.)*
- **The ALIVE path:** `buildIntelligenceProvider({ framework: 'gemini-cli', binaryPath })` returns a
  non-null, circuit-breaker-wrapped `GeminiCliIntelligenceProvider`; with `binaryPath` pointed at a
  non-existent file (and detection stubbed to null) it returns null per the contract.
- `frameworkFromEnv` maps `INSTAR_FRAMEWORK=gemini-cli` (and `=gemini`) → `'gemini-cli'`.
- `TopicFrameworksStore` accepts binding a topic to `'gemini-cli'` and rejects an unknown value.
- `buildInteractiveLaunch('gemini-cli', ...)` / `buildHeadlessLaunch('gemini-cli', ...)` return a
  launch spec (no `BUILDERS` map miss / exhaustiveness gap).
- **Process-signal detection:** `matchProcessSignal('<gemini command line>')` returns the
  `GEMINI_CLI_SIGNAL`, and a `gemini mcp` command line is **excluded** (the `gemini-mcp` exclusion
  substring, §4.0.3) — both sides of the boundary.

**Tier 3 — E2E "feature is alive" (`tests/e2e/`)** — *the single most important test* (umbrella's
Step-2 acceptance = the body works):

- Configure an agent with `framework: gemini-cli`; run a real one-shot through the provider
  (`gemini -m gemini-2.5-flash "<known-answer prompt>"`); assert exit 0 and the expected text in
  the returned message — a **PONG-style** smoke assertion mirroring the codex
  `Reply-with-PONGXYZ` smoke call. This proves the existing mind can run on the Gemini body.
- Gated to skip cleanly when the binary is absent (CI without Gemini installed must stay green),
  but **must run and pass on the dev box where v0.25.2 is installed** before the spec's build is
  considered done.

**Canaries — the discovered contracts become CI-enforced, not willpower (MAJOR a).** v1 framed the
hook-contract + event-schema discovery as "verify at build" — a one-time human action that goes
stale silently. The codex adapter does NOT do that; it ships canaries (verified:
`canary/codexEventNormalizerCanary.ts`, `codexHookContractCanary.ts`, `codexSessionLayoutCanary.ts`,
`openaiKeyLeakageCanary.ts`) that **fail loudly when the upstream contract drifts**. Per Rule 3.2
(every state-detection path needs a drift canary) the Gemini body extends that precedent:

- **`geminiEventNormalizerCanary`** — known-shape fixtures captured against Gemini v0.25.2; asserts
  each maps to the expected `CanonicalEvent`. Fails when a Gemini version changes event shapes. *Only
  added once the live event vocabulary is characterized (§6)* — but it **is** added as the
  characterization's required output, not postponed.
- **`geminiHookContractCanary`** — pins the `gemini hooks` return-shape and event-kind set
  discovered in §6, and **fails CI when the contract drifts**. This is the structural replacement for
  "we verified the hook contract by hand once." The §13 acceptance criterion below makes "hook
  contract characterized + canary added" a *done-gate*, so the body cannot ship with the hook
  contract merely eyeballed.
- **`geminiKeyLeakageCanary`** (required, MED a) and a **`geminiSessionLayoutCanary`** (asserts the
  `~/.gemini` layout the resume resolver depends on, mirroring `codexSessionLayoutCanary`).

The canaries surface to **Echo only** via the DegradationReporter (mirroring the codex canaries' Rule
3.1 fallback) — they are a fleet-quiet drift alarm, not a user-facing one.

## 6. What must be discovered against the live binary (honest unknowns)

Per the task's mandate to be honest about what can't be fully verified without live iteration,
these are characterized **in the build, by running the binary**, and the spec's claims for them are
**pending verification**, not asserted:

- **The one-shot output schema** consumed by `eventNormalizer` — the exact line shapes Gemini emits
  (is there a `--json`-equivalent stream? what are the event `type` names and payload fields?). The
  verified fact today is only that *human-readable final text* lands on stdout for `-p`. The
  machine-event vocabulary is unknown.
- **The `gemini hooks` contract specifics** — the exact event-kind names the subsystem emits, how
  hooks register (config file? `gemini hooks <subcmd>`?), and the hook-return JSON shape /
  exit-code semantics (Claude/Codex-compatible or Gemini-native?). This determines
  `supportedEventKinds()` and whether `hookEventReceiver` can honor block/approve decisions.
- **Native pre-compact** — whether the richer hook subsystem includes a pre-compact event (if so,
  surface it; if not, port the codex synthesis). Decides §3.6.
- **On-disk session layout** under `~/.gemini` (for `sessionPaths`), though `--list-sessions`
  provides a layout-independent programmatic listing regardless.
- **The credential env surface** — whether a `GEMINI_API_KEY`/`GOOGLE_API_KEY`/etc. env path can
  override cached OAuth and silently bill an API account. **Note:** this discovery only sharpens the
  *rationale* — the unconditional hard-delete of the five named Google/Gemini billing vars + the
  required `geminiKeyLeakageCanary` (§3.3, MED a) ship **regardless of the finding**, because a
  false-negative (silent billing) is asymmetrically costly. The build records *which* var actually
  overrides, for the parity notes; it does not gate the delete on that.
- **The `gemini hooks` return-shape + event-kind set** — pinned by `geminiHookContractCanary` once
  characterized (§5). The §13 done-gate requires the canary, so this unknown closes into a
  CI-enforced contract, not a one-time eyeball.
- **Exact model ids** for the tier map beyond the verified `gemini-2.5-flash` (the capable-tier id).

Where a primitive **cannot be fully verified without deep live iteration**, the build implements
the honest minimum (e.g. normalizer with `ProviderRawEvent` fallback so it's *correct* even on an
unknown schema) and records the residual as a §9 `programNeeds` item rather than overclaiming.

## 7. Honest scope statement (no overclaiming)

This step delivers a **minimal-viable body**, not behavioral parity. Concretely, "done" for Step 2
means: **(a)** the six registration points wired and type-checking **plus the §4.0 framework-
monitoring surfaces and §4.3 hand-audit discharged**, **(b)** a one-shot completes end-to-end through
`buildIntelligenceProvider` → `GeminiCliIntelligenceProvider` (Tier-3 alive proof on the dev box —
**not** the dormant registry), **(c)** the buildable observability/control subset (§3.5–3.6)
implemented honestly against the live binary with its drift canaries, and **(d)** an honest
capability declaration plus the two `programNeeds` records (parity gap + the named loop driver). It
does **not** mean Gemini has all the primitives Codex reached, nor that Gemini is ready for the
mentorship loop — that readiness is gated by ongoing parity work (§9), the native loop driver
(`need-gem-002`), and Steps 3–5.

## 8. Migration Parity + Agent-Awareness

**Migration Parity Standard** (agent-installed files must reach existing agents on update):

- **`--framework` literal-union + config defaults.** Adding `'gemini-cli'` to the CLI option and to
  `SUPPORTED_FRAMEWORKS` is *new-agent-via-`init`* surface, but existing agents that want to bind a
  topic to Gemini need the store to accept the value on update. Since `SUPPORTED_FRAMEWORKS` is
  shipped **in code** (not an installed config file), it reaches existing agents on the version
  bump automatically — **no `migrateConfig` entry required** for the value itself. Confirm at build
  that no installed `.instar/config.json` field *enumerates* the allowed frameworks in a way that
  would need a `migrateConfig` patch; if one exists, add the idempotent existence-checked migration.
- **PostUpdateMigrator `getEnabledFrameworks` filter-drop (REQUIRED — §4.3).**
  `src/core/PostUpdateMigrator.ts:113` `getEnabledFrameworks()` filters the persisted
  `enabledFrameworks` down to `'claude-code' | 'codex-cli'` (`:121–123`), **silently dropping
  `gemini-cli`**. Any migration gated on "gemini enabled" would never fire for an existing
  gemini-bound agent. Extend the predicate to include `'gemini-cli'`. This is a *correctness* fix
  for existing agents, not just new-agent surface — it is the Migration-Parity heart of this spec.
- **No new hooks / skills / settings.** The minimal body adds none, so no `migrateSettings` /
  `migrateHooks` / `installBuiltinSkills` work is triggered. (This is a *deliberate* consequence of
  the meta-lesson: the mind is unchanged.)
- **NEXT.md publish requirement (src-touching).** This step touches `src/` (the union, the
  factory/class, the resolvers, the new adapter). Per the fleet release path, a `src/`-touching merge
  **must** ship a `NEXT.md` release fragment or it silently skips publish (the fleet-release fragility
  this fleet has hit repeatedly). The build's done-gate (§13) includes a well-formed `NEXT.md`
  describing the gemini-cli body; the §13 ELI16-overview gate and the rendered ELI16 tunnel-link for
  review also apply since this is a reviewed src change.

**Agent-Awareness Standard** (`generateClaudeMd` / `migrateClaudeMd`):

- The adapter itself is **infrastructure, not an agent-facing capability** — an agent doesn't "call"
  the Gemini adapter conversationally. So the bar for a `generateClaudeMd` section is: *does an
  agent need to know `gemini-cli` is a selectable framework?* For the **minimal body**, the honest
  answer is **only at the framework-selection surface** (init/setup). The spec's position:
  **do not** add a new agent-facing CLAUDE.md section for the adapter (it would advertise a
  capability — full Gemini agenthood — that isn't real yet, violating honest scope). The
  agent-awareness update lands **with the apprenticeship/parity work** that makes Gemini a usable
  agent, not with the bare body. If the build finds that `generateClaudeMd` *already* enumerates
  supported frameworks anywhere, update that list (and add the `migrateClaudeMd` content-sniffed
  patch) for accuracy — that's a factual list, not a capability claim.

## 9. Parity gap tracking — `programNeeds` (G7)

Full behavioral parity is **ongoing apprenticeship work**, recorded as structured `programNeeds`
entries following the **Step-0 schema** (`{ id, motivatedBy: <process-insight / evidence pointer>,
priority, statement }`, with evidence pointers in the canonical URI scheme `ledger:<id>` / `pr:<n>` /
`task:#N` / `thread:<id>`). This step emits **two** entries, not one — because the v1 single-entry
note silently dropped the native multi-turn loop driver (MAJOR b):

```json
[
  {
    "id": "need-gem-001",
    "motivatedBy": "task:#32 (full claude/codex parity audit) + the §3.7 honest-floor",
    "priority": "med",
    "owner": "apprentice (Codey) under Echo oversight",
    "target": "ongoing",
    "statement": "gemini-cli runtime adapter — full behavioral parity. Baseline shipped in Step 2: registration + one-shot transport (GeminiCliIntelligenceProvider) + config + honest capability subset + the buildable observability/control primitives + the framework-monitoring surfaces (§4.0). Remaining: the rest of the ~35 primitives the codex adapter reaches (full capability/, the rest of observability/ + control/ + integration/), each declared in capabilities.ts ONLY when its impl is real (parity-harness stub-vs-real); plus the live-discovered schema/hook-contract residuals from §6. Exercised through real mentee work in Steps 3-5."
  },
  {
    "id": "need-gem-002",
    "motivatedBy": "task:#28 (codex could NOT sustain multi-turn without a loop driver) + ledger:codex-autonomous-loop-driver + pr-approved 2026-05-30",
    "priority": "high",
    "owner": "apprentice (Codey) under Echo oversight",
    "target": "Step-4 prerequisite",
    "statement": "Native multi-turn LOOP DRIVER for gemini-cli. A one-shot `gemini -p` runs one turn and exits; nothing re-prompts while autonomous tasks remain. Codex hit this exact wall (task:#28) and could not be a multi-turn agent until the codexLoopDriver shipped (src: installCodexHooks.ts + AutonomousSessions.ts, gated behind autonomousSessions.codexLoopDriver.enabled; spec: docs/specs/codex-autonomous-loop-driver.md). Gemini needs the equivalent (a Stop-hook / end-of-turn re-prompt driver, framework-additive, dark behind a flag) to be a MENTEE in Steps 3-5 — the minimal body (one-shot only) explicitly does NOT deliver it. The codexLoopDriver is the porting pointer."
  }
]
```

> **The loop driver is deliberately surfaced, not absent.** v1 dropped it entirely. It is **out of
> scope for the minimal body** (the body is one-shot transport), but it is a **named Step-4
> prerequisite** with a high priority and the codex porting pointer — so it cannot silently fall
> through the apprenticeship gap. Whether it ships *as part of* the body or as the first Step-3/4
> slice is a sequencing call (§14.4); either way it is tracked, not forgotten. (This is the most
> consequential single primitive for the mentee role, which is precisely why its v1 omission was a
> MAJOR finding.)

This keeps the loop **open and re-surfaced** (Close the Loop / Untracked = Abandoned): both gaps are
tracked program requirements, and **Step 1's spec (the umbrella's tier-3 instance-gate) is required
to cite these need-ids**, so the umbrella's "nothing built that isn't traceable to a program-need"
claim stays checkable. The parity primitives get built incrementally as the Codey→Gemini mentorship
surfaces the need for each (Steps 3–5), each a small slice the apprentice ships under oversight.

## 10. Risks

- **R1 — Gemini's event/output schema is unknown (§6).** The normalizer is the highest-drift
  surface (same as Codex — "every minor version may add event types"). *Mitigation:* the
  `ProviderRawEvent`-never-drop invariant makes the normalizer *correct* even under an unknown or
  changing schema; a canary is added once the live vocabulary is characterized. Honest declaration
  means an unverified observability primitive is simply **not declared**, so the registry never lies.
- **R2 — The `gemini hooks` contract may differ from Claude/Codex semantics — and is an
  untrusted-execution surface.** *Mitigation (hardened, §3.8):* the receiver ships **observe-only by
  default**, not as a fallback — decision-injection into an executor is a separately gated,
  contract-characterized behavior. `geminiHookContractCanary` (required, §5) pins the contract and
  fails CI on drift. No hook command is ever written from session/model-derived content.
- **R3 — Credential-leak class (the Codex Rule-1 analog).** *Mitigation (hardened, §3.3 MED a):* the
  five named Google/Gemini billing vars are **unconditionally** deleted from the child env and the
  `geminiKeyLeakageCanary` is **required**, regardless of whether the build confirms a given var
  overrides cached OAuth — a false-negative (silent billing) is asymmetrically costly. (No longer
  conditional on "if a billing-capable key exists.")
- **R4 — Yolo / unbounded-output class (new, §3.3 HIGH + MED b).** Gemini's `-y/--yolo` and
  `--approval-mode yolo` would let the model act without confirmation; an unbounded output stream
  could OOM the supervisor. *Mitigation:* `--approval-mode default` pinned at the call site (yolo is
  capability-only, never reachable from `OneShotCompletion`); output byte-capped (improving on
  codex's unbounded `Buffer.concat`); both asserted by unit tests.
- **R5 — Framework-blind silent surfaces (new, §4.0).** A new framework silently breaks resume
  (`jsonlExists`), recovery-verification (RateLimit/Compaction sentinels), and process-detection —
  none of which the compiler catches. *Mitigation:* §4.0 wires the gemini branches; the **drift
  canary** (§4.0.4) converts the class into a CI failure so Step 3+ frameworks can't reintroduce it.
- **R6 — Multi-framework shared-config collision (deferred, N5).** Codex hit a last-writer-wins MCP <!-- tracked: programNeeds -->
  registration bug across concurrent agents (`codexThreadlineMcpFlags`). Gemini's `gemini mcp` may
  have an analog. *Mitigation:* noted; addressed in parity work *unless* live multi-agent testing
  forces it sooner.
- **R7 — Overclaiming parity (the meta-risk) — including compiler-enforcement overclaim.** The
  temptation is to call the body "Gemini parity," or to claim the union extension forces all wiring.
  *Mitigation:* §7 honest-scope + §9 `programNeeds` + the parity-harness stub-vs-real check (a
  declared-but-fake capability is a *test failure*) + the §4.3 hand-audit list + the §4.0.4 drift
  canary that together make the "structure" honest. **The Body and the Mind** is the discipline: the
  body is built; the body is not the whole agent.

## 11. Future (out of scope, noted for the apprentice)

- **ACP (`--experimental-acp`) — and *why* one-shot spawn is the Step-2 bootstrap instead.**
  Gemini's Agent Client Protocol is a richer bidirectional transport that is **likely closer to a
  long-lived agent substrate** than the one-shot/spawn model. **Rationale for deferring it:** one-shot
  `gemini -p` spawn is chosen as the Step-2 bootstrap precisely because it is **already verified
  stable and cleanly testable** (clean stdout + exit 0, a deterministic argv, a hermetic unit surface)
  — the alive proof must rest on a transport we can assert today, not an `--experimental-` surface
  whose contract is unproven. ACP is therefore deferred until **after** the alive proof lands. When <!-- tracked: programNeeds -->
  the native multi-turn loop-driver work (`need-gem-002`, §9) is taken up, it MUST **re-evaluate ACP
  first** — before reflexively porting codex's Stop-hook/end-of-turn loop approach — because ACP's
  bidirectional, long-lived nature may be the more natural substrate for a sustained agent than
  re-prompting a series of one-shots. A future transport primitive could target ACP instead of (or
  alongside) `spawn`. Out of scope for the minimal body; flagged for the parity arc.
- **The remaining parity primitives** (§9 `need-gem-001`) — built incrementally through Steps 3–5
  as the mentorship surfaces each need.
- **The native multi-turn loop driver** (§9 `need-gem-002`) — the Step-4 prerequisite that makes
  Gemini a sustainable mentee; ported from the codexLoopDriver. Out of scope for the one-shot body,
  but **named**, not dropped.

## 12. Relationship to the constitution

- **The Body and the Mind** (parent principle): the runtime adapter is *the body* for a new
  framework. This step is the most literal possible expression of that article — it builds a body so
  the (already-existing, framework-agnostic) mind can run on a new substrate. The Codex proof that
  *the real onboarding work is the adapter, not the agent-facing layer* is this article made
  executable a second time.
- **Structure > Willpower (honestly scoped):** the structural gate is **three** things, not the
  union alone — (1) the compiler-forced `never`-switch + `Record<IntelligenceFramework, …>` maps,
  (2) the **drift canary** (§4.0.4) that converts the silent framework-keyed resolvers into
  test-forced ones, and (3) the explicit **hand-audit checklist** (§4.3) for the ~10 parallel
  hardcoded unions the compiler cannot relate to the canonical type. v1's claim that "the union
  forces the rest at compile time" was the *willpower* trap dressed as structure — the real structure
  is the canary + the list. The Wall-is-a-Hypothesis lesson applied to ourselves: an asserted
  compiler-guarantee with no test is a hypothesis.
- **Honest declaration / Signal vs Authority:** declaring only real capabilities (the parity-harness
  stub-vs-real check as *authority*, the capability list as *signal*) keeps the registry truthful;
  the registry adapter is the harness surface, the `GeminiCliIntelligenceProvider` is the live one.
- **Close the Loop / Untracked = Abandoned:** the parity gap AND the native loop driver (§9) are
  tracked `programNeeds` entries Step 1's gate must cite — never a private "we'll finish it later."
  The loop driver's v1 omission is the exact failure mode this article exists to prevent.

## 13. Acceptance criteria (Step-2 done-definition)

1. `IntelligenceFramework` includes `'gemini-cli'`; the codebase type-checks (all
   `Record<IntelligenceFramework,…>` maps + the `never`-switch handle it).
2. **The §4.3 hand-audit checklist is fully discharged** — every parallel hardcoded
   `'claude-code' | 'codex-cli'` union + framework-keyed branch in the list either handles
   `gemini-cli` or is explicitly out-of-scope-with-rationale. (The compiler does NOT enforce this;
   the checklist is the gate.)
3. **The §4.0 framework-monitoring surfaces are wired:** `ThreadResumeMap.jsonlExists` has a
   gemini-layout dispatch; `RateLimitSentinel` + `CompactionSentinel` recovery-verification have a
   gemini branch; `frameworkProcessSignals` + `frameworkActivitySignals` have gemini entries.
4. **The DRIFT CANARY (§4.0.4) is added and passes** — it asserts each framework resolves to its
   **correct** jsonl/rollout (synthetic-fixture, output-asserting — not just "a non-Claude branch
   exists"), and fails CI if a future framework member has no resolver or resolves the wrong session.
5. **The MANDATORY floor (§3.7) ships:** `src/providers/adapters/gemini-cli/` exists
   (registry/parity-harness surface) AND `src/core/GeminiCliIntelligenceProvider.ts` exists (the
   ALIVE transport class) with `index.ts`, `config.ts`, `capabilities.ts`, the transport one-shot
   (`OneShotCompletion`), `SessionId`, and `HardKill`. The **CONDITIONAL** primitives
   (`HookEventReceiver` / `CompactionLifecycle` / `SessionResumeIndex` full-layout parsing, §3.5–3.6)
   ship in Step 2 **only if their live contract is characterized within Step 2** — otherwise each
   uncharacterized one is **explicitly sequenced to a later step with a `programNeeds` entry (§9), not
   shipped half-built.** Deferring an uncharacterized conditional primitive is a clean pass, not a
   failure.
6. `registry.resolve({ requires: [OneShotCompletion], pinTo: GEMINI_CLI_ID })` returns the Gemini
   adapter (Tier-2, harness surface).
7. `buildIntelligenceProvider({ framework: 'gemini-cli' })` returns a circuit-breaker-wrapped
   `GeminiCliIntelligenceProvider` on the dev box; null when the binary is absent (Tier-2, the live
   path).
8. The Tier-3 "feature is alive" E2E passes on the dev box: a real `gemini-cli` one-shot returns the
   expected smoke text — **through `buildIntelligenceProvider`/`GeminiCliIntelligenceProvider`**, not
   the dormant registry.
9. **Security gates pass:** the one-shot argv never contains `-y`/`--yolo`/`--approval-mode yolo` and
   pins `--approval-mode default`; the prompt is one argv slot after `--`; the five named
   Google/Gemini billing vars are unconditionally deleted from the child env; output is byte-capped;
   the hook receiver is observe-only by default and never writes a non-constant hook command.
10. **Canaries present:** `geminiKeyLeakageCanary` is **required** (it guards the MANDATORY safety
    floor and ships regardless). The contract canaries `geminiHookContractCanary` +
    `geminiEventNormalizerCanary` + `geminiSessionLayoutCanary` are required **for whichever
    CONDITIONAL primitive (§3.7) is shipped in Step 2** — if a conditional primitive is declared, its
    contract MUST be characterized and its canary added (so **"hook contract characterized + canary
    added" is a done-gate _for a shipped `HookEventReceiver`_**, never "verified by hand"). A
    conditional primitive that is **deferred** (its contract not characterized within Step 2) carries <!-- tracked: programNeeds -->
    no canary requirement here — it is tracked as a `programNeeds` entry (§9) instead.
11. `capabilities.ts` declares only implemented primitives; the wiring-integrity test passes both
    directions (no undeclared impl, no declared-but-missing impl).
12. The §9 `programNeeds` entries (BOTH: parity gap + the named native loop driver) are recorded with
    evidence pointers, per the Step-0 schema.
13. **Migration Parity:** `PostUpdateMigrator.getEnabledFrameworks` no longer filter-drops
    `gemini-cli`; a well-formed `NEXT.md` ships (src-touching); the ELI16 companion + a rendered
    clickable ELI16 tunnel link accompany the review.
14. All three test tiers green; the full suite is green (Zero-Failure Standard).
15. The §6 live-discovered facts (one-shot schema, hook contract, credential env, model ids,
    `~/.gemini` layout) are recorded in the build's notes so the next parity slice doesn't re-derive
    them.

## 14. Open decisions for Justin

> Note: the v1 "should there be a `GeminiCliIntelligenceProvider` class at all?" decision is
> **resolved** — round-1 grounding showed the registry adapter is dormant and the live path runs
> through this class, so it is now a BLOCKING prerequisite (§3.2), not an open question. Only the
> narrow *factoring* (delegate vs thin-parallel) remains a build-time call.

1. **`GeminiCliIntelligenceProvider` internal factoring (§3.2.3, narrowed).** The class is required;
   the only open question is whether it *delegates* to the registry adapter's `OneShotCompletion`
   primitive (single source of transport truth) or carries a thin parallel spawn like
   `CodexCliIntelligenceProvider`. Recommendation: decide at build once the transport primitive is in
   hand. (No longer a question of *whether* the class exists.)
2. **Agent-awareness timing (§8).** Confirm the position that the **minimal body adds no new
   agent-facing CLAUDE.md section** (the awareness update lands with the parity/mentorship work that
   makes Gemini a usable agent), to avoid advertising agenthood that isn't real yet.
3. **Capability floor.** Is the minimal declared set in §3.7 (`OneShotCompletion`,
   `HookEventReceiver`, `SessionResumeIndex`, `CompactionLifecycle`, `SessionId`, `HardKill` + any
   honestly-buildable extras) the right Step-2 floor, or should the floor be even smaller (transport
   + the alive proof only) with everything else folded into the parity arc?
4. **Native loop driver sequencing (§9, `need-gem-002`).** The multi-turn loop driver is a named
   Step-4 prerequisite the minimal body does not deliver. Should it be **(a)** folded into this Step
   2 body now (dark behind a flag, porting the codexLoopDriver), or **(b)** left as the first
   Step-3/4 slice the apprentice ships under oversight? Recommendation: **(b)** — it is mentee-loop
   machinery, the natural first real apprenticeship task, and keeps Step 2 a clean one-shot body. But
   it must be *named*, not absent (which it now is). **ACP note (§11):** whichever sequencing is
   chosen, the loop-driver work MUST **re-evaluate ACP (`--experimental-acp`) before porting codex's
   Stop-hook approach** — ACP's bidirectional long-lived transport may be the more natural multi-turn
   substrate than re-prompting one-shots. One-shot spawn is the Step-2 bootstrap only because it is
   already verified-stable and testable; that does not make it the right long-lived transport.

## 15. Convergence changelog (round 1 → v2)

Round-1 reviewers (code-grounded) found that v1 mapped its registration surface from
`ls src/providers/adapters/openai-codex/` rather than the framework-aware codebase, so it missed the
silent-failure surfaces and overclaimed compiler-enforcement. Every change below is grounded against
the live tree (file:line verified; path corrections in §4.0a).

**BLOCKING — engage the codex landmines (new §4.0).**
- Added **§4.0 "Framework-monitoring surfaces the codex onboarding had to fix"** enumerating the
  surfaces a new framework silently breaks: `ThreadResumeMap.jsonlExists` (`:353`, the task #24
  resume root re-opened — no gemini layout → silent `false`); `RateLimitSentinel` (`:475`) +
  `CompactionSentinel` (`:444`) recovery-verification (the `=== 'codex-cli'` binary branch, tasks
  #26/#33 — no gemini branch → silent failure); `frameworkProcessSignals.ts:89` (compiler-forced
  `Record`, NAMED the required `GEMINI_CLI_SIGNAL` with `binaryPattern`/`nodePattern`/exclusion
  substrings) + the sibling `frameworkActivitySignals.ts:99`.
- Added the **DRIFT CANARY** (§4.0.4, §5): a test that fails CI when a new `IntelligenceFramework`
  member has no jsonl/rollout resolver — converts the silent surfaces into test-forced ones (Wall-is-
  a-Hypothesis / L5). Cites `task:#24/#26/#28/#33`.

**CRITICAL — false compiler-enforcement claim replaced with a hand-audit list (§4.3).** Verified +
enumerated the ~10 parallel hardcoded `'claude-code'|'codex-cli'` unions the compiler does NOT catch:
`types.ts:65,114,123,134,2055,2136`; `Config.ts:320` (`checkFrameworkPrerequisite`) + `:358`
(`resolveConfiguredFramework`); `commands/init.ts:111` (`resolveEnabledFrameworks` — **corrected from
the non-existent `src/core/init.ts`**); `FrameworkSessionStore.ts:25,101`; `PreCompactionFlush.ts:76`;
`ResumeValidator.ts:42`; `StuckInputSentinel.ts:228` (**at `src/core/`, not `src/monitoring/`**);
`PostUpdateMigrator.ts:113` `getEnabledFrameworks` (would **silently filter-drop** gemini-cli). Stated
the rule: only the `never`-switch (`intelligenceProviderFactory.ts:87`) + the
`Record<IntelligenceFramework,…>` maps (`frameworkSessionLaunch.ts:242/429`,
`frameworkProcessSignals.ts:89`, `frameworkActivitySignals.ts:99`, `skillParityRule.ts:584`) are
compiler-forced; everything else is a silent fall-through.

**HIGH — registry-adapter dormancy / the real path is `buildIntelligenceProvider` (§3.2).** Grounded
against `server.ts` (~`:2432`, *"no adapters are registered against the providers registry yet"*).
Rewrote so the registry adapter (`src/providers/adapters/gemini-cli/`) is the parity-harness/future-
routing surface (matches codex dormancy), and the **alive proof flows through `buildIntelligenceProvider`
→ a `GeminiCliIntelligenceProvider` class** (codex equiv `CodexCliIntelligenceProvider` verified at
`src/core/`). Promoted that class from "open decision" to a **BLOCKING prerequisite**.

**HIGH — half-wired gemini-cli state (§3.2.6, §4.3).** Verified `route.ts:47` `KNOWN_FRAMEWORKS`
already lists `'gemini-cli'` + `:53` a model, but `route.ts:57` `resolveFramework` has no gemini
branch (silent fallthrough); `cli.ts:313,348` allowlists reject `gemini-cli` at arg-parse;
`reflect.ts:356` hardcodes the claude fallback. All added to the checklist.

**HIGH (security) — yolo mode (§3.3).** One-shot transport hard-pins `--approval-mode default` at the
call site (mirrors codex `oneShotCompletion.ts:36` `?? 'read-only'`), never reachable from
`OneShotCompletion`; `yolo`/`-y` gated as capability-only (codex `danger-full-access` analog); unit
test asserts the argv never contains `-y`/`--yolo`/`--approval-mode yolo`.

**MED (security, §3.3/§3.8).** (a) Committed the concrete billing-var allowlist + **unconditional**
hard-delete of `GEMINI_API_KEY`/`GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS`/
`GOOGLE_GENAI_USE_VERTEXAI`/`GOOGLE_CLOUD_PROJECT` (mirrors codex's unconditional `delete
env.OPENAI_API_KEY` at `codexSpawn.ts:145–147`); the key-leak canary is now REQUIRED. (b)
output-byte cap in `spawnGeminiAndWait` (codex's unbounded `Buffer.concat` is a hole — improved on).
(c) `gemini hooks` receiver is observe-only **by default** (not a fallback); never writes an
executable hook command from session/model-derived content. (d) one-shot prompt is exactly one argv
slot after a `--` separator.

**MAJOR (lessons, §5/§9/§13).** (a) Hook-contract + event-schema discovery is now a **CANARY**
(`geminiHookContractCanary` + `geminiEventNormalizerCanary`, extending the codex
`codexEventNormalizerCanary` precedent), not "verify at build" — and "hook contract characterized +
canary added" is a §13 done-gate. (b) The native multi-turn **loop driver** (codex task #28) is no
longer absent: it is `programNeeds` entry `need-gem-002` (high, Step-4 prerequisite) with the
codexLoopDriver porting pointer + task id, and §14.4 is the sequencing decision.

**Folded-in confirmations (already correct, kept).** `detectFrameworkBinary('gemini')` IS wired
(`Config.ts:117` union + `:171` `~/.gemini/bin` probe); `FRAMEWORK_SHADOW_FILES` already maps
`gemini-cli → GEMINI.md` (`IdentityRenderer.ts:40`); the env-allowlist Rule-1a posture +
ProviderRawEvent-never-drop normalizer carried from codex. Added the NEXT.md publish requirement
(src-touching) + the rendered ELI16 tunnel-link review requirement (§8, §13).

**Kept the good parts.** The Body-and-the-Mind framing, the honest-scope statement (§7), and the
parity-harness stub-vs-real authority all retained — sharpened, not replaced. The ELI16 companion is
lightly synced (the silent-failure surfaces + the alive-path framing) without changing its scope.

**File:line verification status.** All claims in this version were checked against the live tree at
branch `echo/apprenticeship-step2-spec` (HEAD `v1.3.198`). Could-not-verify: none of the cited
surfaces — every file:line above was opened and confirmed. Genuinely-unknown (by design, §6): the
live Gemini event schema, the `gemini hooks` return contract, the `~/.gemini` on-disk layout, and
whether a Google billing env var actually overrides cached OAuth — these remain build-time discovery
items with canaries, not asserted facts.

## Convergence changelog (round 2 — codex gpt-5.5)

A second cross-model review (codex / gpt-5.5) of the v2 spec surfaced four targeted refinements; all
are applied above. (The reviewer's fifth finding — "dense local terms left undefined" — was a
context-truncation artifact: those terms are defined in-spec, so no change was made.)

**1. Split the acceptance floor into MANDATORY vs CONDITIONAL (§3.7, §5, §13).** The reviewer flagged
that making the `HookEventReceiver` / `CompactionLifecycle` / `SessionResumeIndex`-full-layout
primitives a *hard* floor holds Step 2 hostage to Gemini's poorly-documented internals (the hook-
return contract, the pre-compact event, the `~/.gemini` on-disk layout — none knowable without live
probing). §3.7 now splits the floor:
   - **MANDATORY** (ships in Step 2, non-negotiable): `OneShotCompletion`, `SessionId`, `HardKill`,
     config + binary detection, the full framework registration (factory case +
     `GeminiCliIntelligenceProvider` class + the §4.3 hand-audit list + the `BUILDERS`/model-map
     entries), the env-allowlist/yolo-pin/output-cap/credential-canary safety, and the
     framework-blind resolver fixes (`ThreadResumeMap` gemini path + the sentinel branches +
     `frameworkProcessSignals`/`frameworkActivitySignals` entries + the §4.0.4 drift canary).
   - **CONDITIONAL** (`HookEventReceiver` / `CompactionLifecycle` / `SessionResumeIndex` full-layout
     parsing): ship in Step 2 **only if** the primitive's live contract is characterized *within*
     Step 2 — otherwise explicitly sequenced to a later step with a `programNeeds` entry. Stated the
     rule that an uncharacterized conditional primitive is **NOT shipped half-built**; it's tracked,
     and deferring it is a clean pass, not a Step-2 failure. §13 criteria #5 and #10 and the §5 hooks/
     normalizer test bullets were updated to match.

**2. Pin ONE canonical argv (§3.3, §5).** v2 wavered between `-p <prompt>` and `-- <prompt>`. Pinned a
single canonical builder output: `gemini -m <model> --approval-mode default -p <prompt>`. The
injection/argv unit test now asserts against THAT exact output — prompt is exactly one argv element
(the value of `-p`), `--approval-mode default` present, no `-y`/`--yolo`/`--approval-mode yolo`.
Resolved the `--` vs `-p` ambiguity explicitly: with `-p` the `--` separator is unnecessary and
absent; `--` is required only on the non-canonical positional path, where it must precede the
positional prompt.

**3. Drift canary asserts resolver OUTPUT, not just branch identity (§4.0.4, §5, §13#4).** A canary
that only asserts "resolves to a non-Claude path" passes even when the resolver dispatches into the
gemini branch but returns the WRONG gemini session. Required per-framework resolver contracts tested
with **synthetic fixture paths/session-ids**, asserting the resolver returns the CORRECT resolved
path/session for a gemini input — semantic correctness (hermetic, no live binary), not just "a gemini
branch exists."

**4. Added a short ACP rationale (§11, §14.4).** Stated explicitly: one-shot `gemini -p` spawn is the
Step-2 bootstrap *because* it is already verified-stable and testable; `--experimental-acp` (Agent
Client Protocol — likely closer to a long-lived agent substrate) is deferred until **after** the <!-- tracked: programNeeds -->
alive proof; and the native loop-driver work (`need-gem-002`) MUST re-evaluate ACP **before** porting
codex's Stop-hook/end-of-turn loop approach.
