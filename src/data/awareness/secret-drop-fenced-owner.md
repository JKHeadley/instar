---
title: Recovering an uncertain Needs You credential submission
---
A signed owner submission that could not finish syncing stays protected. If the request is still pending, the same owner can retry the same value. When the request is gone and its owner has authorized disposal, the agent can use its authenticated `DELETE /secrets/fenced/<token>` endpoint with the exact private token from the original request. Keep that token out of messages. A 204 confirms the fenced record is absent. The endpoint refuses live requests and published credentials.
