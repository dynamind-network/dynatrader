import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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

  it("loads session metadata and counts first, then hydrates only the selected transcript", () => {
    dir = mkdtempSync(join(tmpdir(), "dynatrader-session-lazy-load-"));
    db = new StateDb(dir);
    const manager = new SessionManager(db);
    const first = manager.createSession("first");
    manager.addMessageToSession(first.id, { role: "user", content: "first prompt", timestamp: new Date(1) });
    const second = manager.createSession("second");
    manager.addMessageToSession(second.id, { role: "assistant", content: "second answer", timestamp: new Date(2) });

    const listAllMessages = vi.spyOn(db, "listAllConversationMessages");
    const getMessages = vi.spyOn(db, "getConversationMessages");
    const reloaded = new SessionManager(db);

    expect(listAllMessages).not.toHaveBeenCalled();
    expect(getMessages).not.toHaveBeenCalled();
    expect(reloaded.listSessions()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id, messageCount: 1 }),
      expect.objectContaining({ id: second.id, messageCount: 1 }),
    ]));
    expect(getMessages).not.toHaveBeenCalled();

    expect(reloaded.getSession(first.id)?.messages.map((message) => message.content)).toEqual(["first prompt"]);
    expect(getMessages).toHaveBeenCalledTimes(1);
    expect(getMessages).toHaveBeenCalledWith(first.id);
  });
});
