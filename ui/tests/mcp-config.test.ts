import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadMCPConfig } from "../src/config/mcp-config.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  if (originalHome === undefined) {
    delete process.env.HOME;
  } else {
    process.env.HOME = originalHome;
  }
  if (originalUserProfile === undefined) {
    delete process.env.USERPROFILE;
  } else {
    process.env.USERPROFILE = originalUserProfile;
  }
});

describe("loadMCPConfig", () => {
  it("throws an actionable error for invalid MCP JSON", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "mcp.json"),
      "{ invalid json",
    );

    await expect(loadMCPConfig(workspaceDir)).rejects.toThrow(
      /Invalid JSON in .*mcp\.json/,
    );
  });

  it("throws when an MCP command path does not exist", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          broken: {
            command: "./missing-server.js",
            args: [],
          },
        },
      }),
    );

    await expect(loadMCPConfig(workspaceDir)).rejects.toThrow(/does not exist/);
  });

  it("loads a valid bare command server definition", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "mcp.json"),
      JSON.stringify({
        mcpServers: {
          filesystem: {
            command: "npx",
            args: ["-y", "@modelcontextprotocol/server-filesystem", "."],
          },
        },
      }),
    );

    await expect(loadMCPConfig(workspaceDir)).resolves.toMatchObject({
      filesystem: {
        command: "npx",
      },
    });
  });
});
