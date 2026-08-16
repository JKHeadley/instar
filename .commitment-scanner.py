#!/usr/bin/env python3
import json
import sys

last_processed = 6214
new_commitments = []

# Read from stdin
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
        msg_id = msg.get('messageId', 0)

        # Only process new messages
        if msg_id <= last_processed:
            continue

        text = str(msg.get('text') or '').lower()
        sender = "user" if msg.get('fromUser') else "agent"

        # Check for commitment patterns
        commitment_phrases = [
            'i will', 'i\'ll', 'let me', 'let\'s', 'we should', 'we need to',
            'todo', 'action item', 'tomorrow', 'next week', 'deadline',
            'gonna', 'going to', 'need to build', 'should implement',
            'must fix', 'have to', 'will implement', 'will build',
            'should create', 'need to add', 'kicking off', 'on it', 'will relay',
            'starting'
        ]

        has_commitment = any(phrase in text for phrase in commitment_phrases)

        if has_commitment and len(text) > 5:
            new_commitments.append({
                'id': msg_id,
                'text': msg.get('text', ''),
                'timestamp': msg.get('timestamp', ''),
                'sender': sender,
                'topicId': msg.get('topicId', '')
            })
    except Exception as e:
        pass

if new_commitments:
    for c in new_commitments:
        print(json.dumps(c))
