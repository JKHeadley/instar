# Readable Notification Previews

The Notifications page collects quiet reports that were not pushed into a conversation. Some reports contain many pages of text. The running dashboard returned fifty notices on one page, including four bodies of sixteen thousand characters. Showing every body in full makes it difficult to scan the page or reach the next notice on a phone.

This change gives a long notice a short preview and a native “Read full notice” disclosure. A short notice continues to show its full text immediately. Opening the disclosure reveals the complete humanized text. No notice is deleted, summarized by a model or marked read automatically. The existing Mark read button, unread filter, older-page controls and notification preferences work as before.

The preview is a display choice, not a decision about importance. It uses the same safe text as the full notice. Names are resolved before either view is built, and an old hover tooltip containing the raw original message is removed. Unicode characters are kept intact and quoted HTML remains text. A native disclosure supplies keyboard access without a separate controller.

Focused DOM tests cover short and long bodies, the length boundary, Unicode, safe full content and the existing action. A browser fixture checks collapsed cards and expansion at phone and laptop widths. The normal shared verifier still owns complete verification before release; local development evidence is not a claim that this change is live.
