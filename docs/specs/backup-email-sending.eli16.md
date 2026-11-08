# Sending email from an agent, in plain English

You asked for email on the list of recommended services, so an agent can send you scheduled reports in your inbox. An agent can't send mail today at all, so email is the one service still marked "not available". This plan adds that ability, with a backup for when it fails. The convergence report linked with this page records the review rounds it went through.

## What it does

Your agent can email you, and only you. A scheduled job can be set to send its report to your inbox instead of (or as well as) your chat, and you can ask the agent to "email me that". Reading your mail is not part of this; the agent only sends.

## Whose account: three choices, all fine

You pick one. The agent explains the trade-off of each and never pushes you toward one.

1. **A sending service called Resend, in your name** (the one I'd propose by default). You type your address on your PIN page; the agent opens the account itself with that address. Resend then emails a verification link to your inbox; you hand that link to the agent through a one-time private link, the same way you'd hand it a code sent to your phone, and the agent finishes the setup in its own browser. The first test email carries a six-digit code you enter on the same page, which proves the address is really yours. It's free for far more mail than reports need, and because no domain is attached, Resend itself will only ever deliver to that one address. Because the account is opened with your address, changing the address later means a new setup, and the page says so. Trade-off: the mail arrives from Resend's address, not yours. Saying yes accepts Resend's terms, and the page says so.
2. **Your own mailbox** (Gmail or iCloud; Outlook no longer allows this). The agent needs an "app password", a separate password your mail provider gives out for programs. You hand the agent your account password and any sign-in code through the private link; it signs in once in a throwaway browser, creates the app password, stores it, and throws the browser away. It never changes your account's security settings on its own: if your provider requires two-step sign-in first and you don't have it, the agent stops, explains what turning it on means, and offers the other two options, or does it for you only if you say so, with your own phone as the second step. You type your address on your PIN page here too, and the agent refuses an app password for any other mailbox, so nothing can quietly point this at a mailbox that isn't yours. Trade-off: an app password lets a program send as you and read your mail; the agent's code only ever sends to you, and only its code is checked.
3. **A spare mailbox of the agent's own**, if you have one to give it. As with Resend, you type where the mail should go on your PIN page and confirm it with the code from the first test email. Trade-off: anything that holds that spare mailbox's password could read that test email too, so this option guards against mistakes rather than against a program that already has the password.

## What keeps it safe

- **Only you, by construction.** The sending code has no "to" field anyone can fill in. The destination is always the address you typed on your PIN page: with your own mailbox the app password has to belong to that address; with Resend and a spare mailbox the code from the first email confirms it before any report goes there. Honest limit: the PIN page and the code stop mistakes, not a hostile part of the agent that already holds the sending credential (it could read the code the same way the mail service shows what was sent); a stronger owner check will replace it when that lands.
- **Nothing gets lost.** Every report is written down before the job is even marked finished, and the note survives restarts, housekeeping of old notes, and a move to another of your agent's machines; a sweep catches any job that finished without its note, and a job that already has one is never sent twice by that sweep. If your chat stays unreachable for a whole day, the agent stops hammering and resumes the moment the chat is back. Whatever the account shape, if the provider refuses a send (a bad credential, the day's limit, a message the safety check stops) the report comes to your chat instead, with one line saying why. With Resend the same happens when the service can't confirm delivery, so you might occasionally get one twice but never zero times. With your own or a spare mailbox the provider can't confirm delivery, so the mail provider accepting the message is the end of the story, which is exactly why the first test email has to arrive before any report is sent that way.
- **No surprise mail, no floods.** One passing test email per setup (a failed one may be retried a couple of times, and never more than three mails a day to an address you haven't confirmed yet). Sends are counted against the provider's daily limit, in one time zone for all of your agent's machines, with the day's remaining scheduled reports protected before one-off requests; the provider's own limit is the final word.
- **No secrets by email.** Everything the agent sends passes the same check that already stops it from putting a password into a chat message.
- **Your accounts stay yours.** Saying no later removes the agent's access and tells you what, if anything, is still in your account to tidy up.
- **Your account's security is yours.** With your own mailbox, if your provider first needs two-step sign-in and you don't have it, the agent stops and explains; it turns that on only if you say so, with your own phone as the second step, never on its own.

## How we'll know it works

The test is a real report arriving in a real inbox, checked by opening the inbox, not by trusting the mail service's word. A second test turns email off on purpose and checks the report still reaches your chat with its one line.

## What you need to decide

Whether this plan is right: Resend in your name proposed as the default, your own mailbox or a spare mailbox as the alternatives, sending only, and only ever to you. Once you approve it, I build it and prove it live like the other services.
