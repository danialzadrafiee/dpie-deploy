import { copyFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ProjectConfig } from "./config.ts";
import { ask, DeployError, log } from "./ui.ts";

export function parseDotenv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_.-]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2]!;
    const q = value[0];
    if ((q === '"' || q === "'" || q === "`") && value.lastIndexOf(q) > 0) {
      value = value.slice(1, value.lastIndexOf(q));
      if (q === '"') value = value.replace(/\\n/g, "\n");
    } else {
      value = value.replace(/\s+#.*$/, "").trim();
    }
    out[m[1]!] = value;
  }
  return out;
}

/**
 * Make sure the chosen env file exists. If it doesn't but `.env` does, clone `.env` into it so it isn't empty.
 * Returns false if neither exists.
 */
export function ensureEnvFile(cwd: string, file: string): boolean {
  const path = join(cwd, file);
  if (existsSync(path)) return true;
  const base = join(cwd, ".env");
  if (file !== ".env" && existsSync(base)) {
    copyFileSync(base, path);
    log.info(`Created ${file} from .env`);
    return true;
  }
  return false;
}

export function readEnvFile(cwd: string, file: string): { text: string; vars: Record<string, string> } {
  if (!ensureEnvFile(cwd, file)) throw new DeployError(`Env file ${file} not found`, "Create it, or run `deploy --edit` and turn env off.");
  const text = readFileSync(join(cwd, file), "utf8");
  return { text, vars: parseDotenv(text) };
}

/** Wizard section: does this deploy need env vars, and from which file? */
export async function askEnv(cwd: string, current?: ProjectConfig["env"]): Promise<ProjectConfig["env"]> {
  const want = await ask.confirm("Does this project need environment variables (.env) on the target?", current ? current.enabled : existsSync(join(cwd, ".env")));
  if (!want) return { enabled: false };

  const currentFile = current?.enabled ? current.file : undefined;
  const choice = await ask.select(
    "Which env file should be deployed? (it becomes .env on the target)",
    [
      { value: ".env", label: ".env", hint: existsSync(join(cwd, ".env")) ? "exists" : "missing" },
      { value: ".deploy.env", label: ".deploy.env", hint: existsSync(join(cwd, ".deploy.env")) ? "exists" : "will be created from .env" },
      { value: "__custom", label: "Custom file name" },
    ],
    currentFile === ".env" || currentFile === ".deploy.env" ? currentFile : currentFile ? "__custom" : ".deploy.env",
  );
  const file = choice === "__custom" ? await ask.text("Env file name", { initial: currentFile ?? "deploy.env" }) : choice;

  if (!ensureEnvFile(cwd, file)) {
    writeFileSync(join(cwd, file), "# Environment variables for deploy (KEY=value)\n");
    log.warn(`${file} did not exist and there is no .env to copy, created an empty one. Fill it before deploying.`);
  }
  const count = Object.keys(parseDotenv(readFileSync(join(cwd, file), "utf8"))).length;
  log.info(`${file}: ${count} variable${count === 1 ? "" : "s"}`);
  return { enabled: true, file };
}
