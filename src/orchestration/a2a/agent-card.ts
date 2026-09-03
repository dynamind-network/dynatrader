import type { AgentCard } from "./types";

export class AgentCardManager {
  private cards: Map<string, AgentCard> = new Map();

  register(agentId: string, card: AgentCard): void {
    this.cards.set(agentId, card);
  }

  get(agentId: string): AgentCard | undefined {
    return this.cards.get(agentId);
  }

  list(): Array<{ id: string; card: AgentCard }> {
    return Array.from(this.cards.entries()).map(([id, card]) => ({ id, card }));
  }

  discover(query?: { skills?: string[]; tags?: string[] }): Array<{ id: string; card: AgentCard }> {
    let results = this.list();
    if (query?.skills?.length) {
      results = results.filter(({ card }) =>
        card.skills.some(s => query.skills!.includes(s.id))
      );
    }
    if (query?.tags?.length) {
      results = results.filter(({ card }) =>
        card.skills.some(s => s.tags.some(t => query.tags!.includes(t)))
      );
    }
    return results;
  }

  // Generate .well-known/agent-card.json (Google A2A)
  toWellKnown(card: AgentCard): object {
    return {
      name: card.name,
      description: card.description,
      version: card.version,
      url: card.url,
      capabilities: card.capabilities,
      authentication: card.authentication,
      defaultInputModes: card.defaultInputModes,
      defaultOutputModes: card.defaultOutputModes,
      skills: card.skills,
    };
  }
}
