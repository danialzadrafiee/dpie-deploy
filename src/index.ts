#!/usr/bin/env bun
import { existsSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { parseArgs } from "node:util";
import pkg from "../package.json" with { type: "json" };
import { loadProject, LOGS_DIR, PROJECT_FILE, projectFile, saveProject } from "./config.ts";
import { runDeploy } from "./deploy.ts";
import { editMenu, initWizard, summary } from "./wizard.ts";
import { ask, CancelledError, DeployError, p, pc, record } from "./ui.ts";

const HELP = `
${pc.bold("deploy")} ${pc.dim(`v${pkg.version}`)} — detect your stack and ship it to Vercel or your own server

${pc.bold("Usage")}
  deploy              First run: set up this folder. Later runs: show saved settings, Y/n, deploy.
  deploy -y           Deploy with saved settings, no questions (auto-commits changes)
  deploy --edit       Change saved settings, then deploy
  deploy --reset      Delete ${PROJECT_FILE} and set this folder up from scratch
  deploy logs         Print the log of the last deploy of this project
  deploy --version    Print the version
  deploy --help       Show this help

${pc.bold("Files")}
  ./${PROJECT_FILE}             Settings for this project
  ~/.deploy/config.json     Tokens (GitHub, Vercel) and saved servers
  ~/.deploy/logs/<project>/ Full log of every deploy

${pc.bold("Targets")}
  Vercel   Commits, pushes to GitHub; Vercel builds from GitHub. Build log is streamed here.
  Server   Commits, pushes to GitHub; the server pulls, builds and restarts (pm2 / docker / compose).
`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      yes: { type: "boolean", short: "y" },
      edit: { type: "boolean", short: "e" },
      reset: { type: "boolean" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });

  if (values.help || positionals[0] === "help") return console.log(HELP);
  if (values.version) return console.log(pkg.version);

  const cwd = process.cwd();
  if (positionals[0] === "logs") return printLastLog(cwd);
  if (positionals.length) {
    console.log(`Unknown command: ${positionals.join(" ")}\n${HELP}`);
    process.exitCode = 1;
    return;
  }

  p.intro(`${pc.bgCyan(pc.black(" deploy "))} ${pc.dim(`v${pkg.version}`)}`);

  if (values.reset && existsSync(projectFile(cwd))) {
    rmSync(projectFile(cwd));
    p.log.info(`Removed ${PROJECT_FILE}`);
  }

  let cfg = loadProject(cwd);
  if (!cfg) {
    if (values.yes) throw new DeployError(`No ${PROJECT_FILE} here yet`, "Run `deploy` without -y once to set it up.");
    p.log.info(`No ${PROJECT_FILE} in this folder, let's set it up`);
    cfg = await initWizard(cwd);
    saveProject(cwd, cfg);
    p.log.success(`Saved ${PROJECT_FILE}`);
  } else if (values.edit) {
    cfg = await editMenu(cwd, cfg);
    saveProject(cwd, cfg);
  }

  if (!values.yes) {
    while (true) {
      p.note(summary(cfg), basename(cwd));
      if (await ask.confirm("Deploy with these settings?", true)) break;
      cfg = await editMenu(cwd, cfg);
      saveProject(cwd, cfg);
    }
  }

  await runDeploy(cwd, cfg, { yes: !!values.yes });
}

function printLastLog(cwd: string) {
  const name = loadProject(cwd)?.name ?? basename(cwd);
  const dir = join(LOGS_DIR, name);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".log")) : [];
  if (!files.length) {
    console.log(`No deploy logs for "${name}" yet.`);
    return;
  }
  const latest = files.sort((a, b) => statSync(join(dir, b)).mtimeMs - statSync(join(dir, a)).mtimeMs)[0]!;
  console.log(pc.dim(`${join(dir, latest)}\n`));
  console.log(readFileSync(join(dir, latest), "utf8"));
}

main().catch((e) => {
  if (e instanceof CancelledError) {
    p.cancel("Cancelled");
    process.exit(130);
  }
  const msg = e instanceof Error ? e.message : String(e);
  record(`[error] ${msg}${e instanceof DeployError && e.hint ? `\n${e.hint}` : ""}`);
  p.log.error(pc.red(msg));
  if (e instanceof DeployError && e.hint) p.log.message(pc.dim(e.hint));
  else if (!(e instanceof DeployError) && process.env.DEBUG && e instanceof Error) console.error(e.stack);
  p.outro(pc.red("Deploy failed"));
  process.exit(1);
});
