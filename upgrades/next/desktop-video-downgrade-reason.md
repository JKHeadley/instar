<!-- bump: patch -->

## What Changed

When a Remote Desktop session falls back from smooth video to the slower picture mode,
the server now records why: the Mac's encoder failed (with a short fixed reason),
the machine cannot produce smooth video, or the viewer's browser asked for pictures.
The session's status reply carries it as `videoDowngrade`. Video behaviour is unchanged.

## What to Tell Your User

Nothing changes on screen yet. This lets me find out why some Remote Desktop sessions
drop to the slower picture mode, so the cause can be fixed.

## Summary of New Capabilities

None. A diagnostic field on an existing status read.
