import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StateDb } from "../../state-db/state-db";
import { SessionManager } from "./session-manager";

describe("SessionManager transcript replacement", () => {
  let db: StateDb | undefined;
  let dir: string | undefined;

  afterEach(() => {
    db?.close();
    db = undefined;
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it("replaces a non-active session transcript and persisted rows without switching active session", () => {
    dir = mkdtempSync(join(tmpdir(), "dynatrader-session-manager-"));
    db = new StateDb(dir);
    const manager = new SessionManager(db);
    const target = manager.createSession("target");
    manager.addMessageToSession(target.id, { role: "assistant", content: "obsolete", timestamp: new Date(1) });
    const active = manager.createSession("active");
    manager.addMessageToSession(active.id, { role: "user", content: "active transcript", timestamp: new Date(2) });

    manager.replaceSessionMessages(target.id, [
      { role: "system", content: "[Conversation Summary] retained", timestamp: new Date(3) },
      { role: "user", content: "latest request", timestamp: new Date(4) },
    ]);

    expect(manager.getActiveSession()?.id).toBe(active.id);
    expect(manager.getSession(target.id)?.messages.map((message) => message.content)).toEqual([
      "[Conversation Summary] retained",
      "latest request",
    ]);
    expect(db.getConversationMessages(target.id).map((row) => JSON.parse(row.parts)[0].content)).toEqual([
      "[Conversation Summary] retained",
      "latest request",
    ]);

    const reloaded = new SessionManager(db);
    expect(reloaded.getSession(target.id)?.messages.map((message) => message.content)).toEqual([
      "[Conversation Summary] retained",
      "latest request",
    ]);
  });
});
