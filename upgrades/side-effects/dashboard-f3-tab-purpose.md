# Side-Effects Review — Dashboard F3 (tab purpose lines)

**Change:** Implements floor **F3** of the Dashboard UX Standard (`docs/specs/dashboard-ux-standard.md`, merged in #1404): every registered dashboard tab now carries a plain-language, self-explanatory purpose line near its top. Adds a shared `.tab-purpose` CSS class, converts the dashboard's pre-existing muted intro divs to it (de-jargoning the worst offenders), adds purpose lines to the tabs that lacked one (Sessions, Files), and adds a static floor test.

**Files:**
- `dashboard/index.html` — one `.tab-purpose` CSS rule; ~15 panels' intro divs converted to (or given) `.tab-purpose`; new purpose lines for Sessions and Files. Pure markup/CSS — no script changes.
- `tests/unit/dashboard-tab-purpose.test.ts` — the F3 floor: maps every `TAB_REGISTRY` tab to its panel markup and fails (naming the tab) if none carries a recognized purpose-line class (`tab-purpose` / `ph-intro` / `features-subtitle` / `dropzone-subtitle`). Population-floor guarded.

**Side effects / blast radius:**
- **Runtime behavior:** NONE. The dashboard is a static file served by `express.static`; this change adds display-only markup + CSS. No JS logic, no API routes, no state, no config touched.
- **Migrations:** none required. The dashboard `index.html` is served from the package, not templated per-agent; no `PostUpdateMigrator` / CLAUDE.md-template surface is involved (no agent-installed file changes).
- **Server/lifeline/deploy path:** untouched.
- **Cross-machine / mesh:** untouched.
- **Security/PII:** none — no data, credentials, or user content flow through the changed lines.

**Risk:** Low. Worst case is a cosmetic mis-placement of a purpose line on a tab, visible only in the dashboard UI, fixable by a follow-up edit. The floor test prevents a future tab from silently shipping without a purpose line.

**Rollback:** revert this commit — the dashboard reverts to the prior markup with zero residual state (nothing persisted, nothing migrated).

**Follow-ups (tracked, out of scope here):** F4 (mobile no-horizontal-scroll) ships next; F5–F8 (labeled controls, self-explaining empty states, shared component vocabulary that will consolidate the 4 accepted purpose-line classes into one) follow per the spec sequencing.
