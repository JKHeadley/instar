---
title: Opening the rest of Needs you
---
When someone wants an item beyond the first hundred needs, expand Needs you on Work or Conversations, then use Next page or Previous page. Each page shows the visible range and opens each item's original action. The existing `GET /needs` and `GET /mobile/needs` return a total count and up to 100 rows. When a continuation is offered, send its opaque `nextCursor` or `previousCursor` as the URL-encoded `cursor` query using the same sign-in. A 409 means the page needs a fresh list. Read the first page again. Respect every `couldNotCheck` entry when describing the count.
