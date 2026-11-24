# Messages reach the exact session on another computer

A session on the Mama PC was missing messages for its first ten minutes. The old safety check compared the two computers' clocks and mistakenly treated that young session as if it had started after the message.

The repair asks the receiving computer which session holds that role before creating the message. The answer is signed and tied to that one request. The message names that exact session, so it reaches a young session but cannot drift into a replacement that reused its name while the message was travelling. This works over the home network as well as the internet connection. Nothing relies on the computers' clocks agreeing.

If the intended session cannot be proved or has changed, the receiving system records a failure immediately and tries to tell the sender why. Missing proof cannot be invented later. If a known session is merely unavailable, its message can wait within a five-minute budget, with longer gaps between checks; a restart does not reset that allowance. A session whose existing record merely appeared late can still receive its message. Each refusal is recorded for investigation.

Both computers need the update for the full repair. The new sending behavior ships switched off, so computers can update without breaking their existing messages. The repair owner checks receiving support before enabling one sender, watches it, then expands. An enabled sender refuses a message plainly if its receiver cannot prove the intended session. Switching the sender setting off restores its previous sending behavior. If the receiving computer is downgraded with messages still waiting, the old version leaves them alone until their lifetime ends rather than typing them into whichever session now has the name.

The repair records the uncertain interval while a message is being typed. If the server stops during that interval, it records that delivery may have happened and tries to report it and never types the same message a second time.

The signed receiving endpoint is automatic; the new sending behavior has a staged switch controlled by the repair owner. It does not change who may communicate with the agent or who holds the lead. Work is still in progress: targeted checks and the complete shared test run must finish before this can be released.

The recorded outcome is durable. The separate notification can still be lost during a crash or network outage; that older notification problem has its own tracked repair. This change does not claim to solve it. The receiving protocol also prevents an older version from accepting a protected message after a downgrade.
