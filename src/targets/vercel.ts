import type { ProjectConfig } from "../config.ts";
import { vercelFramework } from "../detect.ts";
import { Vercel, type VercelDeployment } from "../vercel.ts";
import { DeployError, log, pc, section, spin } from "../ui.ts";

/** Before pushing: make sure the Vercel project exists, is linked to the repo, and has env vars. */
export async function prepareVercel(cfg: ProjectConfig, token: string, envVars: Record<string, string> | null) {
  const v = new Vercel(token, cfg.vercel?.teamId ?? null);
  const { owner, repo } = cfg.github;

  let project = await spin(
    "Checking Vercel project",
    async () => (cfg.vercel?.projectId ? await v.getProject(cfg.vercel.projectId) : null) ?? (await v.findProjectByRepo(owner, repo)),
    (p) => (p ? `Vercel project: ${p.name}` : "No Vercel project linked to this repo yet"),
  );

  if (!project) {
    const name = cfg.vercel?.projectName ?? cfg.name;
    project = await spin(`Creating Vercel project "${name}" linked to ${owner}/${repo}`, () => v.createProject(name, vercelFramework(cfg.stack), owner, repo), (p) => `Created Vercel project ${p.name}`);
  } else if (!project.link || `${project.link.org}/${project.link.repo}`.toLowerCase() !== `${owner}/${repo}`.toLowerCase()) {
    await spin(`Connecting ${project.name} to ${owner}/${repo}`, () => v.linkRepo(project!.id, owner, repo), () => `Connected ${project!.name} to GitHub`);
  }

  cfg.vercel = { ...cfg.vercel, projectId: project.id, projectName: project.name, teamId: v.teamId };

  if (envVars) {
    const n = Object.keys(envVars).length;
    await spin(`Syncing ${n} env var${n === 1 ? "" : "s"} to Vercel`, () => v.upsertEnv(project!.id, envVars), () => `Synced ${n} env var${n === 1 ? "" : "s"} to Vercel (production, preview, development)`);
  }
  return v;
}

/** After pushing: find the deployment GitHub triggered for this commit and stream its build log. */
export async function followVercel(cfg: ProjectConfig, v: Vercel, sha: string, alreadyDeployed: boolean): Promise<string> {
  const projectId = cfg.vercel!.projectId!;
  let depId: string | null = null;

  if (alreadyDeployed) {
    log.info("This commit was already deployed, starting a fresh production build from GitHub");
    depId = await createFromGit(v, cfg);
  } else {
    depId = await spin(
      "Waiting for Vercel to pick up the push",
      async () => {
        const until = Date.now() + 90_000;
        while (Date.now() < until) {
          const d = await v.deploymentForCommit(projectId, sha);
          if (d) return d.uid;
          await Bun.sleep(3000);
        }
        return null;
      },
      (id) => (id ? "Vercel started building" : "Vercel did not start a build from the push"),
    );
    if (!depId) {
      log.warn("Triggering the build directly from GitHub instead");
      depId = await createFromGit(v, cfg);
    }
  }

  // Stream the build log while polling the status. The log stream does not always close on its own,
  // so it is cut a few seconds after the deployment reaches a final state.
  const out = section("Vercel build log");
  const ctrl = new AbortController();
  const streaming = v.streamEvents(depId, (l) => out.line(l), ctrl.signal).catch(() => false);
  let dep: VercelDeployment = await v.deployment(depId);
  while (!isFinal(dep.readyState)) {
    await Bun.sleep(3000);
    dep = await v.deployment(depId);
  }
  await Promise.race([streaming, Bun.sleep(4000)]);
  ctrl.abort();
  out.flush();

  if (dep.readyState !== "READY") {
    throw new DeployError(`Vercel deployment ${dep.readyState.toLowerCase()}`, [dep.errorMessage, dep.inspectorUrl].filter(Boolean).join("\n"));
  }
  const domain = dep.alias?.find((a) => !a.includes("-git-")) ?? dep.alias?.[0] ?? dep.url;
  log.success(`Vercel deployment ready ${pc.dim(`(${dep.url})`)}`);
  return `https://${domain}`;
}

const isFinal = (s: string) => s === "READY" || s === "ERROR" || s === "CANCELED";

async function createFromGit(v: Vercel, cfg: ProjectConfig) {
  const r = await v.req<{ id: string; error?: { message: string } }>("/v13/deployments", {
    method: "POST",
    body: JSON.stringify({
      name: cfg.vercel!.projectName,
      project: cfg.vercel!.projectId,
      target: "production",
      gitSource: { type: "github", org: cfg.github.owner, repo: cfg.github.repo, ref: cfg.github.branch },
    }),
  });
  if (r.status >= 300) throw new DeployError("Could not start a Vercel deployment from GitHub", r.data?.error?.message);
  return r.data.id;
}
