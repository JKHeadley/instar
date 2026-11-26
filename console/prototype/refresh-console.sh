#!/bin/bash
# Regenerate the console prototype from live data and republish it to the same
# private view, so the link the operator holds always shows current state rather
# than a snapshot from whenever it was built.
#
# Deliberately modest: every 5 minutes, and it stops after 12 hours rather than
# running forever unattended. A prototype that quietly runs for ever is the kind
# of untracked background work this project treats as a defect.
cd /home/echo/.instar/agents/echo
VIEW_ID="73dff92e-480b-4c9f-8405-33d8354c3a8d"
AUTH=$(python3 -c "import json;print(json.load(open('.instar/config.json'))['authToken'])")
for i in $(seq 1 144); do
  if python3 .instar/proto-serve/build-console.py >/dev/null 2>&1; then
    python3 -c "
import json
json.dump({'title':'Echo — console prototype (first screen)','markdown':open('.instar/proto-serve/console.html').read()}, open('/tmp/claude-1000/cv-refresh.json','w'))" 2>/dev/null
    code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 40 -X PUT \
      -H "Authorization: Bearer $AUTH" -H 'Content-Type: application/json' \
      --data-binary @/tmp/claude-1000/cv-refresh.json \
      "http://127.0.0.1:4040/view/$VIEW_ID")
    echo "$(date '+%H:%M:%S') refresh $i -> $code" >> /tmp/claude-1000/console-refresh.log
  else
    echo "$(date '+%H:%M:%S') refresh $i -> build failed" >> /tmp/claude-1000/console-refresh.log
  fi
  sleep 300
done
echo "$(date '+%H:%M:%S') refresher finished its 12h run" >> /tmp/claude-1000/console-refresh.log
