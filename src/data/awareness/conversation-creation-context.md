---
title: Generated chat origins and placement previews
---
New App conversations record their creation source and optional parent. When creating an App session with `POST /sessions/create`, include `parentConversationKey` when the parent is known; omission leaves an agent-created chat unplaced, while explicit null records an intentional root. A parent never grants access and later explicit Chief of Staff placement takes priority.

Owner readers can inspect `GET /mobile/conversations/parent-preview` with their existing API authorization. It returns `dryRun:true` and `canApply:false`: inspect its evidence and reasons before proposing any change to existing chats. It never moves, renames or deletes them. List rows distinguish verified children, intentional roots, unresolved generated chats and unknown legacy origins. Missing context from an older machine is unknown, not permission to infer a parent from the title. This capability does not promise recovery while the original computer is offline.
