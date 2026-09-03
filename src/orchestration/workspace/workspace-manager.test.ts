import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { WorkspaceManager } from "./workspace-manager";

describe("WorkspaceManager", () => {
  let testDir: string;
  let manager: WorkspaceManager;

  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), "workspace-test-"));
    mkdirSync(join(testDir, "workspaces"), { recursive: true });
    manager = new WorkspaceManager(testDir);
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it("should create a new workspace", async () => {
    const ws = await manager.createWorkspace({
      name: "Test Workspace",
      description: "A test workspace",
      symbol: "BTC/USD",
    });

    expect(ws.id).toBeDefined();
    expect(ws.name).toBe("Test Workspace");
    expect(ws.symbol).toBe("BTC/USD");
    expect(ws.status).toBe("active");
    expect(ws.createdAt).toBeGreaterThan(0);
    expect(ws.updatedAt).toBeGreaterThan(0);
    expect(ws.tags).toEqual([]);
    expect(ws.thesis).toBe("");
    expect(ws.riskParameters).toEqual({
      maxPositionSize: 1.0,
      maxDrawdown: 0.25,
      stopLoss: 0.05,
    });
  });

  it("should get a workspace by ID", async () => {
    const created = await manager.createWorkspace({
      name: "Get Test",
      description: "Testing get by ID",
      symbol: "ETH/USD",
      thesis: "Bullish on ETH",
      tags: ["crypto", "eth"],
    });

    const retrieved = await manager.getWorkspace(created.id);
    expect(retrieved).not.toBeNull();
    expect(retrieved!.id).toBe(created.id);
    expect(retrieved!.name).toBe("Get Test");
    expect(retrieved!.description).toBe("Testing get by ID");
    expect(retrieved!.symbol).toBe("ETH/USD");
    expect(retrieved!.thesis).toBe("Bullish on ETH");
    expect(retrieved!.tags).toEqual(["crypto", "eth"]);
    expect(retrieved!.status).toBe("active");
    expect(retrieved!.riskParameters).toEqual({
      maxPositionSize: 1.0,
      maxDrawdown: 0.25,
      stopLoss: 0.05,
    });
  });

  it("should list all workspaces", async () => {
    await manager.createWorkspace({
      name: "Workspace 1",
      description: "First workspace",
      symbol: "AAPL",
    });
    await manager.createWorkspace({
      name: "Workspace 2",
      description: "Second workspace",
      symbol: "GOOGL",
    });

    const list = await manager.listWorkspaces();
    expect(list).toHaveLength(2);
    // Items may be in any order, find by name
    const ws1 = list.find((w) => w.name === "Workspace 1");
    const ws2 = list.find((w) => w.name === "Workspace 2");
    expect(ws1).toBeDefined();
    expect(ws2).toBeDefined();
    expect(ws1!.symbol).toBe("AAPL");
    expect(ws1!.status).toBe("active");
    expect(ws1!.issueCount).toBe(0);
    expect(ws1!.entityCount).toBe(0);
    expect(ws1!.lastActivity).toBeGreaterThan(0);
  });

  it("should update a workspace", async () => {
    const ws = await manager.createWorkspace({
      name: "Original",
      description: "Original description",
      symbol: "MSFT",
    });

    const updated = await manager.updateWorkspace(ws.id, {
      name: "Updated Name",
      thesis: "Updated thesis",
    });

    expect(updated.name).toBe("Updated Name");
    expect(updated.thesis).toBe("Updated thesis");
    expect(updated.description).toBe("Original description");
    expect(updated.updatedAt).toBeGreaterThanOrEqual(ws.updatedAt);
  });

  it("should archive a workspace", async () => {
    const ws = await manager.createWorkspace({
      name: "Archivable",
      description: "Will be archived",
      symbol: "SOL/USD",
    });

    await manager.archiveWorkspace(ws.id);

    const archived = await manager.getWorkspace(ws.id);
    expect(archived).not.toBeNull();
    expect(archived!.status).toBe("archived");
    expect(archived!.updatedAt).toBeGreaterThanOrEqual(ws.updatedAt);
  });
});
