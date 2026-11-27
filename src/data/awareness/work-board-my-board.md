---
title: My board on the Work Board
---
Every Work Board read (`GET /work-board`, and the phone's `GET /mobile/work-board`) carries `myBoard.sections`: the cards that need the reader, each card once under its most pressing reason, in this order: "Waiting for your approval", "Waiting for your reply", "Your cards", "Cards you were added to" (a team member's shared cards) and "Held for later". Each section lists `cardIds` (untouched cards first, then started ones, newest first), `notStarted`, and `more` when the soft limit cut some. When the owner asks "what needs me?" or "what is on my board?", answer from these sections with their words, not from the lanes: `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/work-board`.
