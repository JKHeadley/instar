# ELI16: secrets you sent but the agent never used are deleted after a day (SEC-157)

When you send the agent a secret through its one-time form, it keeps an encrypted copy on its computer. That way the secret is not lost if the agent restarts before using it.

The problem was that nothing ever threw that copy away. If the agent never used the secret, it sat on the computer, still readable by the agent, forever. The form also said the secret was not stored on disk, which was not true.

Now a saved copy is deleted once it is a day old. Old copies are cleared out whenever the agent starts and whenever someone sends a new secret. The form now says plainly that the secret stays only on that computer until the agent uses it, and never longer than a day. A password meant only for a website is still never saved at all.
