<!-- bump: patch -->

## What Changed

Remote Desktop's smooth video no longer stalls at the first picture in Chrome on a Mac. The Mac's H.264 stream header did not say that frames are never reordered, so Chrome held up to 12 frames before showing anything and the viewer fell back to the slower picture mode. The viewer now adds that statement to the header before decoding. Only the exact header shape the Mac encoder writes is changed.

## What to Tell Your User

Remote Desktop to a Mac should now stay on smooth video in Chrome instead of switching to compatibility mode after a moment, and every picture shows sooner.

## Summary of New Capabilities

None. A fix inside the existing Remote Desktop viewer.

## Evidence

Reproduction: a live reading on the Mac Studio on 2026-11-27 at 21:13 PT. The browser reported H.264 support and asked for it. Its decoder took 10 frames, gave 0 pictures and reported no error, and the viewer then showed "Video switched to compatibility mode". The SPS from VTCompressionSession with the helper's settings (Baseline 4.0, no reordering) at 608x1080 is 27420028ab404c044fca80: picture order count type 0 and no VUI. Before and after, on Chrome 158 on a Mac with 20 real frames from that encoder, fed one every 70 ms: the original SPS gave its first picture after the 13th frame and stayed 12 frames behind. The rewritten SPS gave each picture as soon as its frame was decoded, 20 of 20, with no errors.
