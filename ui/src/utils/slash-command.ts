/**
 * Slash Command Parser
 * Simple parser for commands like /init, /mcp, /help
 */

export interface ParsedSlashCommand {
  command: string;
  args: string;
}

export function parseSlashCommand(input: string): ParsedSlashCommand | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith("/")) {
    return null;
  }

  const withoutSlash = trimmed.slice(1);
  const spaceIndex = withoutSlash.indexOf(" ");

  if (spaceIndex === -1) {
    return { command: withoutSlash.toLowerCase(), args: "" };
  }

  const command = withoutSlash.slice(0, spaceIndex).toLowerCase();
  const args = withoutSlash.slice(spaceIndex + 1).trim();

  return { command, args };
}
