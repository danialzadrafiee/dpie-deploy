export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a local command and capture its output. Never throws for non-zero exit; check `code`. */
export async function run(
  cmd: string[],
  opts: { cwd?: string; input?: string; env?: Record<string, string>; onOutput?: (chunk: string) => void } = {},
): Promise<RunResult> {
  let proc;
  try {
    proc = Bun.spawn(cmd, {
      cwd: opts.cwd,
      stdin: opts.input !== undefined ? new TextEncoder().encode(opts.input) : "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", ...opts.env },
    });
  } catch (e) {
    return { code: 127, stdout: "", stderr: (e as Error).message };
  }
  const collect = async (stream: ReadableStream<Uint8Array>) => {
    let out = "";
    const dec = new TextDecoder();
    for await (const chunk of stream) {
      const text = dec.decode(chunk, { stream: true });
      out += text;
      opts.onOutput?.(text);
    }
    return out;
  };
  const [stdout, stderr] = await Promise.all([collect(proc.stdout), collect(proc.stderr)]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

export async function has(bin: string) {
  return Bun.which(bin) !== null;
}
