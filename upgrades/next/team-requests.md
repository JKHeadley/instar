<!-- bump: patch -->

## What Changed

When someone asks the agent for access, the agent can now file a request for the owner instead of having nowhere to put it. A request is a typed change: share a conversation, change a role, or invite someone. It gives nobody anything. The owner sees a plain line built from those typed fields, and approving is the owner's own signed change, which must match the request exactly. A member's own locked-down session can ask, and the person asking is taken from the session. Each person or shared place has one open request at a time.

## What to Tell Your User

If someone on your team asks me for access, I can now send you the request instead of just telling them to ask you. You will see it in the app, ready to approve or decline. Nobody gets anything until you approve. The app screen for this is on its way.

## Summary of New Capabilities

`POST /team/proposals`, `GET /mobile/team/requests`, `POST /mobile/team/requests/:id/decline`, and `requestId` on the owner's existing signed writes.

## Evidence

Tests cover both sides of each check, including a mismatched approval and a false requester in the body, and the journey test on a real server files and declines a request. 395 related test files pass. Removing the match check, the session requester and the close step each turned a test red.
