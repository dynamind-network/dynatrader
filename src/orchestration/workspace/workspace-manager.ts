import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export interface TradingWorkspace {
  id: string;
  name: string;
  description: string;
  symbol: string;
  status: "active" | "archived" | "completed";
  createdAt: number;
  updatedAt: number;
  tags: string[];
  thesis: string;
  riskParameters: {
    maxPositionSize: number;
    maxDrawdown: number;
    stopLoss: number;
  };
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  symbol: string;
  status: TradingWorkspace["status"];
  issueCount: number;
  entityCount: number;
  lastActivity: number;
}

const DEFAULT_RISK_PARAMETERS = {
  maxPositionSize: 1.0,
  maxDrawdown: 0.25,
  stopLoss: 0.05,
} as const;

export class WorkspaceManager {
  constructor(private workspacePath: string) {}

  private workspacesDir(): string {
    return join(this.workspacePath, "workspaces");
  }

  private workspaceFilePath(id: string): string {
    return join(this.workspacesDir(), `${id}.json`);
  }

  async createWorkspace(spec: {
    name: string;
    description: string;
    symbol: string;
    thesis?: string;
    tags?: string[];
    riskParameters?: Partial<TradingWorkspace["riskParameters"]>;
  }): Promise<TradingWorkspace> {
    const id = randomUUID();
    const now = Date.now();

    const workspace: TradingWorkspace = {
      id,
      name: spec.name,
      description: spec.description,
      symbol: spec.symbol,
      status: "active",
      createdAt: now,
      updatedAt: now,
      tags: spec.tags ?? [],
      thesis: spec.thesis ?? "",
      riskParameters: {
        ...DEFAULT_RISK_PARAMETERS,
        ...spec.riskParameters,
      },
    };

    const dir = this.workspacesDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      this.workspaceFilePath(id),
      JSON.stringify(workspace, null, 2),
      "utf-8",
    );

    return workspace;
  }

  async getWorkspace(id: string): Promise<TradingWorkspace | null> {
    try {
      const content = await fs.readFile(this.workspaceFilePath(id), "utf-8");
      return JSON.parse(content) as TradingWorkspace;
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return null;
      }
      throw error;
    }
  }

  async listWorkspaces(
    status?: TradingWorkspace["status"],
  ): Promise<WorkspaceSummary[]> {
    const dir = this.workspacesDir();

    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
      }
      throw error;
    }

    const jsonFiles = files.filter((f) => f.endsWith(".json"));
    const summaries: WorkspaceSummary[] = [];

    for (const file of jsonFiles) {
      const content = await fs.readFile(join(dir, file), "utf-8");
      const ws = JSON.parse(content) as TradingWorkspace;

      if (status && ws.status !== status) {
        continue;
      }

      summaries.push({
        id: ws.id,
        name: ws.name,
        symbol: ws.symbol,
        status: ws.status,
        issueCount: 0,
        entityCount: 0,
        lastActivity: ws.updatedAt,
      });
    }

    return summaries;
  }

  async updateWorkspace(
    id: string,
    updates: Partial<TradingWorkspace>,
  ): Promise<TradingWorkspace> {
    const existing = await this.getWorkspace(id);
    if (!existing) {
      throw new Error(`Workspace not found: ${id}`);
    }

    const updated: TradingWorkspace = {
      ...existing,
      ...updates,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: Date.now(),
    };

    await fs.writeFile(
      this.workspaceFilePath(id),
      JSON.stringify(updated, null, 2),
      "utf-8",
    );

    return updated;
  }

  async archiveWorkspace(id: string): Promise<void> {
    const existing = await this.getWorkspace(id);
    if (!existing) {
      throw new Error(`Workspace not found: ${id}`);
    }

    existing.status = "archived";
    existing.updatedAt = Date.now();

    await fs.writeFile(
      this.workspaceFilePath(id),
      JSON.stringify(existing, null, 2),
      "utf-8",
    );
  }

  async deleteWorkspace(id: string): Promise<void> {
    try {
      await fs.unlink(this.workspaceFilePath(id));
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        throw new Error(`Workspace not found: ${id}`);
      }
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
