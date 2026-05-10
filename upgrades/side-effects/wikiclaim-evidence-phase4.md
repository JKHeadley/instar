# Side-Effects Review — WikiClaim Evidence Phase 4 (HTTP + dashboard)

**Version / slug:** `wikiclaim-evidence-phase4`
**Date:** 2026-05-10
**Author:** Echo
**Second-pass reviewer:** required (auth-principal-to-viewer-scope mapping; XSS; visibility-filter correctness)

## Summary of the change

Adds inverse-traceability HTTP endpoints + dashboard panels that consume the typed evidence APIs landed in Phase 1 and hardened in Phase 5. No new policy, no new storage shape, no new filter — this PR is a thin pass-through from HTTP/dashboard to `SemanticMemory.getEvidence` / `SemanticMemory.findCitations` / `SemanticMemory.getEntityWithEvidence`.

Spec: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` § Phase 4 (line 343), Inverse traceability (line 291), Storage and Privacy (line 310).

What lands:
- `GET /memory/evidence/by-entity/:id?viewerScope=...` — returns the entity's evidence array, viewer-scope filtered. Routes through `getEntityWithEvidence` so the entity-level visibility check and the per-row evidence-tier filter both fire BEFORE any bytes leave the storage layer. 404 collapses "entity missing" and "entity hidden at viewer scope" into the same response per spec § Storage and Privacy line 316 (non-leaky inverse-query rule extended to direct fetch).
- `GET /memory/entities/by-evidence?kind=...&sourceId=...&viewerScope=...` — returns entities citing `(kind, sourceId)`. Pass-through to `findCitations`, which filters by BOTH the citing entity's `privacyScope` AND the citing evidence row's `privacyTier`. Returns `{kind, sourceId, viewerScope, entities, totalResults}`.
- `viewerScope` resolution: optional query param, default `private` (full visibility for the agent's own DB; the single-bearer-token auth model has one principal). Narrowing-only — callers can request a more restrictive view to preview "what would a topic-peer see?" Invalid scope values fall back silently to the default rather than 400'ing, mirroring how other Express handlers in this file treat unknown enum input.
- Evidence kind whitelist on the inverse endpoint — `VALID_EVIDENCE_KINDS` set matches `MemoryEvidenceKind` exactly. Unknown kinds → 400 (this is mechanic-level validation, not judgment).
- Auth: both routes sit behind the global `authMiddleware` applied at app level in `AgentServer`. No route-local auth code (and no new code to maintain that could drift).
- Dashboard "Evidence" tab: per-entity evidence panel (text input + Lookup button → render evidence list with kind, sourceId, file:line, weight, confidence, privacyTier badge, note); "what cites this?" panel (kind dropdown + sourceId input → render entities with type, name, id, scope, confidence, and an "Inspect evidence" button that pivots to the per-entity panel). One viewer-scope dropdown drives both panels.
- Dashboard XSS posture: every user-supplied string (entity id, name, content, sourceId, note, path, privacyTier label) flows through the local `escapeHtml` helper before reaching `innerHTML`. The "Inspect evidence" button uses a `data-entity-id` attribute + a delegated `addEventListener('click', …)` — NOT an inline `onclick` string interpolation — so even pathologically-shaped IDs cannot break out of the attribute context.

Files touched:
- `src/server/routes.ts` — adds `/memory/evidence/by-entity/:id` and `/memory/entities/by-evidence` after the existing `/semantic/*` routes; adds local `VALID_EVIDENCE_KINDS`, `VALID_VIEWER_SCOPES`, `resolveViewerScope`.
- `dashboard/index.html` — adds an "Evidence" tab button to the tab bar, an `evidenceTab` panel container, a registry entry in `TAB_REGISTRY`, and a JS section (`evCurrentViewerScope`, `evRenderTierBadge`, `evRenderEvidenceRow`, `evRenderEntityRow`, `loadEvidenceByEntity`, `loadEntitiesByEvidence`, `evLookupFromCitation`) inserted before `loadTokens`.
- `tests/unit/memory-evidence-routes.test.ts` — 14 vitest cases against real SQLite + a real Express app with the production `authMiddleware`.
- `upgrades/side-effects/wikiclaim-evidence-phase4.md` (this file)

## Decision-point inventory

- `resolveViewerScope(raw)` — **add** — mechanic-level enum lookup against `VALID_VIEWER_SCOPES`. Not judgment.
- `VALID_EVIDENCE_KINDS` lookup on the inverse endpoint — **add** — mechanic-level enum match. Not judgment.
- `escapeHtml`-on-every-field render path — **add** — structural HTML escape, not judgment.
- 404-vs-200-empty collapse on `by-entity` — **add** — spec-mandated non-leak (§ Storage and Privacy line 316).

---

## 1. Over-block

**`viewerScope` query param ignored when invalid (default-to-private).** A caller sending `?viewerScope=garbage` does not get a 400; they get private-scope results. Rationale: viewerScope is narrowing-only and the agent's principal is already `private`; widening doesn't exist, so misspellings can only narrow OR be ignored. The safest fallback for a typo is the agent's own scope (private) — i.e., NO over-block. A stricter 400 would be a usability regression with no privacy benefit.

**`findCitations` returns an empty array on missing entities or zero matches.** Both paths look identical to the caller. By design — the inverse query is exactly the "is there any citation of this source anywhere I can see?" probe; differentiating "no matches" from "no visible matches at your scope" would itself be the leak the spec is closing.

## 2. Under-block

- **Rate limiting:** these are read endpoints with no LLM call, no mutation, no fan-out. Per the patterns in routes.ts, hot read endpoints in `/semantic/*` (e.g. `/semantic/recall/:id`, `/semantic/search`, `/semantic/explore/:id`) ALSO don't carry a `rateLimiter` wrapper — they rely on the global auth gate. The new routes follow the same convention. If abuse appears in observability, attaching `rateLimiter(60_000, 60)` is a one-line follow-up; the per-entity evidence cap (50 default, 500 hard) caps the response size regardless.
- **viewerScope authentication binding:** the `viewerScope` query param is caller-controlled. This is acceptable because the auth model has ONE principal (the agent itself, full bearer token = `private` ceiling), and the param can only *narrow*. A caller cannot widen to `private` if they were given a `shared-project` token, because there is no such token — the system has one. When multi-tenant auth lands (not in scope), this resolver becomes the seam: it must read principal claims off the request and clamp the param to the principal's ceiling. Currently documented in the inline comment on `resolveViewerScope`.
- **`note` field rendering on the dashboard:** notes are free-form text, capped at 500 bytes at write time (Phase 1). The dashboard renders them via `escapeHtml`, NOT `marked` / `DOMPurify` — even though those libraries are loaded for the file viewer. Treating notes as plain text is the safer default; if markdown rendering is wanted later, route through `DOMPurify.sanitize(marked.parse(note))` like the file viewer does.
- **Dashboard does not paginate** when the inverse query returns many entities. The per-entity evidence cap means the forward endpoint is bounded; the inverse endpoint is bounded only by "how many entities cite this source" which has no hard cap. v1 dashboards expect human-scale lookups; a follow-up can add `limit`/`offset` if needed.

## 3. Level-of-abstraction fit

Right layer.

- HTTP route is a 30-line pass-through to the storage primitive. Privacy decisions live in `SemanticMemory.getEvidence` / `findCitations` (read-time filter) and in `EvidenceRenderer` (the documented enforcement point for already-loaded entities, per Phase 5). The route does not re-decide visibility — it serializes whatever the storage layer returned.
- Dashboard panels invoke the route via `apiFetch` and render the result. They do not contain a copy of the privacy filter; they trust the server to have filtered.
- `viewerScope` derivation is owned by `resolveViewerScope` — one function, one place to retrofit when multi-tenant auth lands.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] **No** — these are read endpoints with no judgment-level block/allow surface.

The "decisions" in this PR:
- Mechanic-level enum lookups (`VALID_VIEWER_SCOPES`, `VALID_EVIDENCE_KINDS`);
- Mechanic-level scope ordering (already owned by `EvidenceRenderer`, not duplicated here);
- Mechanic-level escape on the dashboard.

None of those answers the question "should this evidence be visible to this caller?" — that question is answered exactly once, in `SemanticMemory`. The route is dumb; the renderer is the boundary.

## 5. Interactions

- **Phase 1 (#137):** consumes `getEntityWithEvidence`, `getEvidence`, `findCitations` — all already viewer-scope-filtered. No re-wiring of those methods.
- **Phase 5 (#141):** the `EvidenceRenderer` helper is the documented single enforcement point. This PR uses storage-layer methods that internally use the same predicates that `EvidenceRenderer` uses (`isEntityVisibleAtScope`, `isEvidenceVisibleAtScope`); the rules are colocated, no drift. If a future caller has an already-loaded entity in memory and wants to ship it to a viewer, they should call `renderEvidenceForScope` — these routes don't go through that path because they load fresh from SQLite.
- **Phase 2 (#139) and Phase 3 (#142) in flight:** they touch producer code (EvolutionManager, DispatchExecutor, DecisionJournal). They don't touch routes.ts or the dashboard. Conflict-free.
- **TaskFlow Phase 5 (#143 merged d7d4eba9):** added rate-limit middleware to `/flows/*`. This PR does NOT add rate-limit to `/memory/*` evidence routes — the convention in `/semantic/*` is no per-route limiter, relying on global auth + per-entity bound. If a follow-up wants to standardize, it's a one-liner.
- **Dashboard tab registry:** new `evidence` entry sits between `threadline` and `secrets`. The mobile nav menu / `updateNavToggleLabel` keys off `data-tab="evidence"` and works without changes (the existing logic reads the button text dynamically).
- **`authMiddleware`:** the existing global middleware sits in front of every non-public route. Both new routes inherit it without local code. Test file mounts `authMiddleware(AUTH_TOKEN)` directly to exercise the 401 path.

## 6. External surfaces

- **Other agents on the same machine:** none. The routes return only this agent's own data.
- **Other users of the install base:** two new GET routes appear. No breaking changes to existing routes. Anyone hitting `/memory/*` paths today gets a 404 (we use those URLs first time here, no collision check needed — `grep` confirms no `/memory/evidence/*` or `/memory/entities/*` exists in routes.ts before this PR).
- **External systems:** none.
- **Persistent state:** none — read-only routes.
- **Privacy posture:** unchanged. The visibility surface is exactly what `SemanticMemory` already exposes; this PR only adds an HTTP/dashboard frontend.
- **Cloudflare tunnel:** if the agent exposes its server via Cloudflare tunnel, the new routes are reachable from the internet under the same bearer-token auth as everything else. No new exposure shape; the auth boundary is unchanged.

## 7. Rollback cost

- **Hot-fix release:** pure additive change; `git revert <merge-commit>` ships as the next patch.
- **Data migration:** none.
- **Agent state repair:** none. No state written.
- **User visibility:** mild — the Evidence tab disappears from the dashboard. No data loss; the underlying DB is untouched.

---

## Conclusion

Phase 4 ships two read-only HTTP routes plus a single dashboard tab. All privacy decisions remain in the Phase 1 storage-layer filter and the Phase 5 `EvidenceRenderer` boundary; this PR does not introduce a second filter. Auth is the existing bearer-token model. XSS is structurally prevented by `escapeHtml`-on-every-interpolation plus the absence of inline `onclick` string-interpolation patterns. 14 new vitest cases cover viewer-scope filtering, auth, 404, 400, empty results, and the inverse-leak cross-product. Cleared to ship pending second-pass concurrence on auth/XSS/filter-correctness.

---

## Second-pass review

**Reviewer:** independent code-audit subagent (adversarial), one round.
**Round 1 findings:**

1. **Inline `onclick` with `${id}` interpolation in `evRenderEntityRow`** — flagged at draft time. `escapeHtml` does encode `'`/`"`, so a payload like `id="x'),alert(1);//"` would render as `&#39;`, structurally inert. Still: an inline `onclick="..."` string-build is a brittle pattern; one future edit forgetting the escape is a foot-gun. **Resolution:** rewrote as `data-entity-id="${id}"` + `addEventListener` delegation. No string-interpolation into an HTML attribute that becomes a JS expression at parse time.
2. **`viewerScope` widening attempt** — a caller could send `?viewerScope=private` even if they "shouldn't" have private access. **Resolution:** the auth model has one principal (the agent itself = private ceiling). There is no "shouldn't" right now — the bearer token IS the private credential. The resolver is the documented seam for future multi-tenant scope clamping, and the inline comment in routes.ts says so. Cleared.
3. **Visibility-filter correctness on `by-entity` for a private entity at shared-project viewer** — confirmed: `getEntityWithEvidence` returns `null` when the entity scope exceeds the viewer scope (`SemanticMemory.ts:775`). Route returns 404 in that case. Test `returns 404 (non-leaky) when a private entity is requested at shared-project scope` proves it.
4. **Inverse leak via `by-evidence` when entity scope is shared-project but evidence row is private** — confirmed: `findCitations` checks BOTH entity scope AND evidence tier (`SemanticMemory.ts:752-754`). Test `cross-product: shared-project viewer cannot see private-tier evidence inverse query` covers this exact shape. Cleared.
5. **`viewerScope` enum bypass via prototype-pollution / non-string input** — `req.query.viewerScope` may be a string, an array, or undefined. `resolveViewerScope` only returns one of the three known scopes; anything else falls to `'private'`. Even with `?viewerScope=__proto__`, the `VALID_VIEWER_SCOPES.has()` check rejects (`Set.prototype.has` does not match own/prototype keys of arbitrary strings). Cleared.

Cleared to ship.

---

## Evidence pointers

- New tests: `npx vitest run tests/unit/memory-evidence-routes.test.ts` → 14/14 passing (102ms).
- Typecheck: `npx tsc --noEmit` → clean.
- Spec source of truth: `docs/specs/OPENCLAW-IMPORT-WIKICLAIM-EVIDENCE-SPEC.md` (Phase 4 at line 343).
- Predecessor PRs: #137 (Phase 1 schema), #141 (Phase 5 backfill + render hardening).
- Privacy enforcement evidence:
  - `SemanticMemory.getEntityWithEvidence` (entity scope filter): `src/memory/SemanticMemory.ts:765-779`
  - `SemanticMemory.findCitations` (dual filter on entity scope + evidence tier): `src/memory/SemanticMemory.ts:735-759`
  - `EvidenceRenderer` (documented enforcement boundary): `src/memory/EvidenceRenderer.ts`
