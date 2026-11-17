# Document decisions, in plain words

**What it is.** When Echo writes you a document that needs a yes or no ("ship this?"), the document shows the question and lets you **Approve** or **Decline** (with an optional note).

**How you answer.** On your phone, in the Instar app: tap Approve or Decline, check the sheet (it shows the document, the version and the question), and confirm with Face ID. On a computer, the page has one button, "Approve or decline on your phone", which sends the question to your phone; the page updates by itself when you answer. Your phone also gets a notification as soon as Echo asks, and the question sits in your Needs-you list until you answer.

**What happens next.** The document is marked "Approved by you · time · version 2". Your phone sends a message saying so into the conversation the document belongs to, as your own message, and the session working on it picks it up. Even if that message never gets through, the session sees the decision on its list of documents.

**Why it can be trusted.**
- Only your phone, with your face, can answer. Echo can't, a dashboard PIN can't, a teammate can't, and a phone that was only paired with the PIN can't (Echo can read the PIN).
- The answer counts only for the exact version and question you saw. If Echo changes the document after you declined, you're asked again on the new version.
- Every machine re-checks your phone's signature before showing the answer, so no machine can fake one.
- Echo treats the record on the document as the real answer, not the chat message.

**If something goes wrong.** If the message didn't go out, the document says "Not sent to the conversation yet" and the app offers "Send now" (it can never send twice). If your phone is offline, nothing is queued; you answer again when it's back.

**Rolling it out.** If you run Echo on two machines, the buttons appear once both have the update, so one machine never gets confused by rows it can't read yet.

**Undo.** Revert the change; answers already given stay readable.
