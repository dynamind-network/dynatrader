import { describe, it, expect } from "vitest";
import { parseScheduleArg } from "./parse-schedule";

const NOW = new Date("2026-08-25T12:00:00").getTime();

describe("parseScheduleArg", () => {
  it("parses 'in 30m' as a one-shot", () => {
    const s = parseScheduleArg("in 30m", NOW);
    expect(s.kind).toBe("once");
    if (s.kind === "once") expect(s.runAt).toBe(NOW + 30 * 60_000);
  });

  it("parses 'in 2h' and 'in 1d'", () => {
    expect(parseScheduleArg("in 2h", NOW)).toEqual({ kind: "once", runAt: NOW + 7_200_000 });
    expect(parseScheduleArg("in 1d", NOW)).toEqual({ kind: "once", runAt: NOW + 86_400_000 });
  });

  it("parses 'at 14:30' as next occurrence", () => {
    const s = parseScheduleArg("at 14:30", NOW); // now is 12:00, so today 14:30
    expect(s.kind).toBe("once");
    if (s.kind === "once") {
      const d = new Date(s.runAt);
      expect(d.getHours()).toBe(14);
      expect(d.getMinutes()).toBe(30);
      expect(s.runAt).toBeGreaterThan(NOW);
    }
  });

  it("'at' time earlier today rolls to tomorrow", () => {
    const s = parseScheduleArg("at 09:00", NOW); // now is 12:00 → tomorrow 09:00
    expect(s.kind).toBe("once");
    if (s.kind === "once") expect(s.runAt).toBeGreaterThan(NOW + 12 * 3_600_000);
  });

  it("parses 'every 4h' as a forever interval", () => {
    const s = parseScheduleArg("every 4h", NOW);
    expect(s).toEqual({ kind: "interval", intervalMs: 14_400_000 });
  });

  it("parses bare 'every day'", () => {
    expect(parseScheduleArg("every day", NOW)).toEqual({ kind: "interval", intervalMs: 86_400_000 });
  });

  it("passes through a 5-field cron expression", () => {
    expect(parseScheduleArg("0 9 * * *", NOW)).toEqual({ kind: "cron", expression: "0 9 * * *" });
  });

  it("rejects sub-minute intervals", () => {
    expect(() => parseScheduleArg("every 30s", NOW)).toThrow(/at least 1 minute/);
  });

  it("rejects invalid times and garbage", () => {
    expect(() => parseScheduleArg("at 25:00", NOW)).toThrow();
    expect(() => parseScheduleArg("whenever", NOW)).toThrow(/Cannot parse schedule/);
    expect(() => parseScheduleArg("", NOW)).toThrow(/Empty schedule/);
  });

  it("is case-insensitive on units", () => {
    const s = parseScheduleArg("IN 10M", NOW);
    expect(s.kind).toBe("once");
  });
});
