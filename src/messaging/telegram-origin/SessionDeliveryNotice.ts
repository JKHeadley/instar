/** Plain text for a session reply whose durable delivery record is unresolved. */
export function sessionDeliveryNotice(state: string, uncertain = false): { summary: string; topicText: string } {
  if (uncertain || state === 'outcome-unknown') return {
    summary: 'A reply may have been lost. I cannot confirm whether it reached the conversation, so I will not send a duplicate blindly.',
    topicText: 'An earlier reply may have been lost after a delivery interruption. I cannot confirm whether it reached you, so I will not send a duplicate blindly. Please ask me to restate the answer if you need it.',
  };
  if (state === 'suppressed') return {
    summary: 'A held reply was not sent because a newer reply reached the conversation first.',
    topicText: 'An earlier reply was not sent because a newer reply reached you first. Please ask me to restate it if something is missing.',
  };
  if (state === 'known-failed' || state === 'expired') return {
    summary: 'A reply did not reach the conversation. The original delivery attempt has ended.',
    topicText: 'An earlier reply did not reach you after a delivery interruption. I am sorry; please ask me to restate it.',
  };
  return {
    summary: 'A reply is delayed by a delivery interruption. I am keeping track of the original delivery attempt.',
    topicText: 'A reply I wrote is delayed by a delivery interruption. I am checking the original delivery attempt; it may arrive after newer messages.',
  };
}

export function lateRecoveredReplyNotice(preparedAt: number, acceptedAt: number, outOfOrder = false): string | null {
  if (outOfOrder) return 'An earlier reply arrived after a newer reply. Please read it as an earlier answer.';
  if (acceptedAt - preparedAt < 300_000) return null;
  return 'An earlier reply was confirmed after a delay and may be out of order with newer answers.';
}
