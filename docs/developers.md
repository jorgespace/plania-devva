# Developing Plania

## Stack

- App: Hono on Node, one long-lived process on this machine (`scripts/dev.ts`, run as a service).
- Store: a devva engine on this machine (`deploy/devva/`). Every write is one record in a commit log; the server
  keeps the rows in memory, rebuilt from that log at start (`src/store/devva.ts`). There is no SQL database and there
  are no migrations: `src/db/schema.ts` names the tables, their columns and defaults. Code reads and writes through
  the store port (`src/store/`). `pg` is used only for other projects' Postgres databases (test copies, the Máquina
  inventory).
- Screen: React SPA (Vite, shadcn/ui) in `ui/`, served by the same app; password login (argon2id + `plania_session` cookie).
- Agents: `POST /mcp` with `Authorization: Bearer <token>`: an agent token issued on screen (`/tokens`), or the
  static `MCP_BEARER_TOKEN` / `MCP_READ_TOKEN` from `.env`.
- CI: `POST /hooks/*` with `Authorization: Bearer <PLANIA_CI_TOKEN>`.

## Dev commands

```bash
pnpm dev     # API on 3738 (tsx watch) + Vite on http://localhost:5173 with hot reload
pnpm build   # typecheck server and UI, then build the SPA into dist/ui
pnpm start   # serve API, MCP and the built SPA on http://localhost:3737
pnpm test    # MCP, API, live-event, hooks, seed and backup tests; needs a running devva engine
```

Port 3737 avoids the 3000 that product repos use. The server only listens on 127.0.0.1.
In dev, Vite proxies `/api` and `/mcp` to the dev API on 3738, so the service on 3737 keeps running.

Tests use the devva engine that `DEVVA_HOST`, `DEVVA_PORT` and `DEVVA_TOKEN_FILE` name (the same defaults as the
server: `127.0.0.1:2505`, `~/.config/plania/devva-token`). Each test file writes to lobes of its own, named `t_` plus a
hash of the checkout's path and the file, and empties them before and after (`test/helpers.ts` `resetTestStore`), so
test runs in different worktrees can run at the same time and never touch the `plania` lobes. Tests of the install,
the restore and the uninstall use throwaway prefixes of their own and empty them too. The engine cannot drop a lobe,
so empty lobes stay behind: use a throwaway engine for tests (its own compose project and volume, another
`DEVVA_PORT` and token file) if they bother you in the real one. With `SEXTANT_URL` set, one search test uses real
embeddings. One crash test restarts the engine and runs only when `DEVVA_TEST_CONTAINER` names its container.

Tests of another project's Postgres database (a product's test copy, the Máquina inventory) still need a local
Postgres, and skip with their reason when none answers.

### Scanning a diff for personal data and secrets

`pnpm scan:diff` is a scan you can run on a diff before merging. It reports; it does not block anything. Flags, the JSON report, the local hash file, and the gitleaks pin are in [docs/scan-diff.md](scan-diff.md).

```bash
pnpm scan:diff <repo-path> [base]
pnpm scan:diff --json <repo-path> --base main --head HEAD
```

It prints `file:line` and a rule id. It does not print the matched value. Exit 0 when there are no findings, 1 when there is at least one, 2 when the scan does not finish (usage, git, or gitleaks). The allowlist is `~/.config/plania/scan-allowlist` or `PLANIA_SCAN_ALLOWLIST`: a literal value, `/regex/`, or `path:` entry per line.
