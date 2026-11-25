# App message reactions

Reactions let you respond to a message with an emoji without sending another chat message. Choose a message and select one of the reactions available in the app. Picking a replacement changes your reaction, and clearing it removes it. Your draft and attached files stay where they are while you do this.

The app asks the server to change the reaction on the message you selected. The server checks that the message is still available to you and that you can act in the conversation. Two devices paired to the same person update the same reaction. If one device changes it while another device is looking at an older value, the app can show the new value before you decide whether to change it again. A network retry does not add a second reaction.

The first server build is off by default and applies to App messages. Telegram's bot can change its own reaction, and that would show up under the bot's identity. This first build keeps your App reaction under your own identity and leaves Telegram unchanged.
