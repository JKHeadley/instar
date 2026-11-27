# Console chat bubbles: show bold, italic, code and links instead of the raw symbols (ELI16)

## What this changes

Agents often write their messages with small formatting marks. Two stars around words (`**Build things.**`) mean bold, one star or underscore means italic, backticks mean a bit of code, two tildes mean crossed out, and `[text](https://...)` means a link. On the web dashboard's Conversations page, those marks were shown exactly as typed, so a message was full of stars and brackets that made it harder to read.

The iPhone and Android apps were changed today to show those marks as real styling. This change does the same on the web dashboard: bold text is bold, italic is italic, code looks like code, crossed-out text is crossed out, and a link is a clickable link that opens in a new tab.

## What stays the same

Line breaks and list dashes stay exactly as typed. A word like `my_file_name` keeps its underscores and does not turn italic. A mark with no partner (like `2 * 3`) stays as it is. Bigger formatting such as headings or tables is not changed, which matches the phone apps. What you type and send is not changed at all; only how messages look on the page.

## Safeguards

Messages can come from anyone in a conversation, so the page never treats their text as web page code. It builds the styled pieces one by one as plain text inside bold, italic or code boxes, so something like a hidden image tag simply shows as text. Only links that start with `http://` or `https://` become clickable; a link that tries to run a script (`javascript:`) or carry a hidden page (`data:`) is shown as the typed text instead. Clickable links open in a new tab that cannot reach back into the dashboard. If anything looked wrong, undoing the one commit puts the plain text back, with no data to repair. Tests check each rule above and the real page rendering a message.

## What you need to decide

Nothing. This brings the web dashboard in line with the phone apps.
