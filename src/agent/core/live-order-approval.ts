import type { ApprovalToken, ToolCall } from '../../types';

const approvedOrderTokens = new WeakMap<ToolCall, ApprovalToken>();

/** Attach a one-shot approval created by the interactive runtime, never from model arguments. */
export function attachLiveOrderApproval(call: ToolCall, token: ApprovalToken): void {
  approvedOrderTokens.set(call, token);
}

/** Consume the interactive approval when the matching live order tool executes. */
export function consumeLiveOrderApproval(call: ToolCall): ApprovalToken | undefined {
  const token = approvedOrderTokens.get(call);
  approvedOrderTokens.delete(call);
  return token;
}
