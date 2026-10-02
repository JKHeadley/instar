# Door + model controls: readable names and a phone layout that fits

## What Changed

Display polish for the Sessions-tab door and model controls (shipped in 1.3.1311), from a
phone-width walkthrough on the live dashboard. `dashboard/index.html` gains three inline
helpers: `friendlyModelName` (display name for a model id; unknown ids pass through
unchanged), `modelFamilyClass` (badge color class from a fixed family set, never the raw
id) and `visibleModels` (hides a dated id when its undated twin is listed, never the
current selection). Model dropdowns, the Sessions-list badge, the session-view badge and
the "Now:" / "Create on" / "Default" labels use the display name; option values and every
request keep the raw id, which also stays on the badge as a tooltip. CSS: badges no
longer wrap mid-word, the list's meta row may wrap, and at phone width the session header
stays on one line (compact model badge, non-breaking "Door + model" button, session-type
tag hidden). `topicProfileWriteSurface.ts`: the `no-bound-operator` refusal reply is
reworded as an instruction; the reason code and audit row are unchanged.

## What to Tell Your User

The door and model pickers in the dashboard are easier to read. Models show as "Opus 5.5"
or "GPT-5.6 Sol" instead of raw ids, each model appears once, and the session screen's
top bar fits on a phone. If a switch is refused on a brand-new topic, the message now
says what to do: send one message in the topic first, then switch.

## Summary of New Capabilities

- Model names in the Sessions tab are shown in plain form; the raw id is a tooltip.
- The session header and the Sessions list fit a phone screen without mid-word wrapping.
- The switch refusal for a not-yet-owned topic tells the user the next step.

## Evidence

- Before/after at 390px on the live dashboard (Mac Studio, 1.3.1312): header went from
  three wrapped lines per element to one line; the list badge "CLAUDE-OPUS-5-/5" became
  "OPUS 5.5"; no horizontal scroll.
- Dropdown contents read from the page after the change: Codex list shows "GPT-5.2" …
  "GPT-6 Luna"; Claude list shows one "Haiku 4.5" row, values still the raw ids.
- `tests/unit/dashboard-door-model-display.test.ts` (14 tests) runs the helpers extracted
  from the shipped page; the existing controls, wiring and write-surface suites pass.
