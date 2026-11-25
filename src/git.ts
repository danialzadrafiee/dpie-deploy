import { run } from "./exec.ts";
import { DeployError } from "./ui.ts";

export async function git(cwd: string, args: string[], opts: { onOutput?: (c: string) => void; extraConfig?: string[] } = {}) {
  const cfg = (opts.extraConfig ?? []).flatMap((c) => ["-c", c]);
  return run(["git", ...cfg, ...args], { cwd, onOutput: opts.onOutput });
}

async function gitOk(cwd: string, args: string[]) {
  const r = await git(cwd, args);
  if (r.code !== 0) throw new DeployError(`git ${args.join(" ")} failed`, (r.stderr || r.stdout).trim());
  return r.stdout.trim();
}

export async function isRepo(cwd: string) {
  const r = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  return r.code === 0 && r.stdout.trim() === "true";
}

export async function initRepo(cwd: string, branch: string) {
  await gitOk(cwd, ["init", "-b", branch]);
}

export async function currentBranch(cwd: string) {
  const r = await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function hasCommits(cwd: string) {
  return (await git(cwd, ["rev-parse", "--verify", "HEAD"])).code === 0;
}

export async function remoteUrl(cwd: string, name = "origin") {
  const r = await git(cwd, ["remote", "get-url", name]);
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function setRemote(cwd: string, url: string, name = "origin") {
  const existing = await remoteUrl(cwd, name);
  await gitOk(cwd, existing ? ["remote", "set-url", name, url] : ["remote", "add", name, url]);
}

/** Parse owner/repo out of https or ssh GitHub remotes. */
export function parseGithubRemote(url: string): { owner: string; repo: string } | null {
  const m = url.match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1]!, repo: m[2]! } : null;
}

export async function dirtyFiles(cwd: string) {
  const out = await gitOk(cwd, ["status", "--porcelain"]);
  return out ? out.split("\n") : [];
}

export async function commitAll(cwd: string, message: string) {
  await gitOk(cwd, ["add", "-A"]);
  const r = await git(cwd, ["commit", "-m", message]);
  if (r.code !== 0) {
    const msg = (r.stderr || r.stdout).trim();
    if (/user\.(email|name)|identity/i.test(msg)) {
      throw new DeployError("git does not know who you are", 'Run: git config --global user.name "You" && git config --global user.email you@example.com');
    }
    throw new DeployError("git commit failed", msg);
  }
}

export async function headSha(cwd: string) {
  return gitOk(cwd, ["rev-parse", "HEAD"]);
}

/** Push using the token as an HTTP auth header, so it works regardless of local credential helpers. */
export async function push(cwd: string, branch: string, token: string, onOutput: (c: string) => void) {
  const url = await remoteUrl(cwd);
  const isHttps = !!url && url.startsWith("https://");
  const basic = Buffer.from(`x-access-token:${token}`).toString("base64");
  const extraConfig = isHttps ? [`http.https://github.com/.extraheader=AUTHORIZATION: basic ${basic}`, "credential.helper="] : [];
  const r = await git(cwd, ["push", "--progress", "-u", "origin", `HEAD:refs/heads/${branch}`], { onOutput, extraConfig });
  if (r.code !== 0) {
    const msg = r.stderr.trim();
    if (/GH013|push protection|secret/i.test(msg)) {
      throw new DeployError("GitHub rejected the push because it found a secret in your commits", "Remove the secret from the commit (git reset --soft HEAD~1), or allow it from the link GitHub printed above.");
    }
    if (/rejected|non-fast-forward|fetch first/i.test(msg)) {
      throw new DeployError(`The remote ${branch} has commits you don't have locally`, `Run: git pull --rebase origin ${branch}  then deploy again.`);
    }
    throw new DeployError("git push failed", msg);
  }
}

export async function ensureIgnored(cwd: string, entry: string) {
  const { existsSync, readFileSync, appendFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const path = join(cwd, ".gitignore");
  const content = existsSync(path) ? readFileSync(path, "utf8") : "";
  if (content.split(/\r?\n/).some((l) => l.trim() === entry)) return false;
  appendFileSync(path, `${content && !content.endsWith("\n") ? "\n" : ""}${entry}\n`);
  return true;
}
