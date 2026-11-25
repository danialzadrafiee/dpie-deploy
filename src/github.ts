import { run, has } from "./exec.ts";
import { saveGlobal, type GlobalConfig } from "./config.ts";
import { ask, DeployError, log, spin } from "./ui.ts";

const API = "https://api.github.com";

async function gh<T>(token: string, path: string, init: RequestInit = {}): Promise<{ status: number; data: T }> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dpie-deploy",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
    },
  });
  const text = await res.text();
  return { status: res.status, data: (text ? JSON.parse(text) : null) as T };
}

export async function whoami(token: string): Promise<string | null> {
  try {
    const r = await gh<{ login: string }>(token, "/user");
    return r.status === 200 ? r.data.login : null;
  } catch {
    return null;
  }
}

/** Candidate tokens from the local machine, in priority order. */
async function localTokens(): Promise<{ source: string; token: string }[]> {
  const found: { source: string; token: string }[] = [];
  if (await has("gh")) {
    const r = await run(["gh", "auth", "token"]);
    if (r.code === 0 && r.stdout.trim()) found.push({ source: "gh CLI", token: r.stdout.trim() });
  }
  if (await has("git")) {
    const r = await run(["git", "credential", "fill"], { input: "protocol=https\nhost=github.com\n\n" });
    const pw = r.stdout.match(/^password=(.+)$/m)?.[1]?.trim();
    if (r.code === 0 && pw) found.push({ source: "git credential helper", token: pw });
  }
  for (const k of ["GITHUB_TOKEN", "GH_TOKEN"]) {
    const v = process.env[k];
    if (v) found.push({ source: `$${k}`, token: v });
  }
  return found;
}

/**
 * Resolve a working GitHub token: saved → gh → git credentials → env → ask.
 * The winner is saved to ~/.deploy/config.json.
 */
export async function resolveGithubToken(global: GlobalConfig, opts: { interactive: boolean }): Promise<{ token: string; user: string }> {
  if (global.github?.token) {
    const user = await whoami(global.github.token);
    if (user) return { token: global.github.token, user };
    log.warn("Saved GitHub token no longer works, looking for another one");
  }

  const found = await spin(
    "Looking for a GitHub token (gh, git, env)",
    async () => {
      for (const c of await localTokens()) {
        const user = await whoami(c.token);
        if (user) return { ...c, user };
      }
      return null;
    },
    (r) => (r ? `GitHub: signed in as ${r.user} (from ${r.source})` : "No GitHub token found on this machine"),
  );

  let result = found ? { token: found.token, user: found.user } : null;
  while (!result) {
    if (!opts.interactive) throw new DeployError("No working GitHub token", "Run `deploy` without -y once to enter it.");
    const token = await ask.secret("GitHub token (classic with `repo` scope, or fine-grained with Contents + Administration)");
    const user = await whoami(token);
    if (user) result = { token, user };
    else log.error("That token was rejected by GitHub, try again");
  }

  global.github = { token: result.token, user: result.user };
  saveGlobal(global);
  return result;
}

export async function repoExists(token: string, owner: string, repo: string) {
  const r = await gh(token, `/repos/${owner}/${repo}`);
  return r.status === 200;
}

export async function createRepo(token: string, name: string, isPrivate: boolean) {
  const r = await gh<{ full_name: string; clone_url: string; message?: string; errors?: { message: string }[] }>(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({ name, private: isPrivate, auto_init: false }),
  });
  if (r.status !== 201) {
    const detail = r.data?.errors?.map((e) => e.message).join(", ") || r.data?.message;
    throw new DeployError(`Could not create GitHub repo "${name}"`, detail);
  }
  return r.data;
}

export const httpsRemote = (owner: string, repo: string) => `https://github.com/${owner}/${repo}.git`;
export const tokenRemote = (token: string, owner: string, repo: string) => `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;
