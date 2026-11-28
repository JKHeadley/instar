# Remote Desktop video that stopped at the first picture — Plain-English Overview

## The problem in one breath

On Justin's Mac Studio, Remote Desktop asked for smooth H.264 video, the Mac sent it, and the browser said it could play it. Yet the browser never showed a single frame, and after 2.5 seconds the viewer gave up and dropped to the slow picture mode at one or two pictures a second.

## Why it happened

A video stream starts with a short header that describes it. One thing the header can say is "frames always arrive in the order they are shown". The Mac's encoder never reorders frames, but its header doesn't say so. Without that line, Chrome on a Mac plays safe and holds back as many frames as the video's level allows before showing the first one: 12 frames for the Studio's screen size. At four frames a second that takes three seconds, longer than the viewer waits. At a full 1080p screen the hold is 4 frames, so video worked there, but always a little late.

## What this changes

Before decoding, the viewer page adds the missing line to the header: no frames are reordered. It touches only that one header, and only in the exact form the Mac encoder writes. Every other header passes through unchanged. Nothing changes on the Mac, so no macOS permission has to be granted again.

## How we know it works

On the M5, real frames from the same Mac encoder settings went into Chrome's own video decoder. With the original header, nothing came out until the 13th frame. With the added line, every frame came out as soon as it went in. Tests check the exact header bytes, and that other headers are left alone.

## What you actually need to decide

Nothing. The next speed reading on the Studio will show whether smooth video now stays on.
