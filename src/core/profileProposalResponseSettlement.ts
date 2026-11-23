/** Internal response bookkeeping. These facts never grant profile consent. */
export type ProfileReplySettlementStatus = 'recorded' | 'pending' | 'unbound' | 'not-required' | 'unavailable';
export interface ProfileRegisteredReplyProof {
  readonly generation: string;
  readonly attemptId: string;
  readonly requestId: string;
  readonly source: string;
  readonly principal: string;
  readonly inboundId: string;
  readonly deliveredMessageId: number;
}
export interface ProfileResponseSettlement {
  /** Applies only to this registered question, never unrelated work in the input. */
  replyAlreadyDelivered: boolean;
  replySettlement: { status: ProfileReplySettlementStatus };
}
