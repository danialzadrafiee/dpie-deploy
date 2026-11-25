import * as p from "@clack/prompts";
import pc from "picocolors";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export { p, pc };

/** When set, every line printed through this module is also appended (without ANSI codes) to this file. */
let logFile: string | null = null;

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function startLogFile(path: string) {
  mkdirSync(dirname(path), { recursive: true });
  logFile = path;
  record(`# dpie-deploy log ${new Date().toISOString()}`);
}

export function record(line: string) {
  if (!logFile) return;
  try {
    appendFileSync(logFile, stripAnsi(line) + "\n");
  } catch {
    /* logging must never break a deploy */
  }
}

export class DeployError extends Error {
  constructor(message: string, public hint?: string) {
    super(message);
  }
}

export class CancelledError extends Error {}

/** Unwrap a clack prompt result, aborting cleanly on Ctrl+C. */
export function ok<T>(value: T): Exclude<T, symbol> {
  if (p.isCancel(value)) throw new CancelledError("Cancelled");
  return value as Exclude<T, symbol>;
}

export const ask = {
  async text(message: string, opts: { initial?: string; placeholder?: string; required?: boolean } = {}) {
    return ok(
      await p.text({
        message,
        initialValue: opts.initial,
        placeholder: opts.placeholder,
        validate: (v) => (opts.required !== false && !v?.trim() ? "Required" : undefined),
      }),
    ).trim();
  },
  async secret(message: string) {
    return ok(await p.password({ message, validate: (v) => (!v?.trim() ? "Required" : undefined) })).trim();
  },
  async confirm(message: string, initial = true) {
    return ok(await p.confirm({ message, initialValue: initial }));
  },
  async select<T extends string>(message: string, options: { value: T; label: string; hint?: string }[], initial?: T) {
    return ok(await p.select<T>({ message, options: options as any, initialValue: initial })) as T;
  },
  async number(message: string, initial?: number) {
    const v = await ask.text(message, {
      initial: initial?.toString(),
    });
    const n = Number(v);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) throw new DeployError(`"${v}" is not a valid port`);
    return n;
  },
};

export const log = {
  info(msg: string) {
    p.log.info(msg);
    record(`[info] ${msg}`);
  },
  step(msg: string) {
    p.log.step(msg);
    record(`[step] ${msg}`);
  },
  success(msg: string) {
    p.log.success(msg);
    record(`[ok] ${msg}`);
  },
  warn(msg: string) {
    p.log.warn(msg);
    record(`[warn] ${msg}`);
  },
  error(msg: string) {
    p.log.error(msg);
    record(`[error] ${msg}`);
  },
};

/**
 * A titled section that streams raw output lines under a gutter, e.g.
 *   ◇  Build on server
 *   │  > next build
 *   │  ✓ Compiled successfully
 */
export function section(title: string) {
  const bar = pc.gray("│");
  p.log.step(pc.bold(title));
  record(`== ${title}`);
  let partial = "";
  const emit = (line: string) => {
    // Progress output (git, docker) redraws a line with \r; keep only its final state.
    const segs = line.split("\r").filter((x) => x.trim());
    const clean = segs[segs.length - 1] ?? "";
    process.stdout.write(`${bar}  ${pc.dim(clean)}\n`);
    record(`  ${clean}`);
  };
  return {
    /** Feed arbitrary chunks; complete lines are printed as they arrive. */
    write(chunk: string) {
      partial += chunk;
      const lines = partial.split("\n");
      partial = lines.pop() ?? "";
      for (const l of lines) emit(l);
    },
    line(text: string) {
      emit(text);
    },
    flush() {
      if (partial) emit(partial);
      partial = "";
    },
  };
}

export async function spin<T>(message: string, fn: () => Promise<T>, done?: (r: T) => string): Promise<T> {
  const s = p.spinner();
  s.start(message);
  record(`[..] ${message}`);
  try {
    const r = await fn();
    const msg = done ? done(r) : message;
    s.stop(msg);
    record(`[ok] ${msg}`);
    return r;
  } catch (e) {
    s.error(`${message} — failed`);
    throw e;
  }
}

export function fmtDuration(ms: number) {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}
