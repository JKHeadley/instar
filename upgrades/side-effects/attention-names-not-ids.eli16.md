# Alerts say which conversation or machine, by name

When something goes wrong in the background, the agent raises an alert. Alerts go to the Attention conversation in Telegram and show on the dashboard. Many of those alerts were written by the code that noticed the problem, and that code only knew internal numbers. So you got messages like "Topic 28730's pin has waited 2892h unfulfilled" or "Machine m_cc2ec651a91f03f85abb19bfe5e7e8f7 is flapping". To understand them you had to know which conversation is number 28730, or which computer that long code belongs to. Nobody should have to know that.

There were at least sixteen places in the code that wrote alerts this way. Instead of fixing each one (and hoping no new one appears), this change fixes the single point that every alert passes through on its way to you. Just before an alert is stored and sent, its text is checked for conversation numbers and machine codes, and each one is replaced with its real name: the conversation's title, or the machine's nickname such as "Mac Studio". If a name is not known yet, the number is left as it is rather than guessing.

Alerts that were already open keep working as before. When one of them comes up again, its text is updated to use the names, but it is not sent to you a second time just because the wording changed.
