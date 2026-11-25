# dpie-deploy

Type `deploy` in a project folder. The first run asks a few questions and saves the answers to `deploy.json`. Every run after that shows the saved settings and asks `Y/n`, then commits, pushes and ships.

- **Detects the stack**: Next.js, Vite, Hono, Express, Docker / docker compose, static HTML. It also picks up the package manager from the lockfile (npm / pnpm / yarn / bun).
- **GitHub first**: every deploy goes through GitHub. If the folder has no repo, it runs `git init` and creates a GitHub repo (private by default). Uncommitted changes are committed as `dpie-deploy: YYYY-MM-DD HH:mm` and pushed to `main`.
- **Vercel target**: only pushes to GitHub, and Vercel builds from there. If no Vercel project is linked to the repo, it creates one and links it. It syncs your env file to Vercel, then streams the Vercel build log live until the deployment is ready.
- **Server target (SSH)**: the server runs `git clone` (first time) or `git fetch && git reset --hard` (after that), gets your env file uploaded as `.env`, then installs, builds and starts. It can run the app with pm2, `docker compose` or `docker build + run`. When it's done it checks that the port is listening on the server and reachable from your machine.
- **Full logs**: every line is printed in the terminal and also saved to `~/.deploy/logs/<project>/<time>.log`.

## Install

Linux / WSL / macOS:

```bash
curl -fsSL https://raw.githubusercontent.com/danialzadrafiee/dpie-deploy/main/scripts/install.sh | bash
```

Windows (PowerShell):

```powershell
irm https://raw.githubusercontent.com/danialzadrafiee/dpie-deploy/main/scripts/install.ps1 | iex
```

These download a standalone binary from the latest GitHub release. Node and Bun are not needed.

From source (needs [Bun](https://bun.sh)):

```bash
bun install && bun run build   # → dist/deploy
```

## Usage

```
deploy              First run: set up this folder. Later runs: show saved settings, Y/n, deploy.
deploy -y           Deploy with saved settings, no questions (auto-commits changes)
deploy --edit       Change saved settings, then deploy
deploy --reset      Delete deploy.json and set this folder up from scratch
deploy logs         Print the log of the last deploy of this project
deploy --version
deploy --help
```

Answering `n` at the Y/n opens a menu where you change one part (project, GitHub, env, target) and keep the rest.

## Where things are stored

| File | Contents |
| --- | --- |
| `./deploy.json` | Everything about this project's deploy: stack, repo, target, server host/user/password or key path, path, port, commands. Tokens are **not** in here. |
| `~/.deploy/config.json` | GitHub token, Vercel token, and every server you've used (so you can pick it from a list next time). |
| `~/.deploy/logs/` | One log file per deploy. |

Why tokens aren't in `deploy.json`: if that file is committed, GitHub's secret scanning finds GitHub/Vercel tokens in it. It then rejects the push or revokes the token, and the deploy breaks.

### Where tokens come from

- **GitHub**: saved token → `gh auth token` → `git credential fill` → `$GITHUB_TOKEN` / `$GH_TOKEN` → asks you.
- **Vercel**: saved token → Vercel CLI login (`~/.local/share/com.vercel.cli/auth.json`; refreshed with `vercel whoami` when it expires) → `$VERCEL_TOKEN` → asks you.

### Env files

The wizard asks whether the project needs env vars at all. If it does, you pick `.env`, `.deploy.env`, or a custom file name. If the file you picked doesn't exist but `.env` does, `.env` is copied into it. On a server the file is uploaded as `.env`. On Vercel its variables are set for production, preview and development.

## Server notes

- Server choices: servers you've used before, every `Host` in `~/.ssh/config`, or a new one (password or key).
- Default path: `/projects/<project-name>`.
- Nothing gets installed on the server. If `git`, `node`, `pm2`, `docker` or the package manager is missing, deploy lists what's missing and stops before pushing.
- `$PORT` in the start command is replaced with the app port, and `PORT` is also exported.
- The server needs to reach GitHub. The clone URL includes your GitHub token, so private repos work.

## Development

```bash
bun install
bun src/index.ts --help   # run from source
bun test                  # unit tests
bunx tsc --noEmit         # typecheck
bun run build             # standalone binary → dist/deploy
```

Release: bump `version` in `package.json`, then `git tag v0.x.y && git push --tags`. The `release` workflow builds binaries for linux-x64/arm64, windows-x64 and darwin-x64/arm64, and attaches them to a GitHub Release.

```
src/
  index.ts          CLI entry, flags, Y/n loop
  wizard.ts         first-run questions, summary, edit menu
  deploy.ts         the pipeline: tokens → target preflight → commit/push → ship
  detect.ts         stack / package manager detection, default commands and ports
  config.ts         deploy.json and ~/.deploy/config.json
  github.ts git.ts  token discovery, repo creation, commit/push
  vercel.ts         Vercel API + token discovery
  ssh.ts            ssh2 client, ~/.ssh/config hosts, SFTP upload, port check
  env.ts            env file choice and parsing
  targets/          vercel.ts and server.ts deploy steps
  ui.ts             prompts, sections that stream logs, log file
```

## Future ideas

- **Multiple targets per project**, e.g. `staging` + `production` in one `deploy.json`, with `deploy staging`.
- **Dokploy** target.
- **Nginx + domain**: generate an nginx site config for the project and point a domain at it.
- **SSL** with certbot once a domain is set.
- **Install missing server tools** (node, pm2, docker, git) automatically.
- **More stacks**: Astro, Nuxt, SvelteKit, Remix, NestJS, Python (FastAPI/Django), Bun servers, monorepos (turbo / pnpm workspaces).
- **More targets**: Netlify, Cloudflare, Railway, Fly.io.
- **Vercel custom domains** from the wizard.
- **systemd** runner as an alternative to pm2.
- **Rollback**: `deploy rollback` checks out the previous commit on the server and restarts.
- **Health check URL**: after start, poll an HTTP path until it returns 200.
- **Notifications** (Telegram / Slack) when a deploy finishes or fails.
- **Self-update**: `deploy upgrade` downloads the latest release.
- **AI stack detection** for projects the rules don't recognize.
