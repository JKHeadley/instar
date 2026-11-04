# Voice notes from the app get transcribed — plain overview

**What this is.** The Instar iPhone app can send the agent a voice note inside its own conversations. Until now the agent only got words if the phone itself turned the recording into text. If the phone could not (no on-device recognizer for that language, or recognition failed), the agent saw the audio file with the words "(no transcript)" and nothing else. Telegram voice messages never had this gap, because the server sends Telegram audio to a transcription service (Groq or OpenAI, whichever key the agent has).

**What already existed.** The Telegram adapter had that transcription code, private to itself: pick the provider from an explicit setting or from whichever API key is present, upload the audio, get the text back, with a 60-second limit. The app conversation code already turned each attachment into one line for the session, `[voice:<path>] <words>`.

**What is new.** The Telegram transcription code moved into one shared module. Telegram calls it exactly as before. The app conversation code now calls the same module for a voice note that arrived without the phone's words, and puts the result on the voice line. Nothing about how the file is stored, signed, copied between machines or shown in the app changes. If the phone already sent words, they are used and the server does not transcribe again.

**When it cannot transcribe.** No key set up, the service answering with an error, or no answer within 60 seconds: the message is still delivered, with the file path, and the line says plainly "transcription unavailable" and why. The agent can still open the recording. A failure is also reported to the agent's degradation log so a broken key does not go unnoticed. A missing key is not reported, because that is a normal setup.

**Safeguards.** The audio only leaves the machine when the operator has already set up a transcription key, which today already sends their Telegram voice messages to that same service. An explicitly chosen provider whose key is missing is never quietly swapped for the other vendor. The transcript is put on one line, so it cannot fake a new message header in the session.

**What it does not do.** The transcript is not saved back into the conversation history yet, so the app's history still shows the phone's transcript only, and a voice note that arrives late from another machine ("file now available") is delivered without a transcript. Those are the remaining part of the spec's increment 2 and are tracked as ACT-179.

**What a reader needs to decide.** Nothing beyond reviewing the pull request: this reuses existing code, is undone by a revert, and only affects agents with native app conversations and media turned on.
