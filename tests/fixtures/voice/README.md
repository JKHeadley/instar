Real captured fixtures (2026-11-14, Studio, whisper.cpp 1.9.5, ggml-base.bin).
speech.ogg: macOS `say` "Hello Echo, this is a test voice note about the local transcriber." encoded Opus-in-OGG like a Telegram voice note.
silence.ogg: 3 s of digital silence, Opus-in-OGG.
*.stdout: exact whisper-cli -nt -np stdout for each after ffmpeg 16 kHz mono WAV conversion. Note silence yields " you" (a whisper hallucination), not [BLANK_AUDIO].
