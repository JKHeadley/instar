# Grok Build Integration Spec — external review pass 1

**Reviewer family:** grok (grok-4.6-build), run headless with all tools disabled and web search off.
**Date:** 2026-08-14
**Spec reviewed:** docs/specs/grok-build-framework-integration.md (draft, pre-convergence)
**Run accounting:** input=16716 cacheRead=128 output=9260 reasoning=6162 total=26104; reported cost field=0.01513952 (basis unresolved — see spec 0.1)

> Note: this is a single external family. Convergence is NOT claimed. A second family
> (codex) has not yet run.

---

1. **HIGH — §0 (verified table, “Headless runs bill against the subscription”)**  
   **Problem:** Stated as verified. It is inferred from the absence of two env vars plus a successful `-p` run. That does not establish the billing sink. The CLI may use a key in `auth.json`, `config.toml`, keychain, or another env name; the session JWT may be a metered credential; success only proves *some* credential worked. The unmatched `$0.00118558` is evidence the sink is unknown, not that it is subscription. The whole economic rationale and the §3.1/§8 “subscription-native” claim rest on this.  
   **Fix:** Do not call this verified. Require a billing-side confirmation (invoice line, account usage delta, or vendor-stated mapping from this JWT to the weekly pool) before treating grok-build as non-metered. Until then, classify every run as *billing-sink-unknown* and cap it as if it were API-metered.

2. **HIGH — §3.1 / §0**  
   **Problem:** Auth precedence is labeled “confirmed by probe.” The probe never ran the dual-credential cases: session+`XAI_API_KEY`, expired session+key, no session+key, key in config rather than env. Precedence and “fallback only when no session is active” are vendor-doc inferences.  
   **Fix:** Treat precedence as unverified. Land tests against the real binary for those four cases and parse the *actual* credential used (or refuse to enable until a run can prove it).

3. **HIGH — §3.1**  
   **Problem:** Adapter refuses only when `XAI_API_KEY` is set *and no session file exists*. If `auth.json` exists but the JWT is expired/revoked, the adapter proceeds; the CLI’s “active session” check fails and can silently fall back to the key. Same hole for `GROK_DEPLOYMENT_KEY` (observed in §0, never gated) and for keys in `config.toml`. This is the exact economic inversion §3.1 claims to prevent, with no signal.  
   **Fix:** Adapter-side policy: (a) parse `exp` and refuse expired/malformed tokens as unauthenticated; (b) if *any* API/deployment key is present in env or config, refuse (`grok-auth-apikey-forbidden`) even when a valid session exists, or strip those vars from the child env; (c) never rely on “file exists” as “session active.”

4. **HIGH — §3.3 / §13.5 / §9**  
   **Problem:** Per-machine mint is specified; account-level session semantics are not. Unhandled: login on machine B revokes machine A; concurrent-device caps; mid-run `exp` on a long ACP session; refresh that fails closed vs open. Token-exists checks on A will still look healthy while the server has invalidated the session.  
   **Fix:** Specify expiry/revocation as hard failures (`grok-auth-expired`, `grok-auth-revoked`), abort the session, do not retry as a generic stall. Confirm whether a second device-code login invalidates the first *before* authorizing the second machine. Re-check `exp` at launch and on resume, not only mid-run in a future stall doc.

5. **HIGH — §6.1 / §13.1**  
   **Problem:** The stated mitigation does not mitigate the risk. “Unknown ≠ healthy” only stops a green dashboard. It does not stop opt-in components, §8 reviewer, or spawned sessions from firing into an empty pool. Empirical burn of *successful* local calls cannot see remaining allowance, weekly reset, the other machine, CI, or the operator’s interactive use. You can have a stable burn rate and hit the wall.  
   **Fix:** Unknown quota ⇒ no automatic placement, no failure-swap, no proactive review. Require an explicit per-run/per-day token budget with a hard stop. Define the exact CLI failure shape for pool exhaustion and map it to a terminal, non-retried error. Lock §14: keep grok-build *out* of `internalFrameworkDefault` and the swap tail until a real remaining-allowance signal exists.

6. **HIGH — §3.3 / §6 / §13.5**  
   **Problem:** One weekly pool, two machines, plus operator TUI, plus any CI that honors §12. `FeatureMetricsLedger` is implied per-machine, so even the weak “empirical burn” view cannot see combined draw. Enabling via synced `enabledFrameworks` doubles burn with no lock.  
   **Fix:** Single writer for grok-build work, or a shared counter that both machines and CI update before launch. Do not enable on a second machine (or in CI) until that counter exists. Replicated “logged-in” metadata must not mark a machine ready.

7. **HIGH — §6 / §0 / §4.2**  
   **Problem:** Token/`total_cost_usd` evidence is only for `grok -p --output-format json`. The expensive path is `grok agent stdio` / TUI. Nothing verifies ACP or tmux sessions emit the same envelope. §6 still calls this framework fully covered; zero session rows will either false-alarm `usageCoverage` or silently omit the dominant burn.  
   **Fix:** Probe agentic usage or mark session accounting unverified. If ACP does not return tokens, fail the session’s metrics write (do not store zeros) and exclude grok-build from “not a cannot-surface exemption” until both transports report.

8. **HIGH — §8 / §4.2 / §4.1**  
   **Problem:** “Empty read-only scratch, no repo, web search off” is not confinement. Unspecified: whether grok’s default tools include shell/file/network; whether absolute paths (`~/.grok/auth.json`, other repos) are reachable; whether `--disable-web-search` is actually honored (not in §0); who answers ACP permission prompts. Auto-approve ⇒ sandbox escape. Hang-wait ⇒ wedged review. `--allow/--deny` is listed for one-shot only.  
   **Fix:** Same deny-all tool policy on reviewer and any untrusted one-shot; no shell; no absolute-path reads; strip net except the model endpoint; never auto-approve ACP permissions — deny-by-default and fail the review if a prompt would block.

9. **HIGH — §8 / §10 / §6.1**  
   **Problem:** Agents are told to *proactively* use grok as a third review family. Each review is a large, cache-heavy draw on an unreadable shared weekly pool that also serves the human. No circuit breaker. This is how the operator’s own SuperGrok allocation dies with no alarm until calls fail.  
   **Fix:** Reviewer eligibility is manual/opt-in per review, not a template-driven default. Cap concurrent and daily grok reviews. If a review cannot start or dies on quota/auth, fail the review door loudly — do not skip the family or report “no findings.”

10. **HIGH — §4.2 / §0 / §5**  
    **Problem:** “`grok agent stdio` speaks ACP” and “`-s/-r/-c` map directly onto `ResumeValidator` / reap / revival” are not in the verified table. Inferred from flag names and vendor shape. Wrong resume semantics ⇒ attach to the wrong session or lose history while reporting resumed.  
    **Fix:** Move ACP and resume to “not verified.” Do not wire resume/reap until a probe shows session-id equality, continue-vs-resume, and survival across process death. Until then, disable `-r/-c` and treat every launch as new.

11. **HIGH — §14 / §7**  
    **Problem:** Failure-swap eligibility is left open. Putting a quota-unknown, auth-fragile framework in `codex-cli → pi-cli → gemini-cli → …` means every upstream failure dumps onto grok until the weekly pool is gone, then those tasks fail too. Dark + 48-file type threading makes a default-case add easy.  
    **Fix:** Close the decision in this spec: not eligible for the automatic default chain or swap tail. Require a type-level exclusion, not a comment.

12. **MED — §2 / §2.1 / §3**  
    **Problem:** `GROK_HOME`-aware is asserted, not verified. Adapter defaults to `~/.grok/bin/grok` and `~/.grok/auth.json`. If `GROK_HOME` is set, auth, sessions, `leader.sock`, and possibly the binary live elsewhere ⇒ false unauthenticated, or a different install.  
    **Fix:** Resolve home the way the binary does. Auth, binary, and session paths must share that root.

13. **MED — §2.1 / §13.4**  
    **Problem:** Absolute path to `grok` mitigates adapter invocation only. The installer still drops `agent` on PATH and can collide with Cursor. Mitigation does not mitigate the stated machine-level risk.  
    **Fix:** Refuse install/register if `agent` on PATH is not this build (or isolate the install). Document that this adapter does not make the box safe for a future Cursor route.

14. **MED — §6 / §13.2**  
    **Problem:** “MAY record `total_cost_usd` but MUST NOT treat it as list-price” is discipline, not a control. Existing spend views that sum a cost column will ingest it and understate 2–6× (or mix bases). Cache-read tokens are 95%+ of the one sample; a later rate manifest that prices them as fresh input is equally wrong.  
    **Fix:** Store reported cost in a distinctly named field that current aggregators do not sum. Do not join cache-read tokens to uncached rates. Until the basis is known, dashboards show tokens only.

15. **MED — §0 (overhead) / §4.1 / §7**  
    **Problem:** n=1 one-word prompt (12,061 tokens, 11,520 cache reads) is treated as a fixed property. Graduation step 2 puts one-shot internal/typed calls on this harness. Small `--json-schema` glue calls can dominate the weekly pool while looking cheap.  
    **Fix:** Do not use grok-build for high-QPS internal completions until overhead is measured across cold/warm cache. Default internal typed calls stay on existing frameworks.

16. **MED — §11 / §10 / §7**  
    **Problem:** Dark registration vs `migrateConfig` adding “absent grok-build fields” and `migrateClaudeMd` injecting a proactive-use section. A list-append migrator undarks the fleet. Awareness without availability produces agent retries that look like framework flakes.  
    **Fix:** Migrator must not write `enabledFrameworks`. Awareness section must state “unavailable unless explicitly enabled” and must not instruct proactive use while dark.

17. **MED — §8**  
    **Problem:** `detectGrokReviewer` criteria unspecified. Binary-present detection fires on machines that have grok for other reasons but are not opted in, or on API-key-only installs that §3.1 would forbid.  
    **Fix:** Detect only when `enabledFrameworks` contains `grok-build` *and* a non-expired session exists *and* no API/deployment key is present.

18. **MED — §9 / §4.2 / §12**  
    **Problem:** Stall classes are named and then deferred to a future markdown file. That is not a design for expiry, invisible quota, `leader.sock`, ACP stall, or exit-0-empty. Exit-0-empty and schema-fail-with-empty are silent degrades for every `--json-schema` consumer. `leader.sock` + concurrent `-p` and `agent` on one host is unanalyzed.  
    **Fix:** Specify detection, terminal vs retryable, and recovery in this spec. Exit 0 with empty/unparseable output is a hard failure, not a successful empty result. Serialize against the leader socket or treat lock failure as loud unavailable.

19. **MED — §12 / §6.1**  
    **Problem:** Integration/E2E that “carry real token counts” and “answer 200” imply a live binary and a live SuperGrok session in CI — a third drawer on the same unreadable pool — or the tests are stubbed and do not prove wiring.  
    **Fix:** Split: hermetic tests with recorded fixtures for parsing/policy; one gated live canary, not on the operator’s interactive pool. Never put production session tokens in CI.

20. **MED — §1 / §5**  
    **Problem:** “Byte-identically unaffected” if not opted in is a hope. A new union member across ~48 files commonly turns exhaustiveness failures into `default` branches (routing, signals, quota, swap).  
    **Fix:** Require compile-time exhaustiveness (no default) and a golden “framework absent ⇒ same bytes/behavior” test for routing, quota, and reviewer registration — not just “does not register.”

21. **MED — §3.2 / §13.3**  
    **Problem:** “Surface server errors verbatim” and “do not gate locally” mitigate false refusal only. They do not mitigate silent server-side throttle, truncated output, or a generic 403 that the platform retries as transient. Client tier list is presented as “what is actually true” but is client source, which §0 already says is non-authoritative.  
    **Fix:** Classify unknown/ambiguous server failures as unavailable, not retryable. Do not publish the client tier list as operational truth.

22. **LOW — §0 / §14**  
    **Problem:** `grok trace` and hidden quota surfaces are open questions, but “full subcommand list, therefore no quota API” is treated as closed. Hidden flags, settings JSON, or trace files could exist.  
    **Fix:** Keep “no remaining-allowance signal” as the working assumption; do not block on `grok trace`; do not claim the search was complete.