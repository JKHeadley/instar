---
title: Read and approve project alignment anchors
---
Use the project registry for the approved purpose, done list, and scope of a project. A project conversation can use its exact conversation key to resolve an approved revision. Treat missing or ambiguous lookup results as ordinary recovery. A draft, project title, or nearby topic is insufficient to establish an approved purpose.


In an operator session, to initialize an unanchored project from an original owner message, send the same endpoint `expectedVersion`, the project's assigned `conversationKey`, and `sourceMessage` with its own `conversationKey`, `messageId`, and `at`. The registry copies the complete text from verified local Telegram history and saves empty done and scope lists. The source can come from another conversation. If local history cannot verify it, the registry returns `project-anchor-owner-source-unverified`.
