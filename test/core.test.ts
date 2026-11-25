import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detect, defaultCommands } from "../src/detect.ts";
import { parseDotenv, ensureEnvFile } from "../src/env.ts";
import { parseGithubRemote } from "../src/git.ts";
import { commitMessage } from "../src/deploy.ts";
import { shq } from "../src/ssh.ts";

function fixture(files: Record<string, string>) {
  const dir = mkdtempSync(join(tmpdir(), "dpie-"));
  for (const [f, c] of Object.entries(files)) writeFileSync(join(dir, f), c);
  return dir;
}
const pkg = (deps: Record<string, string>, scripts: Record<string, string> = {}) => JSON.stringify({ dependencies: deps, scripts });

test("detects Next.js with pnpm", () => {
  const d = detect(fixture({ "package.json": pkg({ next: "16" }, { build: "next build", start: "next start" }), "pnpm-lock.yaml": "" }));
  expect(d.candidates[0]!.stack).toBe("nextjs");
  expect(d.packageManager).toBe("pnpm");
  expect(defaultCommands("nextjs", "pnpm", d)).toEqual({ install: "pnpm install", build: "pnpm run build", start: "pnpm run start -- -p $PORT" });
});

test("detects Vite, Hono, Express", () => {
  expect(detect(fixture({ "package.json": pkg({ vite: "7" }) })).candidates[0]!.stack).toBe("vite");
  expect(detect(fixture({ "package.json": pkg({ hono: "4" }), "bun.lock": "" })).packageManager).toBe("bun");
  expect(detect(fixture({ "package.json": pkg({ express: "5" }), "yarn.lock": "" })).candidates[0]!.stack).toBe("express");
});

test("Dockerfile + framework gives two candidates", () => {
  const d = detect(fixture({ "package.json": pkg({ next: "16" }), Dockerfile: "FROM node", "compose.yml": "" }));
  expect(d.candidates.map((c) => c.stack)).toEqual(["nextjs", "docker"]);
  expect(d.composeFile).toBe("compose.yml");
});

test("plain HTML", () => {
  const d = detect(fixture({ "index.html": "<h1>hi</h1>" }));
  expect(d.candidates[0]!.stack).toBe("html");
  expect(defaultCommands("html", "npm", d).install).toBe("");
});

test("dotenv parsing", () => {
  expect(parseDotenv(`# c\nA=1\nexport B="two words"\nC='x#y' \nD=val # comment\nE=\n bad line`)).toEqual({ A: "1", B: "two words", C: "x#y", D: "val", E: "" });
});

test("env file is cloned from .env when missing", () => {
  const dir = fixture({ ".env": "X=1\n" });
  expect(ensureEnvFile(dir, ".deploy.env")).toBe(true);
  expect(readFileSync(join(dir, ".deploy.env"), "utf8")).toBe("X=1\n");
  expect(ensureEnvFile(fixture({}), ".deploy.env")).toBe(false);
});

test("github remote parsing", () => {
  expect(parseGithubRemote("https://github.com/a/b.git")).toEqual({ owner: "a", repo: "b" });
  expect(parseGithubRemote("git@github.com:a/b-c.git")).toEqual({ owner: "a", repo: "b-c" });
  expect(parseGithubRemote("https://gitlab.com/a/b")).toBeNull();
});

test("commit message and shell quoting", () => {
  expect(commitMessage(new Date(2026, 10, 25, 14, 30))).toBe("dpie-deploy: 2026-11-25 14:30");
  expect(shq("it's")).toBe(`'it'\\''s'`);
});
