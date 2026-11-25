# dpie-deploy

CLI (`deploy`) that detects a project's stack and deploys it to Vercel (via GitHub) or a server over SSH. See README.md for behavior and layout.

- Runtime/tooling: Bun. Run from source with `bun src/index.ts`, test with `bun test`, typecheck with `bunx tsc --noEmit`, build the standalone binary with `bun run build`.
- All user-facing text is English only.
- Secrets are intentionally stored in plain text (`~/.deploy/config.json`, server passwords in `deploy.json`). Don't add encryption or keychain logic. Tokens stay out of `deploy.json` only so GitHub push protection doesn't block pushes.
- Vercel deploys must go through GitHub (push, then follow the deployment Vercel creates). Never upload files directly to Vercel.
- Server deploys never install software on the server. Check, report what's missing, and stop.
- Ideas for later live in README.md under "Future ideas". Add new ones there.
