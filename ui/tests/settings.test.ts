import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  clearSettingsCache,
  loadSettings,
  loadPluginSettingsSync,
  updatePluginSetting,
} from "../src/config/settings.js";

const originalHome = process.env.HOME;
const originalUserProfile = process.env.USERPROFILE;

async function makeTempDir(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

afterEach(() => {
  clearSettingsCache();
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

describe("loadSettings", () => {
  it("deep-merges user and workspace settings without dropping defaults", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(homeDir, ".dynamind"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".dynamind", "settings.json"),
      JSON.stringify({
        hyperliquid: {
          apiKey: "user-key",
        },
        compaction: {
          auto: false,
        },
      }),
    );

    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "settings.json"),
      JSON.stringify({
        hyperliquid: {
          userAddress: "0xabc",
        },
      }),
    );

    const settings = await loadSettings(workspaceDir);

    expect(settings.hyperliquid.apiKey).toBe("user-key");
    expect(settings.hyperliquid.userAddress).toBe("0xabc");
    expect(settings.hyperliquid.apiSecret).toBe("");
    expect(settings.compaction?.auto).toBe(false);
    expect(settings.compaction?.prune).toBe(true);
  });

  it("ignores legacy .cm8 settings files", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(homeDir, ".cm8"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".cm8"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".cm8", "settings.json"),
      JSON.stringify({ deepseekApiKey: "legacy-user-key" }),
    );
    await fs.writeFile(
      path.join(workspaceDir, ".cm8", "settings.json"),
      JSON.stringify({ glmApiKey: "legacy-workspace-key" }),
    );

    const settings = await loadSettings(workspaceDir);

    expect(settings.deepseekApiKey).toBe("");
    expect(settings.glmApiKey).toBe("");
  });

  it("caches settings per workspace and resets correctly", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceA = await makeTempDir("dynamind-workspace-a-");
    const workspaceB = await makeTempDir("dynamind-workspace-b-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceA, ".dynamind"), { recursive: true });
    await fs.mkdir(path.join(workspaceB, ".dynamind"), { recursive: true });

    await fs.writeFile(
      path.join(workspaceA, ".dynamind", "settings.json"),
      JSON.stringify({ deepseekApiKey: "workspace-a" }),
    );
    await fs.writeFile(
      path.join(workspaceB, ".dynamind", "settings.json"),
      JSON.stringify({ deepseekApiKey: "workspace-b" }),
    );

    const a = await loadSettings(workspaceA);
    const b = await loadSettings(workspaceB);

    expect(a.deepseekApiKey).toBe("workspace-a");
    expect(b.deepseekApiKey).toBe("workspace-b");

    clearSettingsCache();

    await fs.writeFile(
      path.join(workspaceA, ".dynamind", "settings.json"),
      JSON.stringify({ deepseekApiKey: "workspace-a-updated" }),
    );

    const refreshed = await loadSettings(workspaceA);
    expect(refreshed.deepseekApiKey).toBe("workspace-a-updated");
  });

  it("throws an actionable error for invalid workspace settings JSON", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "settings.json"),
      "{ invalid json",
    );

    await expect(loadSettings(workspaceDir)).rejects.toThrow(
      /Invalid JSON in .*settings\.json/,
    );
  });

  it("loads plugin defaults and allows workspace overrides", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(homeDir, ".dynamind"), { recursive: true });
    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });

    await fs.writeFile(
      path.join(homeDir, ".dynamind", "settings.json"),
      JSON.stringify({
        plugins: {
          market: true,
        },
      }),
    );
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "settings.json"),
      JSON.stringify({
        plugins: {
          portfolio: true,
        },
      }),
    );

    const settings = await loadSettings(workspaceDir);
    const pluginSettings = loadPluginSettingsSync(workspaceDir);

    expect(settings.plugins.market).toBe(true);
    expect(settings.plugins.portfolio).toBe(true);
    expect(pluginSettings.market).toBe(true);
    expect(pluginSettings.portfolio).toBe(true);
  });

  it("updates workspace plugin settings without dropping other keys", async () => {
    const homeDir = await makeTempDir("dynamind-home-");
    const workspaceDir = await makeTempDir("dynamind-workspace-");
    process.env.HOME = homeDir;
    process.env.USERPROFILE = homeDir;

    await fs.mkdir(path.join(workspaceDir, ".dynamind"), { recursive: true });
    await fs.writeFile(
      path.join(workspaceDir, ".dynamind", "settings.json"),
      JSON.stringify({
        hyperliquid: {
          apiKey: "keep-me",
        },
      }),
    );

    await updatePluginSetting("market", true, workspaceDir);
    clearSettingsCache();

    const settings = await loadSettings(workspaceDir);

    expect(settings.hyperliquid.apiKey).toBe("keep-me");
    expect(settings.plugins.market).toBe(true);
    expect(settings.plugins.portfolio).toBe(false);
  });
});
