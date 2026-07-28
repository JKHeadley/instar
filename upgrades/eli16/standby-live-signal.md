# Standby live-signal fix

Codex shows a small “Working” timer while it is busy. After one minute, that timer changes shape. Standby did not recognize the longer shape and could let a guess from another model call the visibly working agent stuck.

Standby now recognizes both timer shapes. When the live terminal itself proves the agent is working, that direct evidence wins over a weaker guess.
