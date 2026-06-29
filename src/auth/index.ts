// Phase 1: Copilot auth. Tokens are reused from the GitHub Copilot creds
// already on disk (the same apps.json VS Code / copilot.vim write). The
// oauth_token here is what gets exchanged at copilot_internal/v2/token (task 3).

import { existsSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";

export type DeviceCodePrompt = {
  userCode: string;
  verificationUri: string;
};

export type GitHubToken = {
  token: string;
  user: string;
};

const APPS_FILES = ["apps.json", "hosts.json"];

export function findCopilotConfigDirs(): string[] {
  const dirs: string[] = [];
  const seen = new Set<string>();
  const add = (dir: string | undefined) => {
    if (dir && !seen.has(dir)) {
      seen.add(dir);
      dirs.push(dir);
    }
  };

  if (platform() === "win32") {
    add(process.env.LOCALAPPDATA && join(process.env.LOCALAPPDATA, "github-copilot"));
    add(process.env.APPDATA && join(process.env.APPDATA, "GitHub Copilot"));
  } else {
    add(process.env.XDG_CONFIG_HOME && join(process.env.XDG_CONFIG_HOME, "github-copilot"));
    add(join(homedir(), ".config", "github-copilot"));
  }
  return dirs;
}

function extractToken(parsed: unknown): GitHubToken | null {
  if (!parsed || typeof parsed !== "object") return null;
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!key.startsWith("github.com")) continue;
    if (!value || typeof value !== "object") continue;
    const { oauth_token, user } = value as { oauth_token?: string; user?: string };
    if (typeof oauth_token === "string" && oauth_token.length > 0) {
      return { token: oauth_token, user: user ?? "unknown" };
    }
  }
  return null;
}

export function readGitHubToken(): GitHubToken | null {
  for (const dir of findCopilotConfigDirs()) {
    for (const file of APPS_FILES) {
      const path = join(dir, file);
      if (!existsSync(path)) continue;
      try {
        const found = extractToken(JSON.parse(readFileSync(path, "utf8")));
        if (found) return found;
      } catch {
        // malformed file — try the next candidate
      }
    }
  }
  return null;
}

let cached: GitHubToken | null | undefined;

export function getGitHubToken(): GitHubToken | null {
  if (cached === undefined) cached = readGitHubToken();
  return cached;
}

export async function ensureAuth(): Promise<DeviceCodePrompt | null> {
  getGitHubToken();
  return null;
}
