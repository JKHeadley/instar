# Counting where remote desktop pictures go

Remote desktop works by grabbing a picture of the remote screen over and over, compressing it, and sending it to your phone or browser. On Mama PC, the phone was getting only about 2 new pictures a second while the screen was changing, so motion looked choppy. Yet Mama itself can grab and compress a full-screen picture in about 50 milliseconds, which is enough for about 20 a second. The pictures were being lost somewhere along the way, and nothing recorded where.

This change adds a simple count to every remote desktop session on the machine being viewed. It records how many times the machine tried to grab the screen, how many grabs found nothing new, how many pictures it sent, and how many it dropped and why. A drop can happen because the connection's allowance for the second was used up, or because the viewer hadn't received the earlier pictures yet. It also records how long each grab took, the pictures sent per second, and the bit rate. When the session ends, these numbers go into the machine's log as one line.

Only numbers are recorded. The pictures themselves, who was connected, and their permission are never written down. Nothing changes for the person using remote desktop. The point is to read Mama's numbers after a session and fix the hop that is losing pictures.
