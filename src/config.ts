import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Stack, PackageManager } from "./detect.ts";

export const PROJECT_FILE = "deploy.json";
export const HOME_DIR = join(homedir(), ".deploy");
export const GLOBAL_FILE = join(HOME_DIR, "config.json");
export const LOGS_DIR = join(HOME_DIR, "logs");

export type Runner = "pm2" | "compose" | "docker";

export interface ServerConn {
  /** Display name: ssh-config alias or user@host. */
  name: string;
  host: string;
  port: number;
  user: string;
  auth: "key" | "password";
  keyPath?: string;
  password?: string;
}

export interface Commands {
  install: string;
  build: string;
  start: string;
}

export interface ProjectConfig {
  version: 1;
  name: string;
  stack: Stack;
  packageManager: PackageManager;
  target: "vercel" | "server";
  github: { owner: string; repo: string; branch: string };
  env: { enabled: false } | { enabled: true; file: string };
  vercel?: { projectId?: string; projectName: string; teamId?: string | null; teamSlug?: string | null };
  server?: ServerConn & {
    path: string;
    runner: Runner;
    appPort: number;
    /** Port the app listens on inside the container (docker runner only). */
    containerPort?: number;
    commands: Commands;
  };
}

export interface GlobalConfig {
  github?: { token: string; user?: string };
  /** source=cli means: re-read the Vercel CLI auth file each run (its tokens expire and get refreshed). */
  vercel?: { token?: string; source: "manual" | "cli" };
  servers: ServerConn[];
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch (e) {
    throw new Error(`Could not parse ${path}: ${(e as Error).message}`);
  }
}

export function loadGlobal(): GlobalConfig {
  return { servers: [], ...(readJson<GlobalConfig>(GLOBAL_FILE) ?? {}) };
}

export function saveGlobal(cfg: GlobalConfig) {
  mkdirSync(HOME_DIR, { recursive: true });
  writeFileSync(GLOBAL_FILE, JSON.stringify(cfg, null, 2) + "\n");
}

/** Remember a server in the global list (replacing an older entry for the same user@host:port). */
export function rememberServer(cfg: GlobalConfig, s: ServerConn) {
  const key = (x: ServerConn) => `${x.user}@${x.host}:${x.port}`;
  const clean: ServerConn = {
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.user,
    auth: s.auth,
    ...(s.auth === "key" ? { keyPath: s.keyPath } : { password: s.password }),
  };
  cfg.servers = [clean, ...cfg.servers.filter((x) => key(x) !== key(s))];
}

export const projectFile = (cwd: string) => join(cwd, PROJECT_FILE);

export function loadProject(cwd: string): ProjectConfig | null {
  return readJson<ProjectConfig>(projectFile(cwd));
}

export function saveProject(cwd: string, cfg: ProjectConfig) {
  writeFileSync(projectFile(cwd), JSON.stringify(cfg, null, 2) + "\n");
}
