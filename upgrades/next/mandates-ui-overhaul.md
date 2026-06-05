<!-- bump: patch -->

## What Changed

The Mandates dashboard tab was overhauled after a real operator failed to
issue a mandate through it (2026-06-05). Four fixes:

1. **Layout**: the panel (and the Process Health / Machines / Preferences
   panels, which shared the bug) rendered squashed into the 280px sidebar
   grid column. All `.ph-root` panels now span the full grid.
2. **Pre-fills**: Agent A is pre-filled with this agent's own routing
   fingerprint (fetched from `/threadline/health`); expiry is pre-filled to
   one week out. The operator no longer pastes hex strings the system
   already knows.
3. **Validation**: clicking Issue with missing/invalid fields now reports
   EVERY problem at once in plain English, client-side, before anything is
   sent. Previously an empty form POSTed, the server refused, and the only
   feedback was a transient toast.
4. **Persistent feedback**: errors and the "✓ Mandate issued" confirmation
   are persistent banners, not 8-second toasts. A silent failure is no
   longer possible; success is unmissable.

## What to Tell Your User

If you ever tried to issue a coordination mandate from the dashboard and
nothing seemed to happen, that flow is fixed: the form now fills in
everything the system already knows, tells you exactly what is missing
before submitting, and shows an unmissable confirmation when the mandate is
issued. The Mandates, Process Health, Machines, and Preferences tabs also
now use the full width of the page instead of a narrow column.

## Summary of New Capabilities

- Mandates tab: pre-filled Agent A fingerprint + default one-week expiry,
  all-at-once client-side validation, persistent success/error banners,
  plain-English field hints, and the issue form auto-opens when no mandates
  exist yet.
- Layout fix for all `.ph-root` dashboard panels (Mandates, Process Health,
  Machines, Preferences Learning): full-grid width instead of the sidebar
  column.
- Maturity: stable (UI-only change over the existing PIN-gated issuance
  API; no server surface changed).

## Evidence

Born from a live operator report (2026-06-05): "I clicked 'Issue Mandate'
after entering my PIN… this UI/UX is TERRIBLE. Very confusing, unclear, and
squashed to the side" — the mandate never registered server-side and the
failure was invisible. 24 tests green in the mandates tab suite (squash
regression pin, every-problem-at-once validation, persistence under fake
timers, prefill + never-overwrite, auto-open); 80 green across all dashboard
suites; tsc clean.
