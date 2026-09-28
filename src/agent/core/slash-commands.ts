/**
 * Slash Commands System
 *
 * Provides power users quick access to agent functions via /commands.
 * Inspired by Vibe-Trading's 13+ slash commands.
 *
 * All commands are registered in registerDefaultCommands() — simple, no separate files needed.
 * Commands bypass the LLM entirely and return immediately.
 */

import { join } from "path";
import type { GoalLoopManager } from "./goal-loop";

// ---------------------------------------------------------------------------
// Interfaces
// ---------------------------------------------------------------------------

export interface CommandContext {
  agent?: any;
  sessionManager?: any;
  modelRouter?: any;
  toolRegistry?: any;
  memory?: any;
  goalManager?: any;
  goalLoop?: any;
  skillFactory?: any;
  dreamEngine?: any;
  cronEngine?: any;
  getConversationHistory?: () => any[];
  clearConversation?: () => void;
}

export interface CommandResult {
  content: string;
  metadata?: Record<string, unknown>;
}

export interface SlashCommand {
  name: string;
  description: string;
  usage: string;
  aliases?: string[];
  execute: (args: string, context: CommandContext) => Promise<CommandResult>;
}

// ---------------------------------------------------------------------------
// SlashCommandRegistry
// ---------------------------------------------------------------------------

export class SlashCommandRegistry {
  private commands: Map<string, SlashCommand> = new Map();
  private aliasMap: Map<string, string> = new Map();

  register(command: SlashCommand): void {
    this.commands.set(command.name, command);
    if (command.aliases) {
      for (const alias of command.aliases) {
        this.aliasMap.set(alias, command.name);
      }
    }
  }

  async execute(input: string, context: CommandContext): Promise<CommandResult | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith("/")) return null;

    const spaceIdx = trimmed.indexOf(" ");
    const cmdName = spaceIdx > 0 ? trimmed.slice(0, spaceIdx) : trimmed;
    const args = spaceIdx > 0 ? trimmed.slice(spaceIdx + 1).trim() : "";

    // Resolve alias
    const resolved = this.aliasMap.get(cmdName) ?? cmdName;
    const command = this.commands.get(resolved);
    if (!command) {
      return { content: `Unknown command: ${cmdName}. Type /help for available commands.` };
    }

    return command.execute(args, context);
  }

  listCommands(): SlashCommand[] {
    return Array.from(this.commands.values());
  }

  hasCommand(name: string): boolean {
    return this.commands.has(name) || this.aliasMap.has(name);
  }
}

// ---------------------------------------------------------------------------
// Default Commands
// ---------------------------------------------------------------------------

export function registerDefaultCommands(registry: SlashCommandRegistry): void {
  // /help — Show all commands
  registry.register({
    name: "/help",
    description: "Show all available commands",
    usage: "/help",
    execute: async (_args, _ctx) => {
      const cmds = registry.listCommands();
      const lines = cmds.map((c) => `  ${c.usage.padEnd(30)} ${c.description}`);
      return { content: `Available commands:\n${lines.join("\n")}` };
    },
  });

  // /clear — Clear conversation
  registry.register({
    name: "/clear",
    description: "Clear conversation history",
    usage: "/clear",
    execute: async (_args, ctx) => {
      ctx.clearConversation?.();
      return { content: "Conversation cleared." };
    },
  });

  // /sessions — List sessions
  registry.register({
    name: "/sessions",
    description: "List all sessions",
    usage: "/sessions",
    execute: async (_args, ctx) => {
      const sessions = ctx.sessionManager?.listSessions?.() ?? [];
      if (sessions.length === 0) return { content: "No sessions. Start chatting to create one." };
      const lines = sessions.map((s: any) => `  ${s.id} — ${s.name} (${s.messageCount} msgs)`);
      return { content: `Sessions:\n${lines.join("\n")}` };
    },
  });

  // /session new [name]
  registry.register({
    name: "/session new",
    description: "Create a new session",
    usage: "/session new [name]",
    execute: async (args, ctx) => {
      const session = ctx.sessionManager?.createSession?.(args || undefined);
      if (!session) return { content: "Failed to create session." };
      return { content: `Created session: ${session.id} — ${session.name}` };
    },
  });

  // /session fork <messageId>
  registry.register({
    name: "/session fork",
    description: "Fork session from a message",
    usage: "/session fork <messageId>",
    execute: async (args, ctx) => {
      if (!args) return { content: "Usage: /session fork <messageId>" };
      const active = ctx.sessionManager?.getActiveSession?.();
      if (!active) return { content: "No active session to fork." };
      try {
        const session = ctx.sessionManager?.forkSession?.(active.id, args);
        if (!session) return { content: "Failed to fork session." };
        return { content: `Forked to session: ${session.id} — ${session.name}` };
      } catch (e) {
        return { content: `Error: ${(e as Error).message}` };
      }
    },
  });

  // /session switch <id>
  registry.register({
    name: "/session switch",
    description: "Switch to a different session",
    usage: "/session switch <id>",
    execute: async (args, ctx) => {
      if (!args) return { content: "Usage: /session switch <id>" };
      try {
        const session = ctx.sessionManager?.switchSession?.(args);
        if (!session) return { content: `Session not found: ${args}` };
        return { content: `Switched to session: ${session.id} — ${session.name}` };
      } catch (e) {
        return { content: `Error: ${(e as Error).message}` };
      }
    },
  });

  // /model — Show current model
  registry.register({
    name: "/model",
    description: "Show current model",
    usage: "/model",
    execute: async (_args, ctx) => {
      const router = ctx.modelRouter;
      if (!router) return { content: "No model router configured." };
      return { content: `Current model: ${router.getActiveModel?.() ?? "unknown"}` };
    },
  });

  // /model list
  registry.register({
    name: "/model list",
    description: "List available models",
    usage: "/model list",
    execute: async (_args, ctx) => {
      const router = ctx.modelRouter;
      if (!router) return { content: "No model router configured." };
      const models = router.listModels?.() ?? [];
      if (models.length === 0) return { content: "No models available." };
      const lines = models.map((m: any) => `  ${m.id} — ${m.provider} (${m.maxTokens} tokens)`);
      return { content: `Available models:\n${lines.join("\n")}` };
    },
  });

  // /tools — List available tools
  registry.register({
    name: "/tools",
    description: "List available tools",
    usage: "/tools",
    execute: async (_args, ctx) => {
      const toolReg = ctx.toolRegistry;
      if (!toolReg) return { content: "No tool registry configured." };
      const tools = toolReg.list?.() ?? [];
      if (tools.length === 0) return { content: "No tools registered." };
      const lines = tools.map((t: any) =>
        `  ${t.definition.name} — ${t.definition.description?.slice(0, 60) ?? ""}`,
      );
      return { content: `Available tools (${tools.length}):\n${lines.join("\n")}` };
    },
  });

  // /learning status
  registry.register({
    name: "/learning status",
    description: "Show learning and memory status",
    usage: "/learning status",
    execute: async (_args, ctx) => {
      if (!ctx.memory) return { content: "No memory configured." };
      return { content: "Memory system active. Skills and memory are the learning mechanism." };
    },
  });

  registry.register({
    name: "/goal",
    description: "Work in a self-continuing loop until the goal is met (this session)",
    usage: "/goal <text | status | show | pause | resume | clear | done | criteria add <item>>",
    execute: async (args, ctx) => {
      const loop = ctx.goalLoop ?? (ctx.agent?.getGoalLoop?.() as GoalLoopManager | undefined);
      if (!loop) return { content: "No goal loop configured." };
      const input = String(args ?? "").trim();
      const lower = input.toLowerCase();
      try {
        if (!input || lower === "status") {
          const s = loop.getStatus() as import("./goal-loop").GoalState | null;
          if (!s || s.status === "cleared") {
            return { content: "No active goal. Set one with /goal <description> — the agent will loop on it until done." };
          }
          const remaining = s.checklist.filter((c) => !s.completedItems.includes(c));
          return { content:
            `Goal [${s.status}] (${s.turnsUsed}/${s.maxTurns} turns): ${s.goal}` +
            (s.checklist.length ? `\nRemaining:\n${remaining.map((r) => `  - ${r}`).join("\n") || "  (none — wrap up)"}` : ""),
          };
        }
        if (lower === "show") {
          const s = loop.getStatus();
          if (!s) return { content: "No active goal." };
          return { content: JSON.stringify(s, null, 2) };
        }
        if (lower === "pause") {
          const s = loop.pause();
          return { content: s ? `⏸ Goal paused: ${s.goal}` : "No active goal to pause." };
        }
        if (lower === "resume") {
          const s = loop.resume();
          return { content: s ? `▶ Goal resumed: ${s.goal} — the loop continues on your next message.` : "No paused goal." };
        }
        if (lower === "clear" || lower === "stop") {
          const had = loop.clear();
          return { content: had ? "Goal cleared." : "No active goal." };
        }
        if (lower === "done") {
          loop.markDone();
          return { content: "✓ Goal marked done." };
        }
        if (lower.startsWith("criteria add ")) {
          loop.addChecklistItem(input.slice("criteria add ".length));
          return { content: `Criterion added. Total: ${loop.getStatus()!.checklist.length}` };
        }
        // Bare text (or "set <text>") starts the loop.
        const text = lower.startsWith("set ") ? input.slice(4).trim() : input;
        const parts = text.split(/\s+--\s+/);
        const checklist = parts.length > 1 ? parts.slice(1).join(" ").split(";").map((s) => s.trim()).filter(Boolean) : [];
        const state = loop.set(parts[0]!, checklist);
        const how = checklist.length
          ? `The agent will loop on it, checking off: ${checklist.join(", ")}. It re-prompts itself after each turn until all criteria are met or ${state.maxTurns} turns elapse.`
          : `The agent will keep working toward it across turns until it reports completion or ${state.maxTurns} turns elapse.`;
        return { content: `⊙ Goal set: ${state.goal}\n${how}\nManage with /goal status|pause|resume|clear.` };
      } catch (error) {
        return { content: `Goal error: ${(error as Error).message}` };
      }
    },
  });

  registry.register({
    name: "/mission",
    description: "Standing objective referenced by scheduled jobs (MISSION.md) — experimental, not a loop like /goal",
    usage: "/mission <show|set <text>|criteria add <item>|status <ACTIVE|PAUSED|COMPLETED>|init>",
    execute: async (args, ctx) => {
      const workspacePath: string | undefined =
        ctx.agent?.getWorkspacePath?.() ?? ctx.agent?.workspacePath ?? process.env["DYNA_WORKSPACE"];
      if (!workspacePath) return { content: "No workspace available for MISSION.md." };
      const missionPath = join(workspacePath, "MISSION.md");
      const fs = await import("fs");
      const input = String(args ?? "").trim();
      const lower = input.toLowerCase();

      const read = (): string | null =>
        fs.existsSync(missionPath) ? fs.readFileSync(missionPath, "utf-8") : null;
      const write = (content: string): void => fs.writeFileSync(missionPath, content, "utf-8");

      try {
        if (lower === "init" || (!input && !read())) {
          if (read()) return { content: "MISSION.md already exists. Use /mission show." };
          // Copy the template from the workspace init module by generating a temp workspace
          const os = await import("os");
          const tmp = fs.mkdtempSync(join(os.tmpdir(), "mission-init-"));
          const wi = await import("../../workspace-init");
          await wi.initWorkspace(tmp);
          const template = fs.readFileSync(join(tmp, ".dynatrader", "MISSION.md"), "utf-8");
          fs.rmSync(tmp, { recursive: true, force: true });
          write(template);
          return { content: `MISSION.md created at ${missionPath}. Edit it directly or use /mission set.` };
        }

        let content = read();
        if (content === null) {
          return { content: "No MISSION.md. Run /mission init first." };
        }

        if (lower === "show" || !input) {
          return { content };
        }

        if (lower.startsWith("set ")) {
          const objective = input.slice(4).trim();
          content = content.replace(/(## Objective\n)[^]*?(\n## )/, `$1${objective}$2`);
          write(content);
          return { content: `Mission objective updated:\n${objective}` };
        }

        if (lower.startsWith("criteria add ")) {
          const item = input.slice("criteria add ".length).trim();
          content = content.replace(/(## Success Criteria\n)/, `$1- ${item}\n`);
          write(content);
          return { content: `Criterion added: ${item}` };
        }

        if (lower.startsWith("status ")) {
          const status = input.slice(7).trim().toUpperCase();
          if (!["ACTIVE", "PAUSED", "COMPLETED"].includes(status)) {
            return { content: "Status must be ACTIVE, PAUSED, or COMPLETED." };
          }
          content = content.replace(/## Status\n\w+/, `## Status\n${status}`);
          write(content);
          return { content: `Mission status set to ${status}.` };
        }

        return { content: "Usage: /mission <show|init|set <text>|criteria add <item>|status <ACTIVE|PAUSED|COMPLETED>>" };
      } catch (error) {
        return { content: `Mission error: ${(error as Error).message}` };
      }
    },
  });

  registry.register({
    name: "/heartbeat",
    description: "Run the workspace heartbeat health check (HEARTBEAT.md)",
    usage: "/heartbeat",
    execute: async (_args, ctx) => {
      const workspacePath: string | undefined =
        ctx.agent?.getWorkspacePath?.() ?? ctx.agent?.workspacePath ?? process.env["DYNA_WORKSPACE"];
      if (!workspacePath) return { content: "No workspace available for heartbeat." };
      const fs = await import("fs");
      if (!fs.existsSync(join(workspacePath, "HEARTBEAT.md"))) {
        return { content: "No HEARTBEAT.md in workspace. Create one with task checkboxes for the heartbeat to track." };
      }
      const { Heartbeat } = await import("../cron/heartbeat");
      const result = new Heartbeat({ workspacePath }).check();
      return {
        content:
          result.status === "ok"
            ? "HEARTBEAT_OK — all tasks complete."
            : `Heartbeat [${result.status}]: ${result.message}\nTasks: ${result.completedCount}/${result.tasksCount} complete`,
      };
    },
  });

  registry.register({
    name: "/skill",
    description: "Create, list, show, or find reusable skills",
    usage: "/skill <create|list|show|find> [args]",
    execute: async (args, ctx) => {
      const factory = ctx.skillFactory ?? ctx.agent?.getSkillFactory?.() ?? ctx.agent?.skillFactory;
      if (!factory) return { content: "No skill factory configured." };
      const [action = "list", ...rest] = splitArgs(args);
      const value = rest.join(" ").trim();
      try {
        if (action === "list") {
          const skills = await factory.listSkills();
          return { content: skills.length ? `Skills:\n${skills.map((s: any) => `  ${s.name} — ${s.description}`).join("\n")}` : "No reusable skills found." };
        }
        if (action === "show") {
          if (!value) return { content: "Usage: /skill show <name>" };
          const skill = await factory.getSkill(value);
          return { content: skill ? `${skill.name}\n${skill.description}\n\n${skill.instructions.map((s: string, i: number) => `${i + 1}. ${s}`).join("\n")}` : `Skill not found: ${value}` };
        }
        if (action === "find") {
          if (!value) return { content: "Usage: /skill find <query>" };
          const skills = await factory.findSkills(value);
          return { content: skills.length ? `Matching skills:\n${skills.map((s: any) => `  ${s.name}`).join("\n")}` : `No skills match: ${value}` };
        }
        if (action === "create") {
          if (!value) return { content: "Usage: /skill create <title> -- <outcome>" };
          const [title, outcome] = value.split(/\s+--\s+/, 2);
          if (!outcome) return { content: "Usage: /skill create <title> -- <outcome>" };
          const skill = await factory.createSkillFromTask({ title, outcome, successful: true });
          return { content: skill ? `Skill created: ${skill.name}` : "Task did not produce a reusable skill." };
        }
        return { content: "Usage: /skill <create|list|show|find> [args]" };
      } catch (error) {
        return { content: `Skill error: ${(error as Error).message}` };
      }
    },
  });

  registry.register({
    name: "/skill-import",
    description: "Import a community skill from a git URL, local path, or raw content",
    usage: "/skill-import <url|path>  OR  /skill-import --name <name> -- <raw SKILL.md content>",
    execute: async (args, ctx) => {
      const workspacePath: string | undefined =
        ctx.agent?.getWorkspacePath?.() ?? ctx.agent?.workspacePath ?? process.env['DYNA_WORKSPACE'];
      if (!workspacePath) return { content: "No workspace path available." };
      const { SkillImporter } = await import('../../agent/skills/skill-importer');
      const importer = new SkillImporter(workspacePath);
      const raw = args.trim();

      try {
        if (raw.startsWith('--name ')) {
          const nameEnd = raw.indexOf(' -- ');
          if (nameEnd === -1) return { content: "Usage: /skill-import --name <name> -- <content>" };
          const name = raw.slice(7, nameEnd).trim();
          const content = raw.slice(nameEnd + 4).trim();
          if (!name || !content) return { content: "Usage: /skill-import --name <name> -- <content>" };
          const result = await importer.importFromContent(name, content);
          return { content: `Imported skill: ${result.name} (tags: ${result.tags.join(', ')})` };
        }
        if (raw.startsWith('http://') || raw.startsWith('https://') || raw.startsWith('git@')) {
          const result = await importer.importFromGitUrl(raw);
          return { content: `Imported skill: ${result.name} from ${raw}` };
        }
        if (raw) {
          const result = await importer.importFromPath(raw);
          return { content: `Imported skill: ${result.name} from ${raw}` };
        }
        return { content: "Usage: /skill-import <url|path>  OR  /skill-import --name <name> -- <content>" };
      } catch (error) {
        return { content: `Import failed: ${(error as Error).message}` };
      }
    },
  });

  registry.register({
    name: "/dream",
    description: "Run a cross-session reflection cycle",
    usage: "/dream [status|run]",
    execute: async (args, ctx) => {
      const engine = ctx.dreamEngine ?? ctx.agent?.getDreamEngine?.() ?? ctx.agent?.dreamEngine;
      if (!engine) return { content: "No dream engine configured." };
      try {
        if (args.trim() === "status") {
          const report = engine.getLastDreamReport?.();
          return { content: report ? `Last dream: ${report.summary ?? report.id}` : "No dream cycle has run yet." };
        }
        const report = await engine.runDreamCycle();
        return { content: `Dream cycle complete: ${report.summary ?? report.id}`, metadata: { report } };
      } catch (error) {
        return { content: `Dream error: ${(error as Error).message}` };
      }
    },
  });

  // /debug
  registry.register({
    name: "/debug",
    description: "Show debug information",
    usage: "/debug",
    execute: async (_args, ctx) => {
      const history = ctx.getConversationHistory?.() ?? [];
      return {
        content: [
          `Debug Info:`,
          `  Conversation messages: ${history.length}`,
          `  Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
          `  Uptime: ${process.uptime().toFixed(0)}s`,
        ].join("\n"),
      };
    },
  });

  // /export — Export session to markdown
  registry.register({
    name: "/export",
    description: "Export session to markdown",
    usage: "/export",
    execute: async (_args, ctx) => {
      const history = ctx.getConversationHistory?.() ?? [];
      const lines = history.map((m: any) => {
        const role =
          m.role === "user" ? "**User**" : m.role === "assistant" ? "**Assistant**" : `*${m.role}*`;
        return `${role}:\n${m.content ?? "(no content)"}\n`;
      });
      return {
        content: `# Session Export\n\n${lines.join("\n")}`,
        metadata: { format: "markdown", messageCount: history.length },
      };
    },
  });

  // /trace — Show last tool call trace
  registry.register({
    name: "/trace",
    description: "Show last tool call trace",
    usage: "/trace",
    execute: async (_args, ctx) => {
      const history = ctx.getConversationHistory?.() ?? [];
      const toolMessages = history.filter((m: any) => m.role === "tool");
      if (toolMessages.length === 0) return { content: "No tool calls in history." };
      const last5 = toolMessages.slice(-5);
      const lines = last5.map((m: any) => {
        try {
          const parsed = JSON.parse(m.content);
          return `  Tool ${m.tool_call_id}: ${parsed.success ? "OK" : "FAIL"} (${parsed.durationMs ?? "?"}ms)`;
        } catch {
          return `  Tool ${m.tool_call_id}: (unparseable)`;
        }
      });
      return { content: `Last tool calls:\n${lines.join("\n")}` };
    },
  });

  // /memory search <query>
  registry.register({
    name: "/memory search",
    description: "Search memory store",
    usage: "/memory search <query>",
    execute: async (args, ctx) => {
      if (!args) return { content: "Usage: /memory search <query>" };
      const memory = ctx.memory;
      if (!memory) return { content: "No memory store configured." };
      try {
        const results = await memory.search({ scope: "agent_memory", text: args, topK: 5 });
        if (results.length === 0) return { content: `No memories found for: ${args}` };
        const lines = results.map((r: any) => {
          const preview = JSON.stringify(r.payload).slice(0, 120);
          return `  [${r.score.toFixed(2)}] ${r.kind}: ${preview}...`;
        });
        return { content: `Memories for "${args}":\n${lines.join("\n")}` };
      } catch (e) {
        return { content: `Memory search error: ${(e as Error).message}` };
      }
    },
  });

  // /memory stats
  registry.register({
    name: "/memory stats",
    description: "Show memory store statistics",
    usage: "/memory stats",
    execute: async (_args, ctx) => {
      const memory = ctx.memory;
      if (!memory) return { content: "No memory store configured." };
      try {
        const summary = await memory.summarize?.({ scope: "agent_memory" });
        return { content: `Memory summary:\n${summary ?? "(no summary available)"}` };
      } catch (e) {
        return { content: `Memory stats error: ${(e as Error).message}` };
      }
    },
  });

  // /status — Show agent status
  registry.register({
    name: "/status",
    description: "Show agent status including cron jobs and loop state",
    usage: "/status",
    execute: async (_args, ctx) => {
      const agent = ctx.agent;
      if (!agent) return { content: "No agent configured." };
      const state = agent.getState?.() ?? "unknown";
      const session = ctx.sessionManager?.getActiveSession?.();
      const history = ctx.getConversationHistory?.() ?? [];
      let cronJobs: any[] = [];
      let cronError: string | undefined;
      if (ctx.cronEngine?.listJobs) {
        try {
          cronJobs = await ctx.cronEngine.listJobs();
        } catch (error) {
          cronError = error instanceof Error ? error.message : String(error);
        }
      }
      const activeCrons = cronJobs.filter((j: any) => j.enabled && j.state !== "paused");
      const lines = [
        `  State: ${state}`,
        `  Active session: ${session ? `${session.id} — ${session.name}` : "none"}`,
        `  Conversation messages: ${history.length}`,
        `  Cron Jobs: ${cronError ? `unavailable (${cronError})` : `${activeCrons.length} active of ${cronJobs.length} total`}`,
        `  Memory: ${(process.memoryUsage().heapUsed / 1024 / 1024).toFixed(1)}MB`,
      ];
      return { content: `Agent Status:\n${lines.join("\n")}` };
    },
  });

  // /history — Show conversation history
  registry.register({
    name: "/history",
    description: "Show recent conversation history",
    usage: "/history [count]",
    execute: async (args, ctx) => {
      const count = parseInt(args, 10) || 10;
      const history = ctx.getConversationHistory?.() ?? [];
      const recent = history.slice(-count);
      if (recent.length === 0) return { content: "No conversation history." };
      const lines = recent.map((m: any, i: number) => {
        const role = m.role === "user" ? "U" : m.role === "assistant" ? "A" : m.role === "tool" ? "T" : "S";
        const content = (m.content ?? "(no content)").slice(0, 80);
        return `  [${role}] ${content}`;
      });
      return { content: `Last ${recent.length} messages:\n${lines.join("\n")}` };
    },
  });

  // /compact — Force conversation compaction
  registry.register({
    name: "/compact",
    description: "Force conversation compaction",
    usage: "/compact",
    execute: async (_args, ctx) => {
      const agent = ctx.agent;
      if (!agent) return { content: "No agent configured." };
      const conversation = agent.conversation;
      if (!conversation) return { content: "No conversation manager available." };
      try {
        const shouldCompact = conversation.shouldCompact?.();
        if (!shouldCompact) return { content: "Compaction not needed yet." };
        const summary = conversation.compact?.();
        return { content: `Compacted: ${summary ?? "done"}` };
      } catch (e) {
        return { content: `Compaction error: ${(e as Error).message}` };
      }
    },
  });

  // /session delete <id>
  registry.register({
    name: "/session delete",
    description: "Delete a session",
    usage: "/session delete <id>",
    execute: async (args, ctx) => {
      if (!args) return { content: "Usage: /session delete <id>" };
      const deleted = ctx.sessionManager?.deleteSession?.(args);
      if (!deleted) return { content: `Session not found: ${args}` };
      return { content: `Deleted session: ${args}` };
    },
  });

  // /version
  registry.register({
    name: "/version",
    description: "Show DynaTrader version",
    usage: "/version",
    execute: async (_args, _ctx) => {
      return {
        content: "DynaTrader v2.0.0 (Agent Core)",
        metadata: { version: "2.0.0", module: "agent-core" },
      };
    },
  });

  // /me — Agent profile
  registry.register({
    name: "/me",
    description: "Show my agent profile and current state",
    usage: "/me",
    execute: async (_args, ctx) => {
      try {
        const lines: string[] = [];
        lines.push("=== Agent Profile ===");
        if (ctx.agent) {
          const agentId = ctx.agent.agentId || ctx.agent.id || "unknown";
          const mode = ctx.agent.mode || ctx.agent.executionMode || "unknown";
          const model = ctx.modelRouter?.getActiveModel?.()?.name || "unknown";
          lines.push(`  ID: ${agentId}`);
          lines.push(`  Mode: ${mode}`);
          lines.push(`  Model: ${model}`);
        }
        if (ctx.sessionManager) {
          const sessions = ctx.sessionManager.listSessions?.() || [];
          const active = ctx.sessionManager.activeSession?.() || null;
          lines.push(`  Sessions: ${sessions.length} total${active ? ` (active: ${active.id?.slice(0, 8)}...)` : ""}`);
        }
        if (ctx.goalManager) {
          const goals = ctx.goalManager.listGoals?.() || [];
          lines.push(`  Goals: ${goals.length} total`);
          const activeGoals = goals.filter((g: any) => g.status === "active");
          lines.push(`  Active Goals: ${activeGoals.length}`);
        }
        const memory = ctx.memory;
        if (memory) {
          const stats = memory.getStats?.() || {};
          lines.push(`  Memory: ${stats.totalEntries || stats.size || 0} entries`);
        }
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });

  // /p — Portfolio summary
  registry.register({
    name: "/p",
    description: "Show current portfolio summary",
    usage: "/p",
    aliases: ["/portfolio"],
    execute: async (_args, ctx) => {
      try {
        const lines = ["=== Portfolio Summary ==="];
        if (ctx.agent?.paperEngine) {
          try {
            const portfolio = ctx.agent.paperEngine.getPortfolio?.();
            if (portfolio) {
              lines.push(`  Total Value: $${portfolio.totalValue?.toFixed(2) ?? "N/A"}`);
              lines.push(`  Cash: $${portfolio.cash?.toFixed(2) ?? "N/A"}`);
              lines.push(`  Invested: $${portfolio.invested?.toFixed(2) ?? "N/A"}`);
              lines.push(`  Unrealized PnL: $${portfolio.unrealizedPnl?.toFixed(2) ?? "N/A"}`);
              lines.push(`  Realized PnL: $${portfolio.realizedPnl?.toFixed(2) ?? "N/A"}`);
              lines.push(`  Open Positions: ${portfolio.positions?.length ?? 0}`);
              return { content: lines.join("\n") };
            }
          } catch { /* preserve unavailable-data fallback */ }
        }
        lines.push("  Portfolio data not available.");
        lines.push("  (PaperEngine not wired into CommandContext yet)");
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });

  // /positions — Open positions list
  registry.register({
    name: "/positions",
    description: "List open positions",
    usage: "/positions [--closed]",
    execute: async (args, ctx) => {
      try {
        const showClosed = args.includes("--closed");
        const lines: string[] = [];
        lines.push(`=== ${showClosed ? "All" : "Open"} Positions ===`);

        if (ctx.agent?.paperEngine) {
          try {
            const positions = showClosed
              ? ctx.agent.paperEngine.getAllPositions?.()
              : ctx.agent.paperEngine.getPositions?.();

            if (positions && positions.length > 0) {
              for (const pos of positions) {
                const pnl = pos.unrealizedPnl ?? pos.pnl ?? 0;
                const sign = pnl >= 0 ? "+" : "";
                lines.push(`  ${pos.symbol} ${pos.side.toUpperCase()} | Qty: ${pos.quantity} | Entry: $${pos.avgEntryPrice ?? pos.entryPrice} | PnL: ${sign}$${pnl.toFixed(2)}`);
              }
              return { content: lines.join("\n") };
            }
            lines.push("  No positions found.");
            return { content: lines.join("\n") };
          } catch {
            /* fall through */
          }
        }

        lines.push("  Position data not available.");
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });

  // /pnl — Profit/Loss summary
  registry.register({
    name: "/pnl",
    description: "Show profit/loss summary",
    usage: "/pnl [--all]",
    execute: async (args, ctx) => {
      try {
        const lines: string[] = [];
        lines.push("=== PnL Summary ===");

        if (ctx.agent?.paperEngine) {
          try {
            const portfolio = ctx.agent.paperEngine.getPortfolio?.();
            if (portfolio) {
              const totalPnl = (portfolio.unrealizedPnl ?? 0) + (portfolio.realizedPnl ?? 0);
              lines.push(`  Unrealized PnL: $${portfolio.unrealizedPnl?.toFixed(2) ?? "0.00"}`);
              lines.push(`  Realized PnL:   $${portfolio.realizedPnl?.toFixed(2) ?? "0.00"}`);
              lines.push(`  Total PnL:      $${totalPnl.toFixed(2)}`);
              lines.push("");

              const positions = ctx.agent.paperEngine.getPositions?.();
              if (positions && positions.length > 0) {
                let winning = 0;
                let losing = 0;
                for (const pos of positions) {
                  const pnl = pos.unrealizedPnl ?? pos.pnl ?? 0;
                  if (pnl > 0) winning++;
                  else if (pnl < 0) losing++;
                }
                lines.push(`  Winning: ${winning} | Losing: ${losing} | Total: ${positions.length}`);
              }
              return { content: lines.join("\n") };
            }
          } catch {
            /* fall through */
          }
        }

        lines.push("  PnL data not available.");
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });

  // /loop — Persistent recurring prompt job
  registry.register({
    name: "/loop",
    description: "Run a recurring prompt through CronEngine. /loop stop ends loops created here.",
    usage: "/loop <interval> <prompt> | /loop stop | /loop status",
    execute: async (args, ctx) => {
      const text = args.trim();
      const lower = text.toLowerCase();
      if (!text) return { content: "Usage: /loop <interval> <prompt>\nExample: /loop 5m /positions" };
      const engine = ctx.cronEngine;
      if (!engine) return { content: "No cron engine configured; cannot create or manage loops." };
      try {
        const loopJobs = (await engine.listJobs()).filter((job: any) => job.tags?.includes("slash-loop"));
        if (lower === "stop") {
          for (const job of loopJobs) await engine.deleteJob(job.id);
          return { content: loopJobs.length ? `⏹ Loop stopped. Removed ${loopJobs.length} loop job(s).` : "Loop not active; no loop jobs to stop." };
        }
        if (lower === "status") {
          return loopJobs.length
            ? { content: `Loop active (${loopJobs.length} job(s)):\n${loopJobs.map((job: any) => `${job.id}: ${job.schedule?.display ?? "unknown schedule"} — ${job.enabled ? job.state : "disabled"} — ${job.prompt}`).join("\n")}` }
            : { content: "Loop: not active. Use /loop <interval> <prompt> to start." };
        }
        const match = text.match(/^(\S+)\s+([\s\S]+)$/);
        if (!match) return { content: "Usage: /loop <interval> <prompt>\nExample: /loop 5m /positions" };
        const schedule = `every ${match[1]}`;
        const prompt = match[2]!.trim();
        if (!prompt) return { content: "Usage: /loop <interval> <prompt>\nExample: /loop 5m /positions" };
        const job = await engine.createJob({ name: "slash-loop", prompt, schedule, tags: ["slash-loop"], enabled: true, wakeAgent: false, repeatCount: null });
        const deletionErrors: unknown[] = [];
        for (const oldJob of loopJobs) {
          try {
            await engine.deleteJob(oldJob.id);
          } catch (error) {
            deletionErrors.push(error);
          }
        }
        if (deletionErrors.length > 0) {
          try {
            await engine.deleteJob(job.id);
          } catch (rollbackError) {
            const message = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            return { content: `Loop error: Could not remove existing loop jobs, and rollback of replacement ${job.id} failed: ${message}` };
          }
          const error = deletionErrors[0];
          const message = error instanceof Error ? error.message : String(error);
          return { content: `Loop error: ${message}. Replacement job rolled back.` };
        }
        return { content: `↻ Loop set: every ${match[1]} → ${prompt} (job ${job.id}).` };
      } catch (error) {
        return { content: `Loop error: ${(error as Error).message}` };
      }
    },
  });

  // /cron — Cron job management
  registry.register({
    name: "/cron",
    description: "Manage scheduled cron jobs (list, show, add, run, pause, resume, remove)",
    usage: "/cron <list|show|add|run|pause|resume|remove> [args]",
    execute: async (args, ctx) => {
      const engine = ctx.cronEngine;
      if (!engine) return { content: "No cron engine configured." };
      const text = args.trim();
      const subMatch = text.match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const sub = subMatch?.[1]?.toLowerCase();
      const rest = subMatch?.[2] ?? "";
      const tokens = rest.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g)?.map((token) => token.replace(/^(?:"([\s\S]*)"|'([\s\S]*)')$/, (_m, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted)) ?? [];
      try {
        switch (sub) {
          case "list": {
            const jobs = await engine.listJobs();
            if (jobs.length === 0) return { content: "No cron jobs scheduled." };
            return { content: `Cron Jobs (${jobs.length}):\n${jobs.map((j: any) => `  ${j.name.padEnd(20)} ${j.schedule?.display?.padEnd(20)} ${j.enabled ? "enabled" : "disabled"}  ${j.state}`).join("\n")}` };
          }
          case "show": {
            const jobId = tokens[0];
            if (!jobId) return { content: "Usage: /cron show <jobId>" };
            const job = await engine.getJob(jobId);
            if (!job) return { content: `Cron job not found: ${jobId}` };
            return { content: JSON.stringify({ id: job.id, name: job.name, schedule: job.schedule, enabled: job.enabled, state: job.state, lastStatus: job.lastStatus, prompt: job.prompt }, null, 2) };
          }
          case "add": {
            const rawAddArgs = rest.trim();
            const addTokens = rawAddArgs.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g) ?? [];
            let schedule: string | undefined;
            let prompt: string;
            if (addTokens[0]?.startsWith('"') || addTokens[0]?.startsWith("'")) {
              schedule = tokens[0];
              prompt = tokens.slice(1).join(" ");
            } else if (addTokens.length >= 6) {
              schedule = addTokens.slice(0, 5).join(" ");
              prompt = tokens.slice(5).join(" ");
            } else {
              schedule = tokens[0];
              prompt = tokens.slice(1).join(" ");
            }
            if (!schedule || !prompt) return { content: "Usage: /cron add <schedule> <prompt>\\nExample: /cron add \\\"0 9 * * *\\\" \\\"Check positions\\\"" };
            const job = await engine.createJob({ name: "Cron Job", prompt, schedule, enabled: true });
            return { content: `Cron job created: ${job.id} — ${job.name} (${job.schedule.display})` };
          }
          case "run": {
            const jobId = tokens[0];
            if (!jobId) return { content: "Usage: /cron run <jobId>" };
            const execution = await engine.triggerJob(jobId);
            return { content: `Cron job executed: ${execution.success ? "success" : "failed"} (${execution.duration}ms)` };
          }
          case "pause": {
            const jobId = tokens[0];
            if (!jobId) return { content: "Usage: /cron pause <jobId>" };
            const job = await engine.pauseJob(jobId);
            return { content: `Cron job paused: ${job.name}` };
          }
          case "resume": {
            const jobId = tokens[0];
            if (!jobId) return { content: "Usage: /cron resume <jobId>" };
            const job = await engine.resumeJob(jobId);
            return { content: `Cron job resumed: ${job.name}` };
          }
          case "remove": {
            const jobId = tokens[0];
            if (!jobId) return { content: "Usage: /cron remove <jobId>" };
            await engine.deleteJob(jobId);
            return { content: `Cron job removed: ${jobId}` };
          }
          default:
            return { content: "Usage: /cron <list|show|add|run|pause|resume|remove> [args]\\n  list  — List all jobs\\n  show  — Job details\\n  add   — Create new job\\n  run   — Run immediately\\n  pause — Pause a job\\n  resume — Resume a job\\n  remove — Remove a job" };
        }
      } catch (error) {
        return { content: `Cron error: ${(error as Error).message}` };
      }
    },
  });

  // /alerts — Recent alerts
  registry.register({
    name: "/alerts",
    description: "Show recent alerts",
    usage: "/alerts [count]",
    execute: async (args, ctx) => {
      try {
        const count = parseInt(args.trim(), 10) || 5;
        const lines: string[] = [];
        lines.push(`=== Recent Alerts (last ${count}) ===`);

        lines.push("  No alerts configured. Memory system handles learnings.");
        return { content: lines.join("\n") };

        if (ctx.memory) {
          try {
            const recent = ctx.memory.search?.("alert", count) || [];
            if (recent.length > 0) {
              for (const item of recent) {
                lines.push(`  ${item.content?.slice(0, 200)}`);
              }
              return { content: lines.join("\n") };
            }
          } catch {
            /* fall through */
          }
        }

        lines.push("  No recent alerts.");
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });

  // /sim — Simulation
  registry.register({
    name: "/sim",
    description: "Run a simulation or show simulation status",
    usage: "/sim [start|stop|status]",
    execute: async (args, ctx) => {
      try {
        const sub = args.trim().toLowerCase();
        const lines: string[] = [];
        lines.push("=== Simulation ===");

        if (sub === "start" || sub === "stop") {
          if (ctx.dreamEngine) {
            try {
              if (sub === "start") {
                await ctx.dreamEngine.start?.();
                lines.push("  Simulation started.");
              } else {
                await ctx.dreamEngine.stop?.();
                lines.push("  Simulation stopped.");
              }
              return { content: lines.join("\n") };
            } catch {
              /* fall through */
            }
          }
          lines.push("  DreamEngine not available.");
          return { content: lines.join("\n") };
        }

        // Default: show status
        if (ctx.dreamEngine) {
          try {
            const status = ctx.dreamEngine.getStatus?.() || {};
            lines.push(`  Running: ${status.running ?? status.active ?? false}`);
            lines.push(`  Cycles: ${status.cycleCount ?? status.cycles ?? 0}`);
            lines.push(`  Last Run: ${status.lastRun ? new Date(status.lastRun).toISOString() : "never"}`);
            return { content: lines.join("\n") };
          } catch {
            /* fall through */
          }
        }

        lines.push("  DreamEngine not available. Use: /sim start, /sim stop, /sim status");
        return { content: lines.join("\n") };
      } catch (err) {
        return { content: `Error: ${(err as Error).message}` };
      }
    },
  });
}

function splitArgs(input: string): string[] {
  return input.trim().match(/"[^"]*"|'[^']*'|\S+/g)?.map((part) => part.replace(/^("|')|("|')$/g, "")) ?? [];
}
