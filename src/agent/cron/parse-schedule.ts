/**
 * Natural-language cron schedule parsing for agent-created jobs.
 *
 * Forms:
 *   "in 30m"            → once at now + 30 minutes
 *   "at 14:30"          → once at the next occurrence of 14:30 local time
 *   "every 4h"          → interval, forever
 *   "0 9 * * *"         → raw 5-field cron expression passthrough
 */

export type ParsedSchedule =
  | { kind: "once"; runAt: number }
  | { kind: "interval"; intervalMs: number }
  | { kind: "cron"; expression: string };

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseScheduleArg(input: string, now: number = Date.now()): ParsedSchedule {
  const text = (input ?? "").trim();
  if (!text) throw new Error("Empty schedule. Use 'in <N><s|m|h|d>', 'at HH:MM', 'every <N><unit>', or a 5-field cron expression.");

  // in <N><unit>
  const inMatch = text.match(/^in\s+(\d+)\s*([smhd])$/i);
  if (inMatch) {
    const ms = Number(inMatch[1]) * UNIT_MS[inMatch[2]!.toLowerCase()]!;
    return { kind: "once", runAt: now + ms };
  }

  // at HH:MM
  const atMatch = text.match(/^at\s+(\d{1,2}):(\d{2})$/i);
  if (atMatch) {
    const hours = Number(atMatch[1]);
    const minutes = Number(atMatch[2]);
    if (hours > 23 || minutes > 59) throw new Error(`Invalid time '${atMatch[0]}': use HH:MM (24h).`);
    const target = new Date(now);
    target.setHours(hours, minutes, 0, 0);
    let runAt = target.getTime();
    if (runAt <= now) runAt += 24 * 3_600_000; // next occurrence
    return { kind: "once", runAt };
  }

  // every <N><unit>
  const everyMatch = text.match(/^every\s+(\d+)\s*([smhd])$/i);
  if (everyMatch) {
    const ms = Number(everyMatch[1]) * UNIT_MS[everyMatch[2]!.toLowerCase()]!;
    if (ms < 60_000) throw new Error("Interval must be at least 1 minute.");
    return { kind: "interval", intervalMs: ms };
  }
  // bare "every hour|day|week"
  const everyBare = text.match(/^every\s+(minute|hour|day|week)$/i);
  if (everyBare) {
    const unit = everyBare[1]!.toLowerCase();
    const ms = unit === "minute" ? 60_000 : unit === "hour" ? 3_600_000 : unit === "day" ? 86_400_000 : 7 * 86_400_000;
    return { kind: "interval", intervalMs: ms };
  }

  // raw 5-field cron
  if (/^\S+\s+\S+\s+\S+\s+\S+\s+\S+$/.test(text)) {
    return { kind: "cron", expression: text };
  }

  throw new Error(
    `Cannot parse schedule '${input}'. Use: 'in <N><s|m|h|d>' (one-shot), 'at HH:MM' (one-shot), 'every <N><unit>' (forever interval), or a 5-field cron expression.`,
  );
}
