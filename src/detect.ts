import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Commands, Runner } from "./config.ts";

export type Stack = "nextjs" | "vite" | "hono" | "express" | "html" | "docker";
export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export const STACK_LABEL: Record<Stack, string> = {
  nextjs: "Next.js",
  vite: "Vite",
  hono: "Hono",
  express: "Express",
  html: "Static HTML",
  docker: "Docker",
};

export interface Detection {
  /** Best guesses, most likely first. */
  candidates: { stack: Stack; reason: string }[];
  packageManager: PackageManager;
  hasPackageJson: boolean;
  hasDockerfile: boolean;
  composeFile: string | null;
  pkg: PackageJson | null;
}

interface PackageJson {
  name?: string;
  main?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

const COMPOSE_FILES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

export function detect(cwd: string): Detection {
  const has = (f: string) => existsSync(join(cwd, f));
  let pkg: PackageJson | null = null;
  if (has("package.json")) {
    try {
      pkg = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8"));
    } catch {
      pkg = {};
    }
  }
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies };
  const dep = (name: string) => name in deps;
  const anyFile = (...names: string[]) => names.find(has);

  const candidates: Detection["candidates"] = [];
  const nextCfg = anyFile("next.config.js", "next.config.mjs", "next.config.ts", "next.config.cjs");
  if (dep("next") || nextCfg) candidates.push({ stack: "nextjs", reason: dep("next") ? "`next` in package.json" : nextCfg! });

  const viteCfg = anyFile("vite.config.ts", "vite.config.js", "vite.config.mjs", "vite.config.mts");
  if (dep("vite") || viteCfg) candidates.push({ stack: "vite", reason: dep("vite") ? "`vite` in package.json" : viteCfg! });

  if (dep("hono")) candidates.push({ stack: "hono", reason: "`hono` in package.json" });
  if (dep("express")) candidates.push({ stack: "express", reason: "`express` in package.json" });

  const hasDockerfile = has("Dockerfile");
  const composeFile = COMPOSE_FILES.find(has) ?? null;
  if (hasDockerfile || composeFile) {
    candidates.push({ stack: "docker", reason: composeFile ?? "Dockerfile" });
  }

  if (!pkg && has("index.html")) candidates.push({ stack: "html", reason: "index.html without package.json" });

  return {
    candidates,
    packageManager: detectPackageManager(cwd),
    hasPackageJson: !!pkg,
    hasDockerfile,
    composeFile,
    pkg,
  };
}

function detectPackageManager(cwd: string): PackageManager {
  const has = (f: string) => existsSync(join(cwd, f));
  if (has("pnpm-lock.yaml")) return "pnpm";
  if (has("bun.lock") || has("bun.lockb")) return "bun";
  if (has("yarn.lock")) return "yarn";
  return "npm";
}

/** Default port a stack listens on. */
export function defaultPort(stack: Stack): number {
  return stack === "vite" ? 4173 : stack === "html" ? 8080 : 3000;
}

/** Runners that make sense for a stack on a plain server. */
export function runnersFor(stack: Stack, det: Detection): Runner[] {
  if (stack === "docker") return det.composeFile ? ["compose", "docker"] : ["docker"];
  const list: Runner[] = ["pm2"];
  if (det.composeFile) list.push("compose");
  if (det.hasDockerfile) list.push("docker");
  return list;
}

/** Best-guess install/build/start commands. `$PORT` is substituted with the app port at deploy time. */
export function defaultCommands(stack: Stack, pm: PackageManager, det: Detection): Commands {
  const run = (s: string) => (pm === "npm" ? `npm run ${s}` : `${pm} run ${s}`);
  const scripts = det.pkg?.scripts ?? {};
  const install = det.hasPackageJson ? `${pm} install` : "";
  const build = scripts.build ? run("build") : "";
  const exec = pm === "bun" ? "bunx" : "npx --yes";

  switch (stack) {
    case "nextjs":
      return { install, build, start: `${run("start")} -- -p $PORT`.replace("bun run start --", "bun run start") };
    case "vite":
      return { install, build, start: `${exec} serve -s dist -l tcp://0.0.0.0:$PORT` };
    case "html":
      return { install, build, start: `${exec} serve -l tcp://0.0.0.0:$PORT .` };
    case "hono":
    case "express":
    case "docker": {
      const start = scripts.start ? run("start") : det.pkg?.main ? `node ${det.pkg.main}` : run("start");
      return { install, build, start };
    }
  }
}

/** Vercel framework slug for project creation. */
export function vercelFramework(stack: Stack): string | null {
  return ({ nextjs: "nextjs", vite: "vite", hono: "hono", express: "express" } as Partial<Record<Stack, string>>)[stack] ?? null;
}
