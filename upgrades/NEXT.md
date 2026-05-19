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

Unit verification:
`tests/unit/PostUpdateMigrator-shadowCapabilities.test.ts` — six cases:
appends missing sections; idempotent; mirrors into both shadows when both
exist; no-op when no shadow exists (Claude-only install); no-op (with note)
when CLAUDE.md is absent; identity content above the appended sections is
preserved.

## What to Tell Your User

- "Codex and Gemini agents now get the same capability instructions Claude Code agents have — discover, private views, coherence gate, agent network, and so on. Claude Code agents are unaffected. This is the last of six small portability patches we promised; the v1.0 portability arc is now closed."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Shadow capability mirror | Automatic on update. The migrator copies capability sections from CLAUDE.md into AGENTS.md and GEMINI.md when those shadows exist. |
| No-duplication source | The section bodies live in exactly one place (CLAUDE.md) and are sliced into shadows at migration time; Claude and non-Claude cannot drift. |

## Deferred (Tracked Follow-ups)

- None for the cross-framework portability audit. All six audit-flagged code
  gaps are now shipped; the broader deployment-lockdown work continues in
  its own track. A future v1.x may revisit how CLAUDE.md relates to the
  canonical identity render (a larger architectural question explicitly
  out of scope of this minimal shim per the operator's decision).
