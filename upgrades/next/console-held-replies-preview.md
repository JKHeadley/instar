# Calmer Home, no failing PIN box, and a dashboard preview

<!-- bump: patch -->

## What Changed

- The console's Home no longer shows held replies. Retrying a held reply is the agent's job, so the delivery card is gone from Home and delivery status never shapes the headline. The Messages page still shows delivery records.
- The Home headline is now the first thing that needs the operator, as a link that opens that item in the list below. When there is more than one, the line under it says how many more. Urgent queue items lead.
- A new unauthenticated `GET /dashboard/unlock-check` answers whether a PIN typed on this connection can be accepted. The console asks first, and where the answer is no it shows the reason and a button to the secure address instead of a PIN box that would fail. The unlock route and the check share one rule.
- A new fixed address `/dashboard/preview/` serves console pages from `.instar/dashboard-preview/`, outside the installed package, so an update never overwrites it. `scripts/publish-dashboard-preview.mjs` publishes a checkout's pages there in seconds, without a merge. Each preview screen has a banner naming the branch and when it was published. With nothing published the address answers a plain 404.

## What to Tell Your User

Home now leads with the one thing that needs you, as a link you can tap. Messages I'm still retrying no longer show up as something for you to deal with. If you open the dashboard on an address where your PIN can't work, you get a button to the right address instead of a box that fails. There's also a fixed preview link where you can try my dashboard changes before they're merged.

## Summary of New Capabilities

`/dashboard/preview/` with its publisher script, and `GET /dashboard/unlock-check`. Fresh and existing agent instructions describe the preview.

## Evidence

The operator reported the held-replies headline and the failing PIN box on 2026-10-31, and lost a hand-copied preview to an update the same morning. Unit, HTTP integration and production-boot tests cover the preview, the unlock check, the headline link and the PIN pre-check.
