import { join } from "node:path";
import { loadGlobal, LOGS_DIR, saveProject, type ProjectConfig } from "./config.ts";
import { readEnvFile } from "./env.ts";
import * as git from "./git.ts";
import { resolveGithubToken } from "./github.ts";
import { checkPrerequisites, connectServer, deployToServer } from "./targets/server.ts";
import { followVercel, prepareVercel } from "./targets/vercel.ts";
import type { Remote } from "./ssh.ts";
import { ask, DeployError, fmtDuration, log, p, pc, section, spin, startLogFile } from "./ui.ts";

const pad = (n: number) => String(n).padStart(2, "0");

export function commitMessage(d = new Date()) {
  return `dpie-deploy: ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function logPathFor(name: string, d = new Date()) {
  const ts = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  return join(LOGS_DIR, name, `${ts}.log`);
}

export async function runDeploy(cwd: string, cfg: ProjectConfig, opts: { yes: boolean }) {
  const started = Date.now();
  const logFile = logPathFor(cfg.name);
  startLogFile(logFile);
  const global = loadGlobal();
  const interactive = !opts.yes;

  const { token: ghToken } = await resolveGithubToken(global, { interactive });
  const env = cfg.env.enabled ? readEnvFile(cwd, cfg.env.file) : null;

  // 1. Target preflight (before touching git, so a broken target fails fast).
  let remote: Remote | null = null;
  let vercel: Awaited<ReturnType<typeof prepareVercel>> | null = null;
  if (cfg.target === "vercel") {
    const { resolveVercelToken } = await import("./vercel.ts");
    const { token } = await resolveVercelToken(global, { interactive });
    vercel = await prepareVercel(cfg, token, env?.vars ?? null);
    saveProject(cwd, cfg); // remember projectId
  } else {
    remote = await connectServer(cfg.server!);
    await checkPrerequisites(remote, cfg);
  }

  try {
    // 2. Git: commit if needed and push to GitHub.
    const branch = cfg.github.branch;
    const current = await git.currentBranch(cwd);
    const firstCommit = !(await git.hasCommits(cwd));
    if (!firstCommit && current && current !== branch) {
      throw new DeployError(`You are on branch "${current}", but deploys go from "${branch}"`, `Run: git checkout ${branch}  (and merge your work), then deploy again.`);
    }

    const dirty = await git.dirtyFiles(cwd);
    if (dirty.length || firstCommit) {
      const msg = commitMessage();
      const doCommit = opts.yes || (await ask.confirm(`${dirty.length} uncommitted change${dirty.length === 1 ? "" : "s"}. Commit them as "${msg}"?`, true));
      if (doCommit) {
        await spin(`Committing ${dirty.length} file${dirty.length === 1 ? "" : "s"}`, () => git.commitAll(cwd, msg), () => `Committed: ${msg}`);
      } else if (firstCommit) {
        throw new DeployError("The repository has no commits yet, nothing to deploy");
      } else {
        log.warn("Deploying the last commit, uncommitted changes are NOT included");
      }
    }

    const sha = await git.headSha(cwd);
    const alreadyOnVercel = vercel ? !!(await vercel.deploymentForCommit(cfg.vercel!.projectId!, sha)) : false;

    const remoteName = await git.remoteFor(cwd, cfg.github.owner, cfg.github.repo);
    const out = section(`git push ${remoteName} → ${cfg.github.owner}/${cfg.github.repo} (${branch})`);
    await git.push(cwd, remoteName, branch, ghToken, (c) => out.write(c));
    out.flush();
    log.success(`Pushed ${sha.slice(0, 7)} to GitHub`);

    // 3. Ship it.
    const url =
      cfg.target === "vercel"
        ? await followVercel(cfg, vercel!, sha, alreadyOnVercel)
        : await deployToServer(remote!, cfg, ghToken, env?.text ?? null);

    p.outro(`${pc.green("Deployed")} in ${fmtDuration(Date.now() - started)}  ${pc.bold(pc.cyan(url))}\n   ${pc.dim(`log: ${logFile}`)}`);
  } finally {
    remote?.close();
  }
}
