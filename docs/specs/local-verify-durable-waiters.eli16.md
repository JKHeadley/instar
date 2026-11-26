# Keep waiting pull requests in Local Verify

When the verification queue is full, an eligible pull request can wait outside the queue. Previously, the waiting entry disappeared if the pull request was not offered again for several hours. An open request could lose its place without anyone closing it, editing it, or asking for it to leave.

This repair saves the exact revision that asked to run. When space opens, Local Verify checks GitHub and offers the saved request again through its usual process. A request stays on the waiting list while its revision is open and ready. If GitHub cannot answer, it stays available for a later check. Local Verify checks for a moved head, a changed target branch or a draft before it starts anything. If the waiting list itself is full, the new request gets an explicit refusal and the existing requests retain their places. The same rules for priority, operator holds and verification still apply.
