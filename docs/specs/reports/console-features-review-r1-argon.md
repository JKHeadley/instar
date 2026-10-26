# Console features review round 1 — Gemini 4 Argon (gemini CLI), 2026-10-25

## 1. Verdict: **Ready with changes**

The feature plans are exceptionally well-structured, coherent, and tailored to a phone-first operator who wants high signal, zero noise, and honest telemetry. The consolidation of 29 subsystem tabs into 16 question-driven places makes immediate sense. However, there are a few security inconsistencies around PIN caching across groups, a couple of places where merged pages risk crowding out their primary signal on a 390 px screen, and minor routing/build-order contradictions between the summary and group docs that should be tightened before implementation.

---

## 2. Factual errors & code claims

Because legacy source files (`dashboard/index.html`, `dashboard/*.js`, `src/server/*`) are not included in stdin, specific line-number and route-implementation claims are **unverified** against the codebase. Within the provided specs themselves, however, there are internal factual contradictions:

- **PIN reuse model contradicts itself across documents:** `00-patterns.md` (§4) and `capacity.md` state that operator proof uses `POST /dashboard/unlock` to hold an operator-session token in memory for its server-set lifetime. Meanwhile, `people-settings.md` (Overview) says the console holds *the raw PIN itself* in page memory ("like `pairing.js` does") to replay into endpoints that expect `{ pin }` in the request body, and `under-the-hood.md` (Feedback) says the PIN is held "for the sheet's life only".
- **Insights retirement target disagrees:** `README.md` says Insights' one-line plain read moves to the **What thinking costs** page, while `under-the-hood.md` says it moves to the **LLM activity** page (which no longer exists as a standalone page, having been merged into section 2 of *What thinking costs*).
- **Build order disagrees between `README.md` and group plans:** `README.md` puts *Accounts* at #5 and *What thinking costs* at #8, whereas `capacity.md` explicitly orders *What thinking costs (read-only)* at #2 ahead of *Accounts* at #3 because Accounts is the largest, highest-risk build.

---

## 3. Lost controls or write actions

Almost every legacy control is carefully accounted for, with three small gaps:

1. **Preferences audit views are orphaned during transition:** `people-settings.md` moves "Class reviews" (`/class-reviews`) and "Claim Verification observations" (`/completion-claim/audit`) out of *What I've learned about you* into *Process health* ("How I'm doing inside"). However, `under-the-hood.md`'s plan for *Process health* never mentions or includes either section.
2. **Paste target lacks a local-only escape hatch:** In *Sessions / Send content* (`work.md`), pasting to a session running on a remote peer is impossible today (`POST /pastes` is local-only). The plan notes this honestly ("Sessions on other machines can't receive pastes yet"), but drops the ability to copy/send via the terminal WebSocket stream, which *does* work across machines.
3. **Initiatives/Projects filter by specific non-active status:** In `work.md`, the legacy status dropdown (`Active / All / Completed / Archived / Abandoned`) is moved inside a collapsed *Finished* section at the bottom of *Plans*, while `paused` and `halted` plans have no dedicated filter chip if the list grows past 20.

---

## 4. Confusing merges, renames, or generic designs

The designs are concrete and specific (not generic), with strong ASCII wireframes and domain-specific honesty states. A few merges and interaction flows need adjustment:

- **"In the way" (Blockers) is buried below "In flight" on the Plans page (`work.md`):** If Justin opens *Plans* to ask "how is the longer work going, and what is in the way?", putting active blockers *below* all in-flight initiatives and projects means scrolling past healthy work to find what is stuck.
- **Guard details are split across three places:** Home's "What I'm allowed to do" card links to `Settings › What I'm allowed to do` (`people-settings.md`), which shows a 1-line guard summary and links to `Capacity › Machines › <Machine> › Safety checks` (`capacity.md`) for the actual guard list. A user tapping "What I'm allowed to do" to see why a guard is deviant has to jump across groups and pick a machine.
- **"How I'm doing inside" (`under-the-hood.md`) mixes two different audiences and cadences:** Combining *Integrated-Being* (a live cross-session coordination timeline of agreements/threads) with *Process health* (a developer failure-pattern ledger) and *Evidence* (memory source lookup) makes the page feel like a miscellaneous drawer rather than one coherent question.

---

## 5. Security problems

- **Holding raw PINs in JS memory vs. server-issued operator session tokens (See Finding 1):** Holding a raw PIN in memory to replay on subsequent clicks expands the blast radius of any XSS or memory leak compared to holding a scoped, short-lived `X-Instar-Operator-Session` token. Worse, high-impact actions (like revoking a mandate, rotating a recovery root, or approving a paid cap) would execute on a single tap without re-prompting if the PIN is silently replayed from memory.
- **Unauthenticated fallback on `consoleProfile`:** `under-the-hood.md` proposes adding `consoleProfile: { maintainer, basis }` to the authenticated block of `/health`. That is safe for UI hiding, provided no new maintainer route relies on client-side hiding for access control (the plan rightly notes the server still gates writes, which must also hold for reads like `/throughput/series`).

---

## 6. Over-engineering & build order (80/20)

- **Over-engineering to cut:**
  - **Custom client-side diff engine and keyboard-pinned viewport bar in Files (`people-settings.md`):** Building a full mobile code editor with `visualViewport` keyboard tracking and a 3-way conflict diff viewer in vanilla JS is heavy and brittle on iOS Safari. Keep it simple (see Finding 4).
  - **Client-side 30-day double-window math in Pace (`under-the-hood.md`):** Fetching 30 days of GitHub throughput series on a phone to compute 7-day and 14-day period-over-period deltas client-side adds payload and fragile date-bucket logic for a chart the operator rarely checks on mobile.
- **Build order adjustment:**
  - Move **Feedback** (`under-the-hood.md`, part of *Development*) up alongside **Promises** and **Plans**. For the operator on his phone, approving a blocked feedback-factory or triage step is a real daily bottleneck, whereas rebuilding *Files* or *What thinking costs* is lower urgency.
  - Keep `capacity.md`'s order (*What thinking costs* read-only before *Accounts* write sheets) in `README.md`.

---

## Ranked Findings (Top 9)

### 1. Standardize PIN and operator-proof handling so destructive/financial actions never silently auto-submit
- **Problem:** `00-patterns.md`, `capacity.md`, `people-settings.md`, and `under-the-hood.md` describe three different PIN lifetimes (session token in memory, raw PIN in page memory, and single-sheet memory). If raw PINs are cached in memory and replayed automatically, a second tap on a high-consequence action (e.g., *Rotate recovery root*, *Approve spend cap*, *Revoke mandate*) bypasses the proof boundary.
- **Smallest fix:** Never cache the raw PIN string in memory. Use `X-Instar-Operator-Session` for read/repair unlocks during a visit, and require an explicit PIN entry in the confirmation sheet for every destructive, financial, or authority-granting commit (`mandate`, `routing-spend` commit, `identity-recovery/rotate`, `feedback-factory` authority). Update `00-patterns.md` §4 to make this rule uniform.

### 2. Reconcile the dropped Preferences audit sections (`class-reviews` and `completion-claim/audit`)
- **Problem:** `people-settings.md` removes *Class reviews* and *Claim Verification observations* from *Preferences*, stating they move into *Process health* (`under-the-hood.md`). `under-the-hood.md` does not include them, violating the "nothing is lost" mandate.
- **Smallest fix:** Add a collapsed **"Verification & class reviews"** section to *How I'm doing inside › Problems I caught in my own work* in `under-the-hood.md` backed by `GET /class-reviews?limit=20` and `GET /completion-claim/audit?limit=20`.

### 3. Surface "In the way" (Blockers) above "In flight" on the Plans page
- **Problem:** In `work.md`, the *Plans* page places *In the way* (active blockers) below *In flight* (all active projects and initiatives). On a 390 px screen, stuck work is pushed below the fold by healthy work.
- **Smallest fix:** Order the *Plans* sections by urgency: **Needs you** → **In the way** (when non-empty) → **In flight** → **Idle** → **Finished**.

### 4. Cut the custom diff engine and `visualViewport` editor bar from Files (`people-settings.md`)
- **Problem:** Building a mobile code editor with `visualViewport` keyboard pinning and a client-side diff/merge viewer for 409 conflicts is high-effort, fragile on iOS Safari, and low-value for quick phone edits.
- **Smallest fix:** Keep the sticky top header with **Save** / **Cancel** (which stays visible when iOS scrolls the page), show a plain "Changed since you opened it — reload or overwrite" prompt with `lastModified` timestamps on 409 (stashing the user's draft to clipboard/storage), and skip the client-side diff viewer for v1.

### 5. Show deviant safety guards directly on "What I'm allowed to do"
- **Problem:** When a guard is off where it should be on (`offDeviant`), Home links to `Settings › What I'm allowed to do`, which only shows a summary count and forces the operator to navigate to `Capacity › Machines › <Machine> › Safety checks` to see which guard is off.
- **Smallest fix:** In `people-settings.md` (*What I'm allowed to do*), if any guard on this machine is `offDeviant` or `onUnverified`, list those specific guard rows inline under the profile card, with a link to *Machines* only for the full "all N on" list.

### 6. Keep "What thinking costs" focused by collapsing the static Routing Map into a drawer
- **Problem:** Merging four legacy tabs (`spend`, `tokens`, `llm-activity`, `routing-map`) into *What thinking costs* (`capacity.md`) creates a five-section page mixing live time-windowed ledgers with a static configuration table (*Which model does what*). Changing the top time picker (`Today / 7 days / 30 days`) affects sections 1–3 but not section 4 or 5.
- **Smallest fix:** Make *Which model does what* (`/intelligence/routing/chains`) a bottom sheet opened from a header link ("Model routing & fallbacks ›") rather than an inline section under the time-windowed cost lists.

### 7. Elevate Feedback in the overall build order and align `README.md` with group plans
- **Problem:** `README.md` puts *Development* (which contains *Feedback*, the operator's primary phone approval surface for the feedback factory) dead last at step 11, and swaps the order of *Accounts* and *What thinking costs* relative to `capacity.md`.
- **Smallest fix:** Update `README.md` build order so **Feedback** (or *Development*) ships right after *Plans* and *Schedule* (around step 5), and ship **What thinking costs (read-only)** before **Accounts**, matching `capacity.md`.

### 8. Fix the Insights retirement target between `README.md` and `under-the-hood.md`
- **Problem:** `README.md` says Insights' one-line summary moves to *What thinking costs*, while `under-the-hood.md` says it moves to the *LLM activity* page (which is now a section inside *What thinking costs*).
- **Smallest fix:** In `under-the-hood.md` and `capacity.md`, specify that the `GET /insights/llm-activity` plain-read line renders at the top of the **Background checks** section inside *What thinking costs*.

### 9. Allow cross-machine paste via terminal input when `POST /pastes` is local-only
- **Problem:** `work.md` merges *Send content* into *Sessions*, but notes that sessions on peer machines cannot be targeted by `POST /pastes`. That leaves the operator unable to paste long text to a remote session from the new sheet.
- **Smallest fix:** When the selected session is on a peer machine, have the *Paste to a session* sheet warn that file-backed paste (`POST /pastes`) is local-only and offer **"Send directly to terminal"** over the existing relay WebSocket stream as a fallback.
