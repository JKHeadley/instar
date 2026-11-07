# Side effects: requests to the owner

**Over-block:** one open request per person or place, so a second ask waits. Requests expire after three days, a week at most.
**Under-block:** the free-text reason is shown to the owner as someone's words. It is display data, and the action comes only from typed fields.
**Level:** the request gives nothing. Approval is the owner's existing signed write, so every existing check still applies.
**Signal vs authority:** a request is a signal. The owner's signature stays the only authority.
**Confined sessions:** gain one route, `POST /team/proposals`. The requester comes from the session, and `GET /team/people` stays refused.
**Rollback:** remove the routes and the allowlist line; stored requests are ignored.
