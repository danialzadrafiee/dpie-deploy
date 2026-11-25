import type { ProjectConfig } from "../config.ts";
import { tokenRemote } from "../github.ts";
import { Remote, shq, tcpReachable } from "../ssh.ts";
import { DeployError, log, pc, section, spin } from "../ui.ts";

type Server = NonNullable<ProjectConfig["server"]>;

export const processName = (name: string) => name.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-");

export async function connectServer(s: Server) {
  return spin(`Connecting to ${s.user}@${s.host}:${s.port}`, () => Remote.connect(s), () => `Connected to ${s.name} (${s.host})`);
}

/** Fail before pushing anything if the server is missing tools. Nothing is installed automatically. */
export async function checkPrerequisites(remote: Remote, cfg: ProjectConfig) {
  const s = cfg.server!;
  const needs: [string, string][] = [["git", "command -v git"]];
  if (s.runner === "pm2") {
    needs.push(["node", "command -v node"], ["pm2", "command -v pm2"]);
    const pm = cfg.packageManager;
    if (pm !== "npm") needs.push([pm, `command -v ${pm}`]);
    else needs.push(["npm", "command -v npm"]);
  } else {
    needs.push(["docker", "command -v docker"]);
    if (s.runner === "compose") needs.push(["docker compose", "docker compose version"]);
  }
  const script = needs.map(([n, c]) => `${c} >/dev/null 2>&1 || echo "MISSING:${n}"`).join("\n");
  const r = await spin("Checking server prerequisites", () => remote.exec(script), () => "Server has everything needed");
  const missing = [...r.output.matchAll(/MISSING:(.+)/g)].map((m) => m[1]!.trim());
  if (missing.length) {
    throw new DeployError(`Missing on the server: ${missing.join(", ")}`, "Install them on the server and run deploy again.");
  }
}

async function step(remote: Remote, title: string, script: string) {
  const out = section(title);
  const r = await remote.exec(`set -e\n${script}`, (c) => out.write(c));
  out.flush();
  if (r.code !== 0) throw new DeployError(`${title} failed on the server (exit ${r.code})`, "See the log above.");
}

export async function deployToServer(remote: Remote, cfg: ProjectConfig, githubToken: string, envText: string | null): Promise<string> {
  const s = cfg.server!;
  const { owner, repo, branch } = cfg.github;
  const dir = s.path;
  const url = tokenRemote(githubToken, owner, repo);
  const name = processName(cfg.name);
  const port = String(s.appPort);
  const sub = (cmd: string) => cmd.replaceAll("$PORT", port);

  await step(
    remote,
    `Sync code from GitHub → ${dir}`,
    `
if [ -d ${shq(dir + "/.git")} ]; then
  cd ${shq(dir)}
  git remote set-url origin ${shq(url)}
  git fetch --progress origin ${shq(branch)}
  git reset --hard ${shq("origin/" + branch)}
elif [ -e ${shq(dir)} ] && [ -n "$(ls -A ${shq(dir)} 2>/dev/null)" ]; then
  echo "${dir} exists and is not a git repo, refusing to overwrite it" >&2
  exit 1
else
  mkdir -p "$(dirname ${shq(dir)})"
  git clone --progress -b ${shq(branch)} ${shq(url)} ${shq(dir)}
  cd ${shq(dir)}
fi
echo "HEAD is now $(git log -1 --format='%h %s')"
`,
  );

  if (envText !== null) {
    await spin(`Uploading ${cfg.env.enabled ? cfg.env.file : ".env"} → ${dir}/.env`, () => remote.upload(envText, `${dir}/.env`));
  }

  if (s.runner === "pm2") {
    const { install, build, start } = s.commands;
    if (install) await step(remote, `Install (${install})`, `cd ${shq(dir)}\n${sub(install)}`);
    if (build) await step(remote, `Build (${build})`, `cd ${shq(dir)}\nexport PORT=${port}\n${sub(build)}`);
    await step(
      remote,
      `Start with pm2 as "${name}" on port ${port}`,
      `cd ${shq(dir)}
export PORT=${port}
pm2 delete ${shq(name)} >/dev/null 2>&1 || true
pm2 start ${shq(sub(start))} --name ${shq(name)} --cwd ${shq(dir)}
pm2 save >/dev/null
sleep 3
pm2 logs ${shq(name)} --lines 15 --nostream || true`,
    );
  } else if (s.runner === "compose") {
    await step(remote, "docker compose up", `cd ${shq(dir)}\nexport PORT=${port}\ndocker compose up -d --build --remove-orphans 2>&1\ndocker compose ps`);
  } else {
    const envFlag = envText !== null ? "--env-file .env" : "";
    await step(remote, `docker build → ${name}`, `cd ${shq(dir)}\ndocker build --progress=plain -t ${shq(name)} . 2>&1`);
    await step(
      remote,
      `docker run ${name} on port ${port}`,
      `cd ${shq(dir)}
docker rm -f ${shq(name)} >/dev/null 2>&1 || true
docker run -d --name ${shq(name)} --restart unless-stopped ${envFlag} -e PORT=${s.containerPort ?? port} -p ${port}:${s.containerPort ?? port} ${shq(name)}
sleep 3
docker logs --tail 15 ${shq(name)} 2>&1 || true`,
    );
  }

  await checkPort(remote, s.host, s.appPort);
  return `http://${s.host}:${s.appPort}`;
}

async function checkPort(remote: Remote, host: string, port: number) {
  const listening = await spin(
    `Waiting for the app to listen on port ${port}`,
    async () => {
      const r = await remote.exec(`for i in $(seq 1 30); do
  if (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | grep -qE "[:.]${port}\\s"; then echo LISTENING; exit 0; fi
  sleep 2
done
echo NOT_LISTENING`);
      return r.output.includes("LISTENING") && !r.output.includes("NOT_LISTENING");
    },
    (ok) => (ok ? `App is listening on port ${port} on the server` : `Nothing is listening on port ${port} on the server`),
  );
  if (!listening) {
    log.warn(`The app did not open port ${port}. Check the start command/port, or see the logs above.`);
    return;
  }
  const reachable = await spin(`Checking ${host}:${port} from this machine`, () => tcpReachable(host, port), (ok) => (ok ? `${host}:${port} is reachable from here` : `${host}:${port} is NOT reachable from here`));
  if (!reachable) {
    log.warn(`Port ${port} is open on the server but blocked from outside. Open it in the firewall, e.g. ${pc.cyan(`ufw allow ${port}/tcp`)}, or in your cloud provider's security group.`);
  }
}
