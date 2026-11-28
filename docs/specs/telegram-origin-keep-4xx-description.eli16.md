# Writing down why Telegram refused a message (ELI16)

When the agent sends a message to Telegram and Telegram says no, Telegram also explains why, in a short sentence such as "Bad Request: message thread not found". Until now the server kept only the number of the error and threw the sentence away. On 27 November every reply to one of Justin's Telegram conversations was refused for hours, and there was no way to tell why from anything the server had kept.

Now the server writes that sentence into its log, cut to a reasonable length and with anything that looks like a password blanked out. It also writes down the shape of the message it tried to send: which settings it used, how long the text was, and where any bold or link formatting sat, but never the words themselves. The next time Telegram refuses something, the reason is right there. Nothing about how messages are sent or retried changes.
