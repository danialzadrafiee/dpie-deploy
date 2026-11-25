import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { run, has } from "./exec.ts";
import { saveGlobal, type GlobalConfig } from "./config.ts";
import { ask, DeployError, log, spin } from "./ui.ts";

const API = "https://api.vercel.com";

export class Vercel {
  constructor(public token: string, public teamId: string | null = null) {}

  async req<T>(path: string, init: RequestInit & { query?: Record<string, string | undefined> } = {}): Promise<{ status: number; data: T }> {
    const url = new URL(API + path);
    for (const [k, v] of Object.entries(init.query ?? {})) if (v !== undefined) url.searchParams.set(k, v);
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    const res = await fetch(url, {
      ...init,
      headers: { Authorization: `Bearer ${this.token}`, ...(init.body ? { "Content-Type": "application/json" } : {}) },
    });
    const text = await res.text();
    let data: any = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = { raw: text };
    }
    return { status: res.status, data };
  }

  async user() {
    const r = await this.req<{ user: { username: string; id: string } }>("/v2/user");
    return r.status === 200 ? r.data.user : null;
  }

  async teams() {
    const r = await this.req<{ teams: { id: string; slug: string; name: string }[] }>("/v2/teams");
    return r.status === 200 ? r.data.teams : [];
  }

  /** All projects connected to this GitHub repo (one repo can feed several Vercel projects). */
  async findProjectsByRepo(owner: string, repo: string) {
    const r = await this.req<{ projects: VercelProject[] }>("/v10/projects", { query: { repoUrl: `https://github.com/${owner}/${repo}`, limit: "100" } });
    return (r.data?.projects ?? []).filter((p) => p.link?.type === "github" && `${p.link.org}/${p.link.repo}`.toLowerCase() === `${owner}/${repo}`.toLowerCase());
  }

  async findProjectByRepo(owner: string, repo: string) {
    return (await this.findProjectsByRepo(owner, repo))[0] ?? null;
  }

  async getProject(idOrName: string) {
    const r = await this.req<VercelProject>(`/v9/projects/${encodeURIComponent(idOrName)}`);
    return r.status === 200 ? r.data : null;
  }

  async createProject(name: string, framework: string | null, owner: string, repo: string) {
    const r = await this.req<VercelProject & { error?: { message: string } }>("/v11/projects", {
      method: "POST",
      body: JSON.stringify({ name, framework, gitRepository: { type: "github", repo: `${owner}/${repo}` } }),
    });
    if (r.status >= 300) throw new DeployError(`Could not create Vercel project "${name}"`, gitHint(r.data?.error?.message));
    return r.data;
  }

  async linkRepo(projectId: string, owner: string, repo: string) {
    const r = await this.req<{ error?: { message: string } }>(`/v9/projects/${projectId}/link`, {
      method: "POST",
      body: JSON.stringify({ type: "github", repo: `${owner}/${repo}` }),
    });
    if (r.status >= 300) throw new DeployError("Could not connect the Vercel project to GitHub", gitHint(r.data?.error?.message));
  }

  async upsertEnv(projectId: string, vars: Record<string, string>) {
    const body = Object.entries(vars).map(([key, value]) => ({
      key,
      value,
      type: "encrypted",
      target: ["production", "preview", "development"],
    }));
    if (!body.length) return;
    const r = await this.req<{ error?: { message: string } }>(`/v10/projects/${projectId}/env`, {
      method: "POST",
      query: { upsert: "true" },
      body: JSON.stringify(body),
    });
    if (r.status >= 300) throw new DeployError("Could not set Vercel environment variables", r.data?.error?.message);
  }

  async deploymentForCommit(projectId: string, sha: string) {
    const r = await this.req<{ deployments: VercelDeploymentSummary[] }>("/v6/deployments", { query: { projectId, limit: "20" } });
    return r.data?.deployments?.find((d) => d.meta?.githubCommitSha === sha) ?? null;
  }

  async deployment(id: string) {
    const r = await this.req<VercelDeployment>(`/v13/deployments/${id}`);
    return r.data;
  }

  /** Stream build log lines until the deployment's log stream closes. */
  async streamEvents(id: string, onLine: (text: string) => void, signal?: AbortSignal) {
    const url = new URL(`${API}/v3/deployments/${id}/events`);
    url.searchParams.set("follow", "1");
    url.searchParams.set("limit", "-1");
    if (this.teamId) url.searchParams.set("teamId", this.teamId);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` }, signal });
    if (!res.ok || !res.body) return false;
    const dec = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const l of lines) {
        // follow=1 streams one JSON object per line; without it the API returns a JSON array split over lines.
        const item = l.trim().replace(/^[\[,]+|[\],]+$/g, "");
        if (!item) continue;
        try {
          const ev = JSON.parse(item);
          const text = ev?.payload?.text ?? ev?.text;
          if (typeof text === "string" && (ev.type === "stdout" || ev.type === "stderr" || ev.type === "command")) {
            for (const t of text.split("\n")) onLine(t);
          }
        } catch {
          /* skip non-JSON keepalives */
        }
      }
    }
    return true;
  }
}

function gitHint(msg?: string) {
  return [msg, "Make sure the Vercel GitHub App can see this repo: https://github.com/apps/vercel/installations/new"].filter(Boolean).join("\n");
}

export interface VercelProject {
  id: string;
  name: string;
  link?: { type: string; org: string; repo: string; productionBranch?: string };
  targets?: { production?: { alias?: string[]; url?: string } };
}

interface VercelDeploymentSummary {
  uid: string;
  url: string;
  state?: string;
  readyState?: string;
  meta?: { githubCommitSha?: string };
}

export interface VercelDeployment {
  id: string;
  url: string;
  readyState: "QUEUED" | "BUILDING" | "INITIALIZING" | "READY" | "ERROR" | "CANCELED";
  alias?: string[];
  errorMessage?: string;
  inspectorUrl?: string;
}

// ---------- token discovery ----------

function cliDataDirs() {
  const home = homedir();
  const dirs = [
    join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "com.vercel.cli"),
    join(home, "Library", "Application Support", "com.vercel.cli"),
    join(home, ".vercel"),
    join(home, ".now"),
  ];
  if (process.env.LOCALAPPDATA) dirs.push(join(process.env.LOCALAPPDATA, "com.vercel.cli", "Data"));
  if (process.env.APPDATA) dirs.push(join(process.env.APPDATA, "com.vercel.cli", "Data"), join(process.env.APPDATA, "com.vercel.cli"));
  return dirs;
}

function readCliAuth(): { token: string; expiresAt?: number } | null {
  for (const dir of cliDataDirs()) {
    const f = join(dir, "auth.json");
    if (!existsSync(f)) continue;
    try {
      const j = JSON.parse(readFileSync(f, "utf8"));
      if (j.token) return { token: j.token, expiresAt: j.expiresAt };
    } catch {
      /* ignore */
    }
  }
  return null;
}

/** The team the Vercel CLI currently has selected, used as the default scope. */
export function cliCurrentTeam(): string | null {
  for (const dir of cliDataDirs()) {
    const f = join(dir, "config.json");
    if (!existsSync(f)) continue;
    try {
      return JSON.parse(readFileSync(f, "utf8")).currentTeam ?? null;
    } catch {
      /* ignore */
    }
  }
  return null;
}

async function tokenFromCli(): Promise<string | null> {
  let auth = readCliAuth();
  if (!auth) return null;
  const expMs = auth.expiresAt ? (auth.expiresAt < 1e12 ? auth.expiresAt * 1000 : auth.expiresAt) : null;
  if (expMs && expMs < Date.now() + 60_000 && (await has("vercel"))) {
    // `vercel whoami` refreshes an expired CLI login in place.
    await run(["vercel", "whoami"]);
    auth = readCliAuth();
  }
  return auth?.token ?? null;
}

/** Resolve a working Vercel token: saved → Vercel CLI login → $VERCEL_TOKEN → ask. */
export async function resolveVercelToken(global: GlobalConfig, opts: { interactive: boolean }): Promise<{ token: string; user: string }> {
  const check = async (t: string | null | undefined) => (t ? (await new Vercel(t).user())?.username ?? null : null);

  if (global.vercel?.source === "manual" && global.vercel.token) {
    const user = await check(global.vercel.token);
    if (user) return { token: global.vercel.token, user };
    log.warn("Saved Vercel token no longer works, looking for another one");
  }

  const found = await spin(
    "Looking for a Vercel token (Vercel CLI, env)",
    async () => {
      const cli = await tokenFromCli();
      const cliUser = await check(cli);
      if (cli && cliUser) return { token: cli, user: cliUser, source: "cli" as const };
      const env = process.env.VERCEL_TOKEN;
      const envUser = await check(env);
      if (env && envUser) return { token: env, user: envUser, source: "manual" as const };
      return null;
    },
    (r) => (r ? `Vercel: signed in as ${r.user} (${r.source === "cli" ? "Vercel CLI login" : "$VERCEL_TOKEN"})` : "No Vercel token found on this machine"),
  );

  if (found) {
    global.vercel = found.source === "cli" ? { source: "cli" } : { source: "manual", token: found.token };
    saveGlobal(global);
    return found;
  }

  while (true) {
    if (!opts.interactive) throw new DeployError("No working Vercel token", "Run `deploy` without -y once to enter it.");
    const token = await ask.secret("Vercel token (create one at https://vercel.com/account/tokens)");
    const user = await check(token);
    if (user) {
      global.vercel = { source: "manual", token };
      saveGlobal(global);
      return { token, user };
    }
    log.error("That token was rejected by Vercel, try again");
  }
}
