# Upgrade Guide — v1.0.14 (final portability hardening 6 of 6)

<!-- bump: patch -->

## What Changed

Final shipped patch of the six cross-framework portability hardening items
the v1.0.8 release notes committed to. Closes the v1.0.0 audit at 6/6 code
gaps.

The Claude Code instructions document includes a set of capability sections
(Self-Discovery, Private Viewing, Cloudflare Tunnel, Dashboard, File Viewer,
Coherence Gate, External Operation Safety, Playbook, Threadline Network).
Codex and Gemini shadows had no equivalent — an earlier patch (v1.0.9) gave
them their canonical identity, but not the capability instructions. Setup
and updates now mirror those same capability sections into AGENTS.md and
GEMINI.md when those shadows exist.

The implementation deliberately copies sections directly from the
just-updated Claude file rather than duplicating their content in source.
The two cannot drift, and there is no large refactor of inline section
content.

Also in this release: fleet-watchdog bind-failure probe. The watchdog now
catches the failure mode where a lifeline reports healthy to launchd but
its server is locked out of its configured port (typically a port collision
with another agent). The probe issues an authenticated GET /health for each
loaded agent, compares the response's project field against the agent's
launchd-label-derived expected name, and routes any mismatch through the
existing crash-loop heal + peer-escalation pipeline from PR #245. After 3
consecutive cycles (~15 min), the user gets a conflict-aware Telegram alert
naming both parties — closes the AI-Guy-stuck-behind-codex-server-smoke
class of failure that took 2 days to surface this week.

## Evidence

Reproduction prior to this change: run a Codex agent after setup. Its
AGENTS.md contains the canonical identity but none of the "here's what you
can do" sections that Claude Code's CLAUDE.md has. The agent has no
structural prompt telling it about the live capabilities endpoint, private
view publishing, the coherence gate, the agent network, and so on.

Observed after this change: on the next update, AGENTS.md and GEMINI.md (if
present) gain the same capability sections that Claude Code's CLAUDE.md
carries, sliced directly from the just-updated CLAUDE.md so the content is
identical, not paraphrased. Running update again does nothing — each section
is only appended when its marker is absent from the shadow. Claude-only
installs (no AGENTS.md/GEMINI.md present) are byte-for-byte unchanged.

Bind-failure probe evidence: today's AI Guy outage (`~/Documents/Projects/ai-guy/.instar/logs/lifeline-launchd.log` records "Suppressing duplicate server down notification (4163 suppressed this outage)" — 2 days of suppressed alerts). After this PR, the same configuration produces a BIND-FAIL log line on the first watchdog cycle and a Telegram alert by cycle 3.

Unit verification:
`tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts` — six cases:
appends missing sections; idempotent; mirrors into both shadows when both
exist; no-op when no shadow exists (Claude-only install); no-op (with note)
when CLAUDE.md is absent; identity content above the appended sections is
preserved.

`tests/unit/watchdog-bind-probe.test.ts` (18 tests) + `tests/integration/watchdog-bind-fail-escalation.test.ts` (2 tests) cover the probe's behaviour and the full bind-fail → peer-escalation pipeline.

## What to Tell Your User

- "Codex and Gemini agents now get the same capability instructions Claude Code agents have — discover, private views, coherence gate, agent network, and so on. Claude Code agents are unaffected. This is the last of six small portability patches we promised; the v1.0 portability arc is now closed."
- "If two instar agents end up configured for the same port (configuration drift, leftover smoke-test fixtures, etc.), you'll now get a clear Telegram alert within ~15 minutes naming both agents involved. Previously the lifeline could spin silently for days while the supervisor suppressed its own 'server down' notifications as duplicates."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shadow capability mirror | Automatic on update. The migrator copies capability sections from CLAUDE.md into AGENTS.md and GEMINI.md when those shadows exist. |
| No-duplication source | The section bodies live in exactly one place (CLAUDE.md) and are sliced into shadows at migration time; Claude and non-Claude cannot drift. |
| Fleet watchdog bind-failure probe | Automatic. Catches port-collision / server-unreachable agents whose lifelines look healthy to launchd. Escalates via peer agent's `/attention` endpoint after 3 cycles. |
| Conflict-aware Telegram alerts | When the probe identifies the wrong-project case, the escalation summary names both contested parties. |

## Deferred (Tracked Follow-ups)

- None for the cross-framework portability audit. All six audit-flagged code
  gaps are now shipped; the broader deployment-lockdown work continues in
  its own track. A future v1.x may revisit how CLAUDE.md relates to the
  canonical identity render (a larger architectural question explicitly
  out of scope of this minimal shim per the operator's decision).
- Per-agent "muted" flag for the bind-probe (legitimate maintenance windows)
  is deferred to the v3 Remediator's policy layer.
