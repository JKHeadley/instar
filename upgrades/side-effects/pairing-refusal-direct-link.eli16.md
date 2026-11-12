# Pairing messages now link straight to the dashboard page

## What happened

Justin pasted a pairing invite to Cora, one of his agents. A pairing invite is the one-time code two agents use to connect. Cora had not been told who its owner is, so it could not accept the invite from Telegram, which is the correct safety behaviour. But its reply only said "Open the Threadline tab on the dashboard to do this with your PIN. Paste the invite there." There was no link. Justin's standing rule is that an agent always gives a direct link, so the person never has to find a page by hand.

## What changes

Every pairing message that sends the owner to the dashboard now includes a direct link to the exact page. The link is built from the agent's real address:

- When the agent's tunnel (its public web address) is up, the message gives that link, and it opens on a phone.
- When the agent has no tunnel at all, the message gives the local link and says plainly that it only opens on the computer the agent runs on.
- When the tunnel is still starting, the message says it cannot give a link yet and to try again in a few minutes.
- If the agent does not know its address, it says that instead of a bare "open the tab".

The paste link opens the dashboard's Other agents page with the "Connect another agent" box already open and the cursor in the paste field. The invite itself is never put in the link. It is a secret that works once, and links get saved in chat history and browser history.

The same fix covers the other places with the same gap: the reply when someone taps an Approve or Finish button that cannot be used, the Finish prompt when Telegram approval is off, and the "finishing by myself" notice that tells the owner where to unpair.

Two smaller parts. If someone in a group chat who is not the agent's approver tries it, they get no dashboard address, only a note that the approver can do it on the dashboard. And the agent's own instructions now say to always give the direct link for pairing; agents that are already installed get that line on their next update.

This change also carries another session's fix (first opened as PR 3087), which made the approval messages clearer and stopped a refused invite from showing a delivered tick. The two ship together so they need only one test run.

## What stays the same

Who may approve a pairing, and when Telegram buttons work, do not change at all. Only the words and the link change.

## What to decide

Nothing. This is a small, reversible fix.
