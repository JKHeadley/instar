# Side-Effects Review — Watchdog `-mcp`/`/mcp` exclusion: allow `@version` suffix

**Version / slug:** `watchdog-mcp-version-pin`
**Date:** `2026-04-19`
**Author:** `echo`
**Second-pass reviewer:** `general-purpose subagent`

## Summary of the change

Two exclusion regexes in `src/monitoring/SessionWatchdog.ts` (added in the prior watchdog-user-comfort change) were missing a token boundary case: version-pinned package invocations like `npm exec @playwright/mcp@latest` or `foo-mcp@1.2.3`. The lookahead only allowed `$`, whitespace, `/`, or `.` after `mcp`, so a trailing `@version` escaped the match and the watchdog killed the MCP server. Direct observation: `watchdog-interventions.jsonl` shows a SIGTERM on `npm exec @playwright/mcp@latest` at 2026-04-19T20:16Z on `echo-session-robustness`. Fix: add `@` to both lookaheads. Two new test cases cover `@playwright/mcp@latest`, `@playwright/mcp@1.2.3`, `@modelcontextprotocol/mcp@0.5.0`, `some-other-mcp@2.0.0`, and `foo-mcp-server@latest`.

## Decision-point inventory

- `SessionWatchdog.EXCLUDED_PATTERNS` (both MCP regexes) — **modify** — broaden lookahead by one character (`@`).

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?**

The added `@` boundary lets the exclusion match when `mcp` is followed by an `@`. Legitimate commands that:
- Contain the literal `-mcp@` or `/mcp@` as a token with `@version`-shaped suffix
- Are NOT long-running MCP stdio servers
…would be mistakenly skipped by the watchdog. Plausible false-positive candidates: a shell alias or binary named `something-mcp` invoked with an email address as an argument (e.g., `something-mcp user@example.com`). The `-mcp` regex matches here. However, any binary named `*-mcp` is almost certainly an MCP stdio server by convention, so skipping it is safe. No credible legitimate rejection found.

---

## 2. Under-block

**What failure modes does this still miss?**

- MCP servers whose command line uses `mcp` as an internal path component but not as the trailing token (e.g. `node /opt/weird-mcp-launcher/bin.js`) — already handled by the existing `-mcp` regex since `-mcp-launcher` ends with `/`.
- An MCP server whose executable is named without a `-mcp` or `/mcp` marker (e.g. `claude-code-bridge` that happens to be an MCP server). No naming convention, so the exclusion list cannot know. This is a broader architectural gap, not new.
- Commands hidden behind a wrapper (`bash -c "… | mcp-thing"`) where ps reports only the outer shell. Unchanged from before.

---

## 3. Level-of-abstraction fit

**Is this at the right layer?**

EXCLUDED_PATTERNS is a low-level, brittle detector. It holds pass-through authority for watchdog kills — "if name matches, skip the kill ladder." The prior side-effects review (watchdog-user-comfort.md) accepted this as a safety carve-out: brittle exclusion is OK when the default action is irreversible (SIGKILL) and the cost of an over-block is "watchdog lets a truly-stuck process run longer." This change extends the same detector's coverage; it does not change its layer or authority. Appropriate.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

**Does this change hold blocking authority with brittle logic?**

- [x] Yes — but this is a *safety guard* on an irreversible kill action, not a block/allow gate on user input. The layered-authority principle permits brittle detectors when the default action is destructive. See prior review (`watchdog-user-comfort.md` §4) for the accepted carve-out.

No change in compliance posture. The regex is still a pass-through filter on watchdog-initiated kills; the kill ladder is still the authority.

---

## 5. Interactions

**Does this interact with existing checks, recovery paths, or infrastructure?**

- **Shadowing:** None. The regex runs inside `isExcluded()`; no other code path intercepts.
- **Double-fire:** None. The change only broadens what `isExcluded()` returns true for; it cannot cause the watchdog to fire twice.
- **Races:** None. Pure pattern evaluation, no shared state.
- **Feedback loops:** None. The exclusion short-circuits the kill ladder; it cannot re-enter.

Confirmed by reading `SessionWatchdog.ts`: `isExcluded()` is called from `checkChildren()` only, single call site, no downstream handlers.

---

## 6. External surfaces

**Does this change anything visible outside the immediate code path?**

- Other agents on the same machine: unchanged — each agent runs its own watchdog.
- Install base: unchanged — behavior is strictly more lenient (fewer kills), no breaking change.
- External systems: unchanged — no external calls.
- Persistent state: `watchdog-interventions.jsonl` will see fewer entries for MCP commands. Historical entries unchanged.
- Timing: no timing change.

No external surface changes.

---

## 7. Rollback cost

**If this turns out wrong in production, what's the back-out?**

- **Hot-fix:** revert the regex change (two character deletions) and ship as a patch. Trivial.
- **Data migration:** none. No persistent state shape change.
- **Agent state repair:** none. Agents pick up the change on restart via shadow-install rsync.
- **User visibility:** during rollback window, watchdog would once again kill `@scope/mcp@version` commands — same regression we just fixed. User-visible: the "wrench" message appears less often (or again, on rollback). No data loss.

Low rollback cost.

---

## Conclusion

Two-character change fixing a concrete regex gap observed in production just hours ago (`@playwright/mcp@latest` was SIGTERM'd). Added two test cases covering the version-pin variant. Same layer, same authority, strictly fewer kills, fully reversible. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** general-purpose subagent
**Independent read of the artifact: concur**

- No credible over-block: theoretical `rm /path/mcp@backup`-style matches don't survive to kill thresholds.
- No catastrophic backtracking: simple char classes with single `+`, no nested repetition, linear time.
- Minor still-missed gap: docker `foo/mcp:latest` and pip `foo/mcp==1.0` style pins are not covered — but those were not the observed failure mode; reviewer recommends waiting for live evidence before expanding. Scoping the fix to the observed `@version` token is the right discipline.
- Non-blocking suggestion: add a comment above the regexes listing the accepted boundary chars (`$ \s / . @`) for future extenders. Applied below.

---

## Evidence pointers

- Live evidence of the bug: `.instar/watchdog-interventions.jsonl` entry at `1776654972394` (2026-04-19T20:16:12Z), `echo-session-robustness`, command `npm exec @playwright/mcp@latest`, level 1 (Ctrl+C) then level 2 (SIGTERM), outcome `recovered` after 60s.
- Regex verification: `node -e "…"` script in session trace confirming 4 legitimate NOT-EXCLUDED cases remain NOT-EXCLUDED post-fix, 6 MCP-shaped cases now EXCLUDED.
- Test additions: `tests/unit/SessionWatchdog-mcp-exclusion.test.ts` (21 passing, 2 new).
