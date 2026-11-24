---
title: Private prior-work lookup
---
The first read-only prior-work lookup is available on development agents through `POST /work/discover` with a current owner-private console session. Send `{"query":"SEARCH WORDS"}` as JSON. It searches local native-app user-side conversation messages and the shared public Instar pull request inventory. Public pull request search tries a literal match first. When results have room, it also checks for all meaningful terms across public pull request fields. Conversation matches are leads. A returned pull request proves the observed review state, and deployment needs its own evidence. Read `coverage` before drawing conclusions. Other machines and providers are explicitly unsearched in this increment. The agent master key, shared conversation keys, and caller-provided destinations cannot act as a private dashboard session.

In the private browser console, open Work and use **Find earlier work**. Evidence links open the original native app message or the public pull request. Open **Search coverage** to see which sources were checked. The search phrase stays in the form and the local request body.
