# A slow monitoring command can't hold up the server

The Studio stopped answering health checks for about five minutes. A profile after restart showed that several monitors were waiting for terminal and process commands while holding up the part of the server that serves requests. High swap usage and active paging made the machine slower at the same time. The restart brought it back. We have profiles from the replacement process, so the monitoring wait is the leading explanation for the first stall.

The monitors now wait for their child processes without blocking other requests. Each monitor runs one pass at a time, skips a timer tick when its last pass is still running, and gives each child a deadline. A failed read is treated as unavailable evidence. The orphan monitor also checks again that a session has not become tracked before it signals the process.

The regression starts a deliberately slow monitoring child, then checks that the real HTTP health endpoint responds before that child is released. The change applies automatically on upgrade.
