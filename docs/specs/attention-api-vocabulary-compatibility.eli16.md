# ELI16: Attention API vocabulary compatibility

The Attention Queue is where Instar puts things the user should not miss: a
decision, a review request, a recurring degradation, or something else that
needs human attention. The queue stores items in a strict internal format. For
example, an item that is still active has status `OPEN`, and an item that is
finished has status `DONE`.

That internal format is fine for the system, but the instructions given to
agents used friendlier words. The docs said an agent could resolve an item by
sending a status of `resolved`. That is a natural word for a person or an agent
to use, but the route only accepted the internal word `DONE`. So the API could
show a real item, but the documented way to close it would fail.

The same mismatch existed for creating items. The docs used `body`, `source`,
and a `medium` priority. The route expected `summary`, `sourceContext`, and the
internal priority `NORMAL`. That meant a well-behaved agent following the local
instructions could accidentally send a shape the server rejected.

This fix adds a small compatibility layer at the route boundary. The server
still stores and returns the canonical internal values, so existing dashboards
and state files do not change. But the write side now understands the documented
aliases. If an agent sends `resolved`, the server stores `DONE`. If it sends
`medium`, the server stores `NORMAL`. If it sends `body`, the server treats it as
the item summary. If it sends `source`, the server treats it as `sourceContext`.

The generated guidance now also shows the required stable `id` field when
creating an item. That matters because the id is how repeated reports about the
same issue collapse onto one queue item instead of creating needless duplicates.

This does not create any new attention items and does not rewrite old state.
Existing items that already say `OPEN` or `DONE` keep saying that. The goal is
only to make the documented write vocabulary and the canonical read vocabulary
work together.

The tests cover the behavior in three layers. A unit test checks the vocabulary
normalizer directly. An integration test checks the HTTP route with a stubbed
attention adapter so no Telegram topics are created. An e2e test boots the real
server route stack with a stubbed adapter and proves the documented create and
resolve shapes work end to end.
