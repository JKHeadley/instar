# Voice note transcripts are now saved (plain English)

When you record a voice note in the Instar iPhone app, the phone usually turns your speech into text by itself and sends that text along with the audio. Sometimes it can't: the language isn't supported on the phone, the recognizer fails, or the note is too long. In those cases the agent's computer does the transcription instead, using the same service it already uses for Telegram voice notes.

Until now, that computer-made text was handed to the agent's session once and then forgotten. It was not saved with the conversation, so the app never showed it, and another of your machines never saw it.

This change saves it. The text is stored next to the message as a separate record that says "the agent's computer made this". It is kept separate on purpose: your phone signs every message you send, so anyone can check later that the message really came from your phone. The phone never saw the computer-made text, so it must not look as if the phone signed it. The app shows it marked as coming from the agent, and your message still shows as signed.

Before the text is saved or shown to the agent, it gets the same safety cleaning as text from the phone. If you happened to say a pairing invite or a remote-desktop code out loud, it is removed, and a pending pairing whose code you dictated is cancelled.

Transcription sometimes takes a while. The agent does not wait more than a minute: it gets your voice note right away with a short note that the words will follow. When the text arrives, it is saved and the agent gets one extra line with it. If nobody is listening right then, that line is waiting for the agent the next time you write.

If the voice note itself was still being copied from another of your machines when the agent first heard about it, the computer transcribes it as soon as the file arrives and includes the text in the "your file is here now" line.

Each voice note is transcribed at most once on each computer. If it fails, the agent is told why in plain words and can still listen to the audio file; it does not keep trying over and over.

Older versions of Instar on your other machines don't know this new kind of record. They politely refuse it and count the refusal, and everything else keeps working.
