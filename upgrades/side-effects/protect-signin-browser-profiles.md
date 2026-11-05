# Side-Effects Review — protect saved sign-in profiles

Date: 2026-11-05. Author: Echo. Second-pass reviewer: browser_guard_review.

## Summary of the change

Tier 1, reversible enforcement of an existing safety rule; no credentials or profile data are migrated. Adds registry-based refusal to activation, CDP open, MCP startup/load/registration, and ordinary native browser/shell tools. Installs the hook on init and updates for Claude and Codex. Normal Chrome remains the repair path. Proportion: one independent review round; 20 files / 491 added lines including trace and audit; one initial commit/gate attempt. The full-suite fallback ratchet exposed a permissive canonicalization catch; it now rethrows permission and I/O failures, and treats only a nonexistent directory as lexical. The correction receives its own trace and targeted verification.

## Decision-point inventory

- PlaywrightProfileRegistry.computeActivation: reject registered Google profiles and directory aliases; writeActivation already recomputes at mutation time.
- ChromeCdpReloginBrowser.open: reject before profile mkdir/chmod or debug launch.
- BrowserMcpProfileGuard: mandatory preflight before interactive/headless/rerouted process launch, outside optional fail-open MCP trimming.
- dynamicMcpConfig ownership census: include Google profiles in existing MCP load/registration checks.
- SigninProfileGuard generated native hook: inspect explicit automated commands, launched script files, profile aliases and implicit browser MCP bindings.

## 1. Over-block

Normal Chrome with a full profile path originally matched the word playwright in its directory; independent review caught this and classification now checks automation syntax instead. Normal Chrome repair, registry reads and source edits have explicit allow tests. A corrupt registry/config refuses automated access rather than risking saved credentials. MCP startup refuses the unsafe session configuration; remove its saved-profile browser binding to continue. Disposable profiles stay allowed.

## 2. Under-block

The hook is a cooperative tool boundary, not an OS sandbox. Script inspection is bounded to direct JS/Python entry files up to 256 KiB; malicious wrappers/import chains/computed paths can evade textual inspection. The supported activation, built-in CDP and configured MCP startup/load/registration paths are checked independently. Previously running MCP processes retain their loaded profile binding even if the config changes; enforcement at startup protects new processes and does not retroactively fence a loaded browser. Existing unsafe MCP browsers require controlled offload/refresh through their normal owner. Historical sign-out causation remains unproven; no destructive reproduction on saved profiles is authorized or needed.

## 3. Level-of-abstraction fit

The profile registry owns the exact Google-account-to-directory relationship. Enforcement belongs where automation receives a persistent profile capability, before browser startup, plus the native tool boundary for ordinary ad hoc test scripts. No intent classifier or account-name heuristic decides ownership.

## 4. Signal vs authority compliance

Reference: [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md).
This is the hard-invariant/safety-guard exception: automation must not alter persistent sign-in state owned by a registered repair profile. It is not a competing-signals judgment about meaning or intent. The exact registry assignment supplies authority.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. Registry ownership is enumerable. Tool syntax only selects which execution capability is being requested.

## 5. Interactions

Shadowing: startup checks run outside optional MCP trimming and its fail-open catch. Existing Telegram profile protection remains; its legacy internal error names also cover Google ownership at that shared funnel. Double-fire: a startup refusal prevents later tool use; no duplicated external action. Races: activation rechecks ownership at write time and the runtime/hook reread current registry. A hostile concurrent filesystem mutation is outside the cooperative boundary. No control loop or repeated repair is added.

## 6. External surfaces

A refused activation returns 409 with normal Chrome repair guidance; native tools exit 2. No credential values or browser URLs are logged. No new operator-facing action or approval flow. No messaging changes. Existing agents receive the hook through the normal update path. Generated agent awareness explains the rule and failed-repair reporting.

## 6b. Operator-surface quality

No operator surface — not applicable.

## 7. Multi-machine posture

Machine-local BY DESIGN: cookies and physical browser profile directories are machine-bound. Every machine reads its own registry, including Windows directories; shipped enforcement updates independently on each install. No durable new state, user-facing notice, URL, status, health or capability verdict is introduced. Topic transfer cannot carry profile access to another machine.

## 8. Rollback cost

Revert the source and ship a patch. No profile, schema, vault or credential migration to undo. The previous lack of enforcement returns during rollback; normal Chrome repair is unchanged.

## Conclusion

The review caught full-path repair over-blocking and pre-tool MCP startup exposure; both are addressed. Tests exercise refusal before mutation, allowed normal repair and disposable profiles, HTTP activation, and installed hook execution for both frameworks. No laptop sessions or test agents were started.

## Second-pass review

**Reviewer:** browser_guard_review. **Independent read: concur.** Confirmed normal Chrome allow boundaries, all three startup lanes, mixed safe/unsafe MCP definitions, canonical aliases and Windows paths. Concur with the review; no remaining material design concern within the stated cooperative boundary.

## Class-Closure Declaration

No agent-authored-artifact defect — this fixes missing runtime enforcement of an existing explicit profile safety invariant. No self-triggered controller is added.
