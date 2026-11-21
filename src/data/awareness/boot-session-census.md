---
title: Sessions a restart ended
---
After every machine restart, each agent lists the sessions that were running before it and ended with it, and marks the ones whose topic had open work. Read it with `curl -H "Authorization: Bearer $AUTH" http://localhost:{{port}}/sessions/boot-census` (add `?since=<bootAt>` to list every boot since a given one). It answers on every machine, even where the resume queue or machine maintenance is off. Nothing is revived automatically yet; a session resumes on its topic's next message. When sessions with open work have not come back 15 minutes after a restart, one note per restart says so. When the user asks "what did the restart cost?" or "which conversations stopped?", read this instead of guessing.
