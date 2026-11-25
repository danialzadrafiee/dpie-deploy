import { basename } from "node:path";
import { loadGlobal, rememberServer, saveGlobal, type GlobalConfig, type ProjectConfig, type Runner, type ServerConn } from "./config.ts";
import { defaultCommands, defaultPort, detect, runnersFor, STACK_LABEL, type Detection, type Stack } from "./detect.ts";
import { askEnv } from "./env.ts";
import * as git from "./git.ts";
import { createRepo, httpsRemote, repoExists, resolveGithubToken } from "./github.ts";
import { defaultKey, sshConfigHosts } from "./ssh.ts";
import { cliCurrentTeam, resolveVercelToken, Vercel, type VercelProject } from "./vercel.ts";
import { ask, log, p, pc, spin } from "./ui.ts";

type Draft = Partial<ProjectConfig> & { name: string };

const RUNNER_LABEL: Record<Runner, string> = {
  pm2: "pm2 (install → build → pm2 start)",
  compose: "docker compose up -d --build",
  docker: "docker build + docker run",
};

// ---------------------------------------------------------------- sections

async function projectSection(det: Detection, d: Draft) {
  const guess = det.candidates[0]?.stack;
  if (det.candidates.length) {
    p.note(det.candidates.map((c) => `${pc.green("●")} ${STACK_LABEL[c.stack].padEnd(12)} ${pc.dim(c.reason)}`).join("\n") + `\n${pc.dim("package manager:")} ${det.packageManager}`, "Detected");
  } else {
    log.warn("Could not detect the stack, pick it manually");
  }

  const all: Stack[] = ["nextjs", "vite", "hono", "express", "docker", "html"];
  const ordered = [...det.candidates.map((c) => c.stack), ...all.filter((s) => !det.candidates.some((c) => c.stack === s))];
  const multiple = det.candidates.length > 1;
  d.stack = await ask.select<Stack>(
    multiple ? "Found more than one option. How should this project be deployed?" : "Stack",
    ordered.map((s) => ({ value: s, label: STACK_LABEL[s], hint: det.candidates.find((c) => c.stack === s) ? "detected" : undefined })),
    d.stack ?? guess,
  );
  d.packageManager = det.packageManager;
  d.name = await ask.text("Project name", { initial: d.name });
}

async function githubSection(cwd: string, global: GlobalConfig, d: Draft) {
  const { token, user } = await resolveGithubToken(global, { interactive: true });
  const branch = "main";

  if (!(await git.isRepo(cwd))) {
    const init = await ask.confirm("This folder is not a git repository. Run `git init`?", true);
    if (!init) throw new Error("A git repository is required to deploy");
    await git.initRepo(cwd, branch);
    log.success("Initialized git repository");
  }

  // Look at every remote, not just "origin" (some repos call it "main", "github", ...).
  const remotes = await git.githubRemotes(cwd);
  const repos = [...new Map(remotes.map((r) => [`${r.owner}/${r.repo}`.toLowerCase(), r])).values()];
  let parsed: git.GithubRemote | null = repos[0] ?? null;
  if (repos.length > 1) {
    const pick = await ask.select(
      "This folder has several GitHub remotes. Which repo should be deployed?",
      repos.map((r) => ({ value: r.name, label: `${r.owner}/${r.repo}`, hint: `remote "${r.name}"` })),
      repos.find((r) => d.github && r.owner === d.github.owner && r.repo === d.github.repo)?.name,
    );
    parsed = repos.find((r) => r.name === pick)!;
  }
  if (parsed) {
    const p = parsed;
    const exists = await spin(
      "Checking GitHub repo",
      () => repoExists(token, p.owner, p.repo),
      (ok) => (ok ? `GitHub repo: ${p.owner}/${p.repo} ${pc.dim(`(remote "${p.name}")`)}` : `${p.owner}/${p.repo} not found on GitHub (or this token can't see it)`),
    );
    if (exists) {
      d.github = { owner: p.owner, repo: p.repo, branch };
      return;
    }
  } else {
    const other = await git.remoteUrl(cwd);
    if (other) log.warn(`origin points to ${other}, which is not GitHub`);
  }

  const create = await ask.confirm(`Create a GitHub repository for this project under ${user}?`, true);
  if (!create) throw new Error("A GitHub repository is required to deploy");
  const name = await ask.text("Repository name", { initial: parsed?.repo ?? d.name });
  const isPrivate = await ask.confirm("Private repository?", true);
  const repo = await spin(`Creating ${user}/${name}`, () => createRepo(token, name, isPrivate), (r) => `Created github.com/${r.full_name}`);
  const [owner, repoName] = repo.full_name.split("/") as [string, string];
  const remoteName = await git.remoteFor(cwd, owner, repoName);
  log.info(`Added git remote "${remoteName}" → ${httpsRemote(owner, repoName)}`);
  d.github = { owner, repo: repoName, branch };
}

async function vercelSection(global: GlobalConfig, d: Draft) {
  const { token, user } = await resolveVercelToken(global, { interactive: true });
  const teams = await new Vercel(token).teams();
  const slugOf = (teamId: string | null) => teams.find((t) => t.id === teamId)?.slug ?? null;
  const scopeLabel = (teamId: string | null) => slugOf(teamId) ?? `${user} (personal)`;

  // Search every scope (teams + personal) before asking anything.
  type Hit = { project: VercelProject; teamId: string | null; linked: boolean };
  const scopes: (string | null)[] = [...teams.map((t) => t.id), null];
  const { owner, repo } = d.github!;
  const hits = await spin(
    "Looking for this project on Vercel",
    async () => {
      const found = new Map<string, Hit>();
      const add = (h: Hit) => {
        // On newer accounts "personal" and the default team return the same project; keep the team one.
        const prev = found.get(h.project.id);
        if (!prev || (prev.teamId === null && h.teamId !== null) || (!prev.linked && h.linked)) found.set(h.project.id, h);
      };
      await Promise.all(
        scopes.map(async (teamId) => {
          const v = new Vercel(token, teamId);
          for (const project of await v.findProjectsByRepo(owner, repo)) add({ project, teamId, linked: true });
        }),
      );
      if (!found.size) {
        // Not connected to GitHub, but maybe it exists under the same name (deployed with the CLI before).
        const names = [...new Set([d.name, repo])];
        await Promise.all(
          scopes.flatMap((teamId) =>
            names.map(async (name) => {
              const project = await new Vercel(token, teamId).getProject(name);
              if (project) add({ project, teamId, linked: false });
            }),
          ),
        );
      }
      return [...found.values()];
    },
    (hs) =>
      hs.length === 1
        ? `Found Vercel project ${hs[0]!.project.name} ${pc.dim(`(${scopeLabel(hs[0]!.teamId)}${hs[0]!.linked ? "" : ", not connected to GitHub yet, will be connected on deploy"})`)}`
        : hs.length
          ? `Found ${hs.length} Vercel projects for this repo`
          : "No Vercel project for this repo yet, it will be created on first deploy",
  );

  let hit: Hit | null = hits[0] ?? null;
  if (hits.length > 1) {
    const id = await ask.select(
      "Several Vercel projects match this repo. Which one is this?",
      hits.map((h) => ({ value: h.project.id, label: h.project.name, hint: scopeLabel(h.teamId) })),
      hits.find((h) => h.project.id === d.vercel?.projectId)?.project.id,
    );
    hit = hits.find((h) => h.project.id === id)!;
  }

  let teamId: string | null;
  if (hit) {
    teamId = hit.teamId;
  } else if (teams.length) {
    // Only needed when a new project has to be created.
    const current = d.vercel?.teamId ?? cliCurrentTeam();
    const choice = await ask.select(
      "Which Vercel scope should the new project be created in?",
      [...teams.map((t) => ({ value: t.id, label: t.name, hint: t.slug })), { value: "__personal", label: `${user} (personal)` }],
      current && teams.some((t) => t.id === current) ? current : teams[0]!.id,
    );
    teamId = choice === "__personal" ? null : choice;
  } else {
    teamId = null;
  }

  d.vercel = {
    projectId: hit?.project.id,
    projectName: hit?.project.name ?? d.vercel?.projectName ?? d.name,
    teamId,
    teamSlug: slugOf(teamId),
  };
}

async function pickServer(global: GlobalConfig, current?: ServerConn): Promise<ServerConn> {
  const saved = global.servers;
  const fromSsh = sshConfigHosts().filter((h) => !saved.some((s) => s.host === h.host && s.user === h.user && s.port === h.port));
  const options = [
    ...saved.map((s, i) => ({ value: `saved:${i}`, label: s.name, hint: `${s.user}@${s.host}:${s.port} · saved` })),
    ...fromSsh.map((s, i) => ({ value: `ssh:${i}`, label: s.name, hint: `${s.user}@${s.host}:${s.port} · ~/.ssh/config` })),
    { value: "new", label: "New server", hint: "enter host, user, password or key" },
  ];
  const initial = current ? options.find((o) => o.hint?.startsWith(`${current.user}@${current.host}:${current.port}`))?.value : undefined;
  const choice = await ask.select("Server", options, initial ?? options[0]!.value);
  if (choice.startsWith("saved:")) return saved[Number(choice.slice(6))]!;
  if (choice.startsWith("ssh:")) return fromSsh[Number(choice.slice(4))]!;

  const host = await ask.text("Host (IP or domain)");
  const port = await ask.number("SSH port", 22);
  const user = await ask.text("SSH user", { initial: "root" });
  const auth = await ask.select<"password" | "key">("Authentication", [
    { value: "password", label: "Password" },
    { value: "key", label: "SSH key" },
  ]);
  const conn: ServerConn = { name: `${user}@${host}`, host, port, user, auth };
  if (auth === "password") conn.password = await ask.secret("SSH password");
  else conn.keyPath = await ask.text("Path to private key", { initial: defaultKey() ?? "~/.ssh/id_ed25519" });
  return conn;
}

async function serverSection(cwd: string, global: GlobalConfig, det: Detection, d: Draft) {
  const conn = await pickServer(global, d.server);
  rememberServer(global, conn);
  saveGlobal(global);

  const stack = d.stack!;
  const path = await ask.text("Project path on the server", { initial: d.server?.path ?? `/projects/${d.name}` });
  const runners = runnersFor(stack, det);
  const runner = await ask.select<Runner>(
    "How should it run on the server?",
    runners.map((r) => ({ value: r, label: RUNNER_LABEL[r] })),
    d.server?.runner && runners.includes(d.server.runner) ? d.server.runner : runners[0],
  );
  const appPort = await ask.number("Port the app will listen on", d.server?.appPort ?? defaultPort(stack));
  const containerPort = runner === "docker" ? await ask.number("Port the app listens on inside the container", d.server?.containerPort ?? appPort) : undefined;

  let commands = d.server?.commands ?? defaultCommands(stack, det.packageManager, det);
  if (runner === "pm2") {
    p.note([`install  ${commands.install || pc.dim("(none)")}`, `build    ${commands.build || pc.dim("(none)")}`, `start    ${commands.start}`].join("\n") + `\n${pc.dim("$PORT is replaced with the app port")}`, "Commands on the server");
    if (!(await ask.confirm("Use these commands?", true))) {
      commands = {
        install: await ask.text("Install command (empty = skip)", { initial: commands.install, required: false }),
        build: await ask.text("Build command (empty = skip)", { initial: commands.build, required: false }),
        start: await ask.text("Start command", { initial: commands.start }),
      };
    }
  }
  d.server = { ...conn, path, runner, appPort, containerPort, commands };
}

async function targetSection(cwd: string, global: GlobalConfig, det: Detection, d: Draft) {
  d.target = await ask.select<"vercel" | "server">(
    "Where should it be deployed?",
    [
      { value: "vercel", label: "Vercel", hint: "push to GitHub, Vercel builds it" },
      { value: "server", label: "Own server (SSH)", hint: "git pull + build on the server" },
    ],
    d.target ?? (d.stack === "docker" ? "server" : "vercel"),
  );
  if (d.target === "vercel") {
    delete d.server;
    await vercelSection(global, d);
  } else {
    delete d.vercel;
    await serverSection(cwd, global, det, d);
  }
}

// ---------------------------------------------------------------- flows

export async function initWizard(cwd: string): Promise<ProjectConfig> {
  const global = loadGlobal();
  const det = detect(cwd);
  const d: Draft = { name: basename(cwd) };

  await projectSection(det, d);
  await githubSection(cwd, global, d);
  await targetSection(cwd, global, det, d);
  d.env = await askEnv(cwd);

  const ignore = await ask.confirm("Add deploy.json to .gitignore?", false);
  if (ignore && (await git.ensureIgnored(cwd, "deploy.json"))) log.info("Added deploy.json to .gitignore");

  return { version: 1, ...d } as ProjectConfig;
}

export function summary(cfg: ProjectConfig): string {
  const k = (s: string) => pc.dim(s.padEnd(10));
  const lines = [
    `${k("project")}${pc.bold(cfg.name)}  ${pc.dim(`${STACK_LABEL[cfg.stack]} · ${cfg.packageManager}`)}`,
    `${k("github")}${cfg.github.owner}/${cfg.github.repo} ${pc.dim("→")} ${cfg.github.branch}`,
    `${k("env")}${cfg.env.enabled ? `${cfg.env.file} ${pc.dim("→ .env")}` : pc.dim("none")}`,
  ];
  if (cfg.target === "vercel" && cfg.vercel) {
    lines.push(`${k("target")}${pc.cyan("Vercel")}  ${cfg.vercel.projectName}${cfg.vercel.teamSlug ? pc.dim(` (${cfg.vercel.teamSlug})`) : ""}`);
  } else if (cfg.server) {
    const s = cfg.server;
    lines.push(`${k("target")}${pc.cyan("Server")}  ${s.user}@${s.host}:${s.port} ${pc.dim(`(${s.auth})`)}`);
    lines.push(`${k("path")}${s.path}`);
    lines.push(`${k("run")}${RUNNER_LABEL[s.runner]}  ${pc.dim("port")} ${s.appPort}`);
    if (s.runner === "pm2") {
      if (s.commands.install) lines.push(`${k("install")}${s.commands.install}`);
      if (s.commands.build) lines.push(`${k("build")}${s.commands.build}`);
      lines.push(`${k("start")}${s.commands.start}`);
    }
  }
  return lines.join("\n");
}

/** Let the user change one section at a time until they're done. */
export async function editMenu(cwd: string, cfg: ProjectConfig): Promise<ProjectConfig> {
  const global = loadGlobal();
  const det = detect(cwd);
  const d: Draft = structuredClone(cfg);
  while (true) {
    p.note(summary(d as ProjectConfig), "Current settings");
    const what = await ask.select("What do you want to change?", [
      { value: "done", label: pc.green("Done"), hint: "save and continue" },
      { value: "project", label: "Project", hint: "name, stack" },
      { value: "github", label: "GitHub", hint: "repository" },
      { value: "env", label: "Environment variables" },
      { value: "target", label: "Target", hint: "Vercel or server, and its settings" },
    ]);
    if (what === "done") break;
    if (what === "project") await projectSection(det, d);
    if (what === "github") await githubSection(cwd, global, d);
    if (what === "env") d.env = await askEnv(cwd, d.env);
    if (what === "target") await targetSection(cwd, global, det, d);
  }
  return d as ProjectConfig;
}
