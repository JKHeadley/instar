# Sign-in repair can now use a backup code — plain-English version

Some of your Google accounts keep their 2-step verification app on a phone. Google only allows one authenticator app per account, so the agent can't have its own for those accounts without breaking the phone's codes. When Google asks one of those accounts for a second step during an automatic sign-in repair, the repair used to have no answer and had to stop and ask you.

Every Google account also has a list of backup codes: eight-digit codes that each work once. Earlier today I saved the unused codes for justin@, dawn@ and headley.justin@ in the encrypted vault. This change lets the repair use them.

When Google shows its backup-code box, the repair takes the first code from that account's saved list and deletes it from the list before typing it, so a used code is never tried again. It only ever types a code into Google's own backup-code box, never into a box asking for a text-message or authenticator code, which would waste a code. The model that chooses the steps never sees the code itself.

When an account runs low on codes, new ones can be made from the account's security page. Nothing needs deciding.
