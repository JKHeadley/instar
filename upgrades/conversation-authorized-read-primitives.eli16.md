# Conversations read primitives

## What Changed
Conversations needs one consistent way to describe efforts and their worker conversations. This checkpoint adds that common description, its rules for reducing verified changes, and the read model used by the dashboard and phone. It does not turn the feature on. The full server, storage and app still have separate release checks.

A person can eventually browse a quiet Overview, use All or search, and open the original conversation. The read model only returns information that the signed-in person may see. A hidden parent must not reveal its name, its placement identifiers or an explanation about its front door. A review found that the correction details could expose those identifiers even though the visible path was empty. The corrected boundary requires fresh authority to inspect the whole correction context. Limited views receive no correction details, including when the visible item really has no parent. The server does not make up empty change history to let a write proceed.

The final response checks that the person still has that authority. If it changed while the response was being prepared, the server asks the client to refresh instead of releasing the old private details. The real owner retains the same response shape when the actual runtime supplies current full-owner authority. Moving an item still needs the separate preview and write checks.

## Limits
A passing read test is not a running feature. These modules rely on a runtime that supplies only genuinely certified graph changes. They do not create that certification, make an extra copy, solve recovery capacity, or remove historical backups. A sleeping or unavailable machine must still be described honestly. An outside service remains optional, and this checkpoint purchases nothing. The app's successful signed fixture test remains separate from normal boot and live deployment.

## Evidence
The previous source failed the added restricted-view regression. The fixed reducer and read tests passed 75 of 75, including a real HTTP response that refuses correction details after the grant changes. Independent source review, current typechecking, isolated-prefix verification and the normal commit gates are required before this checkpoint is complete.
