# Keep account quota visible when a machine needs sign-in

A subscription can be signed in on one computer and need a fresh sign-in on another. The computer that answered can still tell us the current weekly limit. Accounts keeps that reading available alongside the sign-in information. It chooses the newest usable value independently for each limit, so a newer weekly update cannot erase a recent Fable weekly reading. When there is no usable reading, the row shows a neutral quota area and says when it last checked if that time is known. The weekly reset sort still uses the weekly limit, and keeps accounts without a known upcoming reset at the end.

A window that has already reset keeps its previous reading and explains what happened until a fresh number is available. That old number does not count as current usage. If the agent has no recorded check time for an account, the page leaves the time out instead of guessing.
