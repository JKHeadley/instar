# Machine groups in the native Accounts list

An account can be present on more than one computer. The Mac app needs to tell those computers apart to show the account under the right headings. The existing Accounts response gives the app each computer's name and sign-in status. Names can be repeated or changed, so the response now includes a stable grouping key for each known computer and indicates that the account has a slot on it.

The key is for organizing the display. Signing in still uses the existing approval flow for the chosen account and computer. The response does not reveal the original machine identifiers. If the server cannot identify a computer, it returns no key for that slot. Older app versions can continue to read the same Accounts response and ignore these additional fields. The app can keep provider grouping on servers that have not yet added machine keys.
