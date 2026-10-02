import { describe, expect, it } from "vitest";
import { TELEGRAM_MENU_COMMANDS } from "./command-menu";

describe("Telegram command menu", () => {
  it("provides unique setup commands shared with daemon registration", () => {
    const names = TELEGRAM_MENU_COMMANDS.map(({ command }) => command);
    expect(names).toEqual(["start", "help", "approve", "reject", "status"]);
    expect(new Set(names).size).toBe(names.length);
    expect(TELEGRAM_MENU_COMMANDS.every(({ description }) => description.length > 0)).toBe(true);
  });
});
