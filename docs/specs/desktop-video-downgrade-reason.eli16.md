# Saying why Remote Desktop fell back to the slow picture mode — Plain-English Overview

## The problem in one breath

Remote Desktop normally sends the screen as smooth video (H.264). When something goes wrong it falls back to sending separate pictures (JPEG), which is much slower. On 27 November a test on the Mac Studio fell back every time, and there was no way to tell why. The screen only says "Video switched to compatibility mode", and three different problems all show that same line.

## What already exists

The server already notices each of these problems and quietly switches the session to pictures, so the session keeps working. It just never writes down which problem it was.

## What this adds

The server now remembers the first reason a session left smooth video and reports it when the viewer asks for the session's status. There are three kinds of reason:
- the Mac's video encoder failed, with a short fixed name for the failure;
- this machine cannot produce smooth video at all;
- the viewer's browser could not play the video and asked for pictures instead.

## The safeguards

- Nothing about how the video behaves changes. Only the reason is recorded.
- Only a short fixed word is kept, never raw error text.
- Only the person viewing that session can read it, the same as the rest of its status.
- The first reason is never overwritten, so a later switch cannot hide it.

## What ships when

It ships with the next release. The next live reading on the Studio reads it.

## What you actually need to decide

Nothing.
