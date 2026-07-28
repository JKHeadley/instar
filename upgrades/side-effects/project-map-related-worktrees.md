# Side-Effects Review — Project Map Related Worktrees

**Version / slug:** `project-map-related-worktrees`
**Date:** `2026-05-29`
**Author:** `instar-codey`
**Second-pass reviewer:** `not required by tooling`

## Summary of the change

This change extends Project Map with a concise related-worktrees summary and makes the headline total file count skip hidden directories consistently with the visible top-level breakdown. The existing project-root map remains the primary output, and related git worktrees are discovered only from configured roots plus the conventional agent worktree directory derived from the project directory name.

## Decision-point inventory

- `ProjectMapper.generate()` — add optional related-worktree metadata to generated maps.
- `ProjectMapper.toMarkdown()` and `getCompactSummary()` — display related worktrees when present.
- `ProjectMapper.countFiles()` — skip hidden directories consistently at every depth so hidden state does not inflate the headline total.

---

## 1. Over-block

No blocking behavior changes. This is read-only reporting.

---

## 2. Under-block

No authorization or safety gate changes. The mapper does not make worktree placement decisions and does not suppress existing worktree detector findings.

---

## 3. Level-of-abstraction fit

Project Map already owns spatial awareness for the current workspace. Reporting nearby conventional worktrees belongs at this layer because it helps the agent understand the real working surface without coupling the session-start context to worktree-manager internals.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no conversational block/allow surface.

The output is informational. It helps orientation but does not authorize edits or replace coherence checks.

---

## 5. Interactions

- **Shadowing:** None. Worktree safety remains owned by the worktree manager and detector.
- **Double-fire:** None. Refresh still writes one JSON map and one markdown map.
- **Races:** A worktree can be created or removed while the map is generating. The mapper handles missing or unreadable entries by skipping them, preserving refresh reliability.
- **Feedback loops:** Positive loop: agents should be less likely to overlook the source worktrees they are actively using.

---

## 6. External surfaces

Users and agents will see a related-worktrees section in Project Map JSON, markdown, and compact output when conventional worktrees exist. Agents without such worktrees keep effectively the same map, except headline totals become less noisy if hidden state directories were previously included.

---

## 7. Rollback cost

Rollback is a normal code revert. Saved maps with the optional related-worktrees field remain harmless if older code ignores it.

---

## Conclusion

The change is clear to ship. It fixes real spatial-awareness and count-consistency gaps found during Project Map dogfooding without widening the mapper into a broad filesystem scanner.

---

## Second-pass review (if required)

**Reviewer:** `not required by tooling`
**Independent read of the artifact:** `not required`

---

## Evidence pointers

- `tests/unit/ProjectMapper.test.ts`
- `tests/integration/coherence-routes.test.ts`
