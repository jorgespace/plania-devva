# Plania

Plania is the owner's plan server: the source of the plan for him and his agents. One Hono process on
Node serves a JSON API, an MCP server (`POST /mcp`) and a React screen, over a devva engine (`deploy/devva/`), its only store. A runner
starts headless `claude -p` runs for roles (product owner, research, artist, Taller, QA, Asistente…)
that read and write the plan through the MCP tools.

This file is a map. The detail is in [README.md](README.md), [GLOSSARY.md](GLOSSARY.md) and `docs/`.

## Run, test, type-check

Node 22 or newer, pnpm through corepack, and a devva engine running in Docker (`deploy/devva/README.md`). This is the
`plania-devva` branch: there is no Postgres for Plania's own data, no SQL and no migrations.

| To | macOS / Linux | Windows (PowerShell) |
|---|---|---|
| Install | `corepack enable pnpm; pnpm install` | the same |
| Dev: API on 3738, screen on 5173 | `pnpm dev` | the same |
| Type-check the server | `pnpm exec tsc --noEmit` | the same |
| Type-check the screen | `pnpm exec tsc -p ui` | the same |
| Test (needs a devva engine) | `pnpm test` | the same |
| One test file | `node --import tsx --test test/<name>.test.ts` | the same |
| Build (both type-checks, then the screen) | `pnpm build` | the same |

- Scripts set their variables through `scripts/with-env.mjs`, never a POSIX `VAR=value` prefix, so they start
  from any shell. Keep it that way.
- Tests use the devva engine that `DEVVA_HOST`, `DEVVA_PORT` and `DEVVA_TOKEN_FILE` name (the server's defaults:
  `127.0.0.1:2505`, `~/.config/plania/devva-token`). Each test file writes to lobes of its own, `t_<hash of the
  checkout and the file>`, emptied before it runs and when it ends (`resetTestStore()` in `test/helpers.ts`). Two
  runs of the same file in the same checkout at once collide.
- Tests of a product's own Postgres (test copies, the Máquina inventory, Camino's migration count) use the local
  Postgres and skip when none answers; `PLANIA_TEST_PGUSER` names the role (on Windows it defaults to `postgres`).
- A few tests depend on macOS or Unix tools (file modes, `lsof`, `ps`, the gitleaks binary) and fail on
  Windows. Check a failure against `main` before treating it as yours. A new test like that skips with its
  reason: `{ skip: needs({ posix: true }) }` from `test/platform.ts`.
- `.gitattributes` keeps every text file LF. A checkout made before it may still hold CRLF files: run
  `git add --renormalize .` and check out again (`git rm -r --cached -q . && git reset -q --hard` on a clean tree).
- `.env` comes from `.env.example`; README "Setup by hand" lists every variable.

## Where things live

| Area | Path |
|---|---|
| App wiring, the event bus | `src/app.ts`, `src/events.ts` |
| MCP tools, the protocol text, the error list | `src/mcp/` (`register.ts`, `protocol.ts`, `errors.ts`) |
| The runner: runs, roles, limits, deny rules, the QA lane | `src/runner/` |
| JSON routes for the screen | `src/api/` |
| The store: the port, the devva adapter, defaults, the rows every store starts with | `src/store/` (`types.ts`, `port.ts`, `devva.ts`, `seed.ts`) |
| The tables, columns and defaults (a description; nothing runs it as SQL) | `src/db/schema.ts` |
| Background jobs: pollers, audit, backup, push | `src/jobs/` |
| Stills, El Probador, test copies | `src/captures/` |
| Requests, Preguntar, idea frames | `src/pedidos/` |
| Morning brief | `src/brief/`, `prompts/morning-brief/` |
| Login, sessions, tokens | `src/auth/` |
| What runs on the Mac, env files | `src/maquinas/`, `src/mcp/footprint.ts` |
| The diff scanner | `src/lib/scan/`, `config/plania-gitleaks.toml` |
| Screen: pages, components, pure logic and words | `ui/src/pages/`, `ui/src/components/`, `ui/src/lib/` |
| Scripts: dev server, install, update, restore, data steps the owner runs, generators | `scripts/` |
| Tests, lobes of their own per test file | `test/` (`helpers.ts` sets them up) |
| The agents' kit: role prompts, skills, context templates | `kit/` (start at `kit/README.md`) |
| Decisions already made | `docs/adr/` |

## Rules with no exceptions

1. **Never touch the owner's store.** Tests only ever use `t_*` lobe prefixes; never open the prefix `plania` (or the
   one `PLANIA_DEVVA_PREFIX` names in `.env`), never run install, update, restore or uninstall against this machine's
   real setup, and never touch a Postgres database named `plania`.
2. **There are no migrations; data changes are applied by the owner.** A new table or column goes into
   `src/db/schema.ts` (a default the store must fill, in `src/store/defaults.ts`); rows every store needs, into
   `src/store/seed.ts`. A change to data already stored is a step in `scripts/devva-*.ts` (see
   `src/store/owner-neutral.ts`), safe to run twice, run by the owner, never by an agent on a real store.
3. **Never push to `main`, never merge.** Work on a branch and open a pull request.
4. **Nothing for Plania goes into a product repo**: no `CLAUDE.md`, no agent files, no hooks, no CI.
   What agents need reaches a run from Plania.
5. **No secrets in git.** `.env` stays local; `adapter_config` holds variable names, never values.
6. **A human-only question is never answered by an agent**, and no agent merges or ships a release.
7. **When an MCP tool or an error changes, regenerate the README tables**: `pnpm mcp-table` and
   `pnpm error-catalog`. `test/readme.test.ts` fails otherwise.
8. **When the protocol text changes meaning, bump `PROTOCOL_VERSION`** in `src/mcp/protocol.ts`.
9. **Words the owner reads are plain Spanish.** Code, comments, commits and docs are English. No
   ticket keys, branch names or the word sandbox in text meant for the screen.
10. **A change to what agents know goes through `kit/`**, after a failure seen in a real run, never
    as an edit made only on the live server.

## Conventions worth knowing before you edit

- Every write goes through `writeTx` (`src/mcp/tx.ts`): one serialized store write, one event per task touched,
  and the screen updates from those events. A write that belongs to no project goes through `writeVia` with
  `COMPANY` (`src/runner/limits.ts`). Never start a write from inside another: it waits on the lock the first holds.
- Reads and writes go through the store port only (`readerOf`, `uowOf`, `storeOf` in `src/store/port.ts`): no SQL,
  no Drizzle queries. The store enforces keys and plain unique rules only: foreign-key cascades
  (`deleteCascading` in `src/runner/delete-project.ts`), partial unique indexes and the checks a write can break are
  done in code.
- Errors are codes from `src/mcp/errors.ts`, returned inside the tool result; a new failure gets a new
  code there, not a free-text message.
- Dates are the server's. Tools refuse typed dates.
- Tests inject every outside call (git, `gh`, the Claude process, the clock). A test that needs the
  network or a real `claude` is wrong.
- Comments carry the ticket that explains them (`PLA-I46-9`, `AUDIT-1`). Keep them when you move code.
- The screen's column rules and wording live in `ui/src/lib/` and are tested without a browser.

## Read next

| For | Go to |
|---|---|
| Setup, env variables, the store | README "Install", "Setup by hand", "Store", [deploy/devva/README.md](deploy/devva/README.md) |
| Dev commands, the test engine, the diff scan | [docs/developers.md](docs/developers.md), [docs/scan-diff.md](docs/scan-diff.md) |
| Packing a release, the one-line installers, upgrade notes | [docs/releasing.md](docs/releasing.md), [docs/upgrading.md](docs/upgrading.md) |
| Running as a service, backups, updating, restoring | README "Running locally as a service", "Updating", "Restoring a backup" |
| Every MCP tool and every error code | README "MCP" (generated tables) |
| How an agent's loop goes, and proposals | [docs/bot-protocol.md](docs/bot-protocol.md), `src/mcp/protocol.ts` |
| The screen, the phone, the JSON API | README "Screen", [docs/phone-access.md](docs/phone-access.md) |
| What a product repo holds for Plania (nothing) | README "In a product repo" |
| Plania's own words | [GLOSSARY.md](GLOSSARY.md) |
| Why things are the way they are | [docs/adr/](docs/adr/README.md) |
