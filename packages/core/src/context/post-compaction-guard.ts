import type { ConversationMessage } from "@dyna/contracts";

export interface PostCompactionGuardResult {
  stuck: boolean;
  repeatedCount: number;
  pattern: string;
  message: string;
}

function normalize(content: string): string {
  return content.trim().replace(/\s+/g, " ");
}

export class PostCompactionGuard {
  check(messages: ConversationMessage[]): PostCompactionGuardResult {
    const tail = messages.slice(-3);
    if (tail.length < 3) {
      return { stuck: false, repeatedCount: tail.length, pattern: "", message: "" };
    }

    const normalized = tail.map((message) => normalize(String(message.content ?? "")));
    const stuck = normalized[0] === normalized[1] && normalized[1] === normalized[2];

    return {
      stuck,
      repeatedCount: stuck ? 3 : 0,
      pattern: stuck ? normalized[0] ?? "" : "",
      message: stuck
        ? "Post-compaction guard detected three identical tail messages. Change direction before continuing."
        : "",
    };
  }
}
