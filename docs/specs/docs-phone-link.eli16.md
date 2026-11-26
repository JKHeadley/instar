# Opening a document link on a phone

## What was wrong

When Instar shares a document, it sends a link to the document's page on the agent. On a computer that page asks you to link the computer to your phone: it shows a QR code, you scan it with the Instar app, and from then on that computer can open documents. On a phone, the same page showed the same QR code. That is a dead end, because the phone that would scan the code is the very phone showing it. Justin hit this tapping a document link in Telegram on his iPhone.

## What already exists

The Instar iPhone app can already open any document by its id, with its own secure device key, from the Documents list inside a conversation. instar.sh already tells iPhones that pairing links (instar.sh/pair) belong to the Instar app, so a tap on one opens the app instead of a web page.

## What is new

On a phone or tablet browser, the document page now shows "Open this document in the Instar app" with one big button. The button is an instar.sh/doc link that names the agent's address and the document. instar.sh now tells iPhones that these links also belong to the Instar app, and the app opens the document on the right agent. A computer sees exactly what it saw before: the QR code to link it. If the app is not installed, or the browser keeps the link to itself, a short instar.sh page says how to open the document from the app, with a link back to the page for use on a computer.

## Safeguards

The new link holds no secret: only the agent's address and the document id, which the original link already showed. Opening still needs the phone's own key, checked by the agent exactly as before, so a link forwarded to someone else opens nothing for them. If the phone isn't paired with that agent, the app says so in plain words. Undoing the change is a revert; nothing is stored or migrated.

## What you need to decide

Nothing. This is a fix for a dead end. A new iPhone app build is needed for the app half and goes out through the usual app channel.
