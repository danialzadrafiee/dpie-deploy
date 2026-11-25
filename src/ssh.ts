import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Socket } from "node:net";
import SSHConfig from "ssh-config";
import { Client, type ConnectConfig } from "ssh2";
import type { ServerConn } from "./config.ts";
import { DeployError } from "./ui.ts";

export const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Concrete (non-wildcard) hosts from ~/.ssh/config, resolved to connection details. */
export function sshConfigHosts(): ServerConn[] {
  const file = join(homedir(), ".ssh", "config");
  if (!existsSync(file)) return [];
  let cfg: ReturnType<typeof SSHConfig.parse>;
  try {
    cfg = SSHConfig.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const aliases: string[] = [];
  for (const line of cfg as any[]) {
    if (line.param?.toLowerCase() !== "host") continue;
    const vals: string[] = Array.isArray(line.value) ? line.value.map((v: any) => v.val) : [line.value];
    const alias = vals.find((v) => !/[*?!]/.test(v));
    if (alias) aliases.push(alias);
  }
  return aliases.map((alias) => {
    const c = cfg.compute(alias) as Record<string, any>;
    const identity = Array.isArray(c.IdentityFile) ? c.IdentityFile[0] : c.IdentityFile;
    return {
      name: alias,
      host: c.HostName ?? alias,
      port: Number(c.Port ?? 22),
      user: c.User ?? "root",
      auth: "key" as const,
      keyPath: identity ?? defaultKey() ?? undefined,
    };
  });
}

export function defaultKey(): string | null {
  for (const k of ["id_ed25519", "id_ecdsa", "id_rsa"]) {
    const p = join(homedir(), ".ssh", k);
    if (existsSync(p)) return `~/.ssh/${k}`;
  }
  return null;
}

export class Remote {
  private client = new Client();
  private constructor(public conn: ServerConn) {}

  static async connect(conn: ServerConn): Promise<Remote> {
    const r = new Remote(conn);
    const cfg: ConnectConfig = {
      host: conn.host,
      port: conn.port,
      username: conn.user,
      readyTimeout: 20_000,
      keepaliveInterval: 10_000,
    };
    if (conn.auth === "password") {
      cfg.password = conn.password;
      cfg.tryKeyboard = true;
    } else {
      const key = conn.keyPath ? expandHome(conn.keyPath) : null;
      if (key && existsSync(key)) cfg.privateKey = readFileSync(key);
      if (process.env.SSH_AUTH_SOCK) cfg.agent = process.env.SSH_AUTH_SOCK;
      else if (process.platform === "win32") cfg.agent = "pageant";
      if (!cfg.privateKey && !cfg.agent) throw new DeployError(`SSH key not found: ${conn.keyPath}`);
    }
    await new Promise<void>((resolve, reject) => {
      r.client
        .on("ready", () => resolve())
        .on("keyboard-interactive", (_n, _i, _l, prompts, finish) => finish(prompts.map(() => conn.password ?? "")))
        .on("error", (e) => reject(new DeployError(`SSH connection to ${conn.user}@${conn.host}:${conn.port} failed`, e.message)))
        .connect(cfg);
    });
    return r;
  }

  /**
   * Run a bash script on the server. Output is streamed through `onOutput`.
   * A login shell is used and common Node version managers are loaded so `node`, `pnpm`, `pm2` etc. are on PATH.
   */
  exec(script: string, onOutput?: (chunk: string) => void): Promise<{ code: number; output: string }> {
    const prelude = [
      'export NVM_DIR="$HOME/.nvm"; [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1',
      'command -v fnm >/dev/null 2>&1 && eval "$(fnm env)" >/dev/null 2>&1',
      'export PATH="$HOME/.bun/bin:$HOME/.local/share/pnpm:$HOME/.local/bin:$HOME/.volta/bin:/usr/local/bin:$PATH"',
    ].join("\n");
    const full = `${prelude}\n${script}`;
    const cmd = `bash -lc ${shq(full)}`;
    return new Promise((resolve, reject) => {
      this.client.exec(cmd, (err, stream) => {
        if (err) return reject(err);
        let output = "";
        const on = (d: Buffer) => {
          const s = d.toString("utf8");
          output += s;
          onOutput?.(s);
        };
        stream.on("data", on);
        stream.stderr.on("data", on);
        stream.on("close", (code: number | null) => resolve({ code: code ?? 0, output }));
      });
    });
  }

  async upload(content: string | Buffer, remotePath: string) {
    await new Promise<void>((resolve, reject) => {
      this.client.sftp((err, sftp) => {
        if (err) return reject(err);
        const ws = sftp.createWriteStream(remotePath, { mode: 0o600 });
        ws.on("close", () => {
          sftp.end();
          resolve();
        });
        ws.on("error", reject);
        ws.end(content);
      });
    });
  }

  close() {
    this.client.end();
  }
}

/** Single-quote a string for bash. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

/** Try a plain TCP connection from this machine. */
export function tcpReachable(host: string, port: number, timeoutMs = 5000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (v: boolean) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
    s.connect(port, host);
  });
}
