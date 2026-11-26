# Protected standalone App pins

On the disposable server, the standalone pin list uses the same signed owner authority, removal proof and surviving-message preview projection as protected history. It never returns the cached preview for a removed pin. Mutation requests for enrolled chats are refused until they have removal-aware write authorization. The production router is unenrolled by default. Telegram and Slack pins continue through their normal paths.

## 6b. Operator-surface quality

The same surviving pins are shown whether the app opens the standalone pin list or reads chat history.

## Framework generality

The protected pin response uses App message identities independently of device platform.

## Independent review

Concur for isolated acceptance. The standalone response preserves the existing shape and uses the protected history projection. Enrolled mutation requests cannot fall through to the ordinary writer.
