# Releasing Plania

Plania reaches a buyer as a numbered package, already built (PLA-I2-17). The buyer never gets the repository and
never builds anything.

```bash
pnpm release:pack                 # type-checks, builds the screen, writes release/plania-<version>.tar.gz and .sha256
pnpm release:pack --skip-build    # pack the dist/ui already built
pnpm notices                      # regenerate THIRD_PARTY_NOTICES after a dependency changes (--check to compare)
```

Before a release: bump `version` in `package.json` and add a `## <version>` entry to `CHANGELOG.md`, in plain Spanish
for the owner and the buyer (the screen shows it on Novedades, and the version in Plomería). The checkout must be
committed (`--allow-dirty` packs anyway, and the manifest then names no commit). `release/` is ignored by git.

What a package holds: the built screen (`dist/ui`), the server's TypeScript sources (`src/`, and `ui/src/lib/` whose
words and pure logic the server imports) run through `tsx`, which is a production dependency for that reason;
`deploy/devva/` (the devva engine's compose file and its README: Plania keeps its data in that engine, and there are
no migrations to ship), `vendor/devva-client/` (the devva client, which is not on npm), `kit/`, `prompts/`, `config/`,
`docs/templates/`; the scripts a buyer runs (start, install, service, restart, update, restore, the engine export's
load (`devva:load`), the owner-neutral data step (`devva:owner-neutral`), machine check, help report, uninstall, password and VAPID tools, project registration, kit, brief, and
`seed-org.ts`, which the first start imports); `package.json`
with only those scripts, `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `tsconfig.json`, `.env.example`, `README.md`,
`CHANGELOG.md`, `LICENSE`, a fresh `THIRD_PARTY_NOTICES`, `VERSION` and `release.json`. Never: tests, `spike/`,
`replay/`, the screen's other sources, build configs, `.env`, `node_modules`.

Dependencies are not in the archive: `@node-rs/argon2` and `esbuild` ship per-platform binaries, so one archive
serves every system and the buyer installs production dependencies from the lockfile it carries.

## The one-line installers

`scripts/bootstrap/install.sh` (macOS and Linux) and `scripts/bootstrap/install.ps1` (Windows) are what a buyer runs
(audit B2). The pack ships them inside the package and also writes them beside the archive, so `release/` holds
everything a download address serves:

```
release/install.sh
release/install.ps1
release/plania-<version>.tar.gz
release/plania-<version>.tar.gz.sha256
```

Each copy is stamped with the release's version. Where releases are downloaded from is a setting:
`PLANIA_DOWNLOAD_BASE` (an `http(s)` address, the folder that holds those files). Set when packing, it becomes the
installers' default address; set where an installer runs, it wins. Unset, the default is the latest GitHub Release,
`https://github.com/Jorg3L3on/plania/releases/latest/download`.

## Publishing a release (GitHub Releases)

Releases live on this repository's GitHub Releases. Bump `version` and `CHANGELOG.md`, merge, then push the tag:

```bash
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` runs on a `v*` tag. It first runs the clean-machine install
(`.github/workflows/install.yml`, below) on Linux; then it checks the tag names `package.json`'s
version, packs with `PLANIA_DOWNLOAD_BASE=https://github.com/Jorg3L3on/plania/releases/download/v<version>` and
uploads to the release:

| Asset | What |
|---|---|
| `plania-<version>.tar.gz`, `.sha256` | The package and its checksum. |
| `plania-latest.tar.gz`, `.sha256` | The same bytes under the fixed name every release carries. |
| `install.sh`, `install.ps1` | The installers, stamped with this version and this release's own address. |

The one-liners in the README read `https://github.com/Jorg3L3on/plania/releases/latest/download/install.sh` (and
`install.ps1`), which GitHub serves from the newest release. That installer downloads its own release's
`plania-<version>.tar.gz` from `releases/download/v<version>`, so an older release's installer keeps working after a
newer one is published. An installer with no stamped version (run from a checkout) downloads `plania-latest.tar.gz`
from `releases/latest/download`. For a given older version, run the installer with
`PLANIA_DOWNLOAD_BASE=https://github.com/Jorg3L3on/plania/releases/download/v<version>` and `--version <version>`.

## What an installer does

In order:

1. Picks the folder: `--dir` / `-Dir` / `PLANIA_DIR`, else asks, defaulting to `~/plania`. It refuses a folder that
   already holds an install (that is `pnpm update:plania`) or any other files.
2. Checks that Docker is installed and running: the devva engine that keeps Plania's data runs in it. Docker stays
   the owner's to install, so without it the installer stops with one sentence and a link before anything changes.
   Then it lists what the machine lacks, Node 22 or newer and git, asks once (`--yes` / `-Yes` / `PLANIA_YES=1` on
   Windows asks nothing) and installs it:

   | | Windows | macOS | Linux |
   |---|---|---|---|
   | Tool | winget (stops and says how to get it when missing) | Homebrew (stops and points at brew.sh when missing) | apt or dnf, with sudo unless root |
   | Node | `OpenJS.NodeJS.LTS` | `brew install node` | the distribution's `nodejs` when it is 22 or newer, else NodeSource's `setup_22.x` |
   | git | `Git.Git` | `brew install git` | `git` |

   After each install the script puts the new folders on its own PATH (the saved system and user PATH and the
   install folders on Windows, `brew shellenv` on macOS), so the next step finds `node` and `git`. Nothing is
   installed for Postgres: Plania's own data is not in one.
3. Downloads the package and its `.sha256`, and refuses a package that does not match. `--from <file>` (`-From`)
   installs a package already on the machine instead; its `.sha256` is checked when it sits beside it.
4. Unpacks the archive's `plania-<version>/` into the folder.
5. Gets the pnpm version `packageManager` names with `npm install -g` (per user on Windows, no administrator shell),
   or runs it through `npx` when a global install is not allowed. Never corepack: Node 25 and newer no longer ship it.
6. Runs `pnpm install --prod --frozen-lockfile`.
7. When nothing answers at `DEVVA_HOST`:`DEVVA_PORT` (default `127.0.0.1:2505`), starts the devva engine with
   `docker compose -f deploy/devva/compose.yml up -d`, with the token file `DEVVA_TOKEN_FILE` names (default
   `~/.config/plania/devva-token`), made there, readable by its owner only, when it is missing, and waits up to a minute
   for it. When Docker cannot start it (the engine's image is not on this machine, for one), it stops and says to start
   it as `deploy/devva/README.md` says and then run `pnpm plania:install` in the folder.
8. Runs `pnpm plania:install` (`--no-service` adds `--no-start`, `--no-open` keeps the browser closed; arguments after
   `--`, or `-InstallArgs`, are passed on, e.g. `--prefix plania_casa`). It checks the engine answers with the token,
   writes `.env` with the store's prefix and the engine's address, and starts Plania as a service.

Claude Code is not installed: it stays the owner's to install and sign in. The install command's machine check goes on
without it and names it again after the closing box; the screen's list (`/machine/falta`) keeps it required.

`install.ps1` is ASCII with no byte-order mark: Windows PowerShell 5.1 reads a file without one as ANSI, and a mark
breaks `irm | iex`. Its accented words are written `{a}`, `{o}`… and put back when printed. `test/bootstrap.test.ts`
parses both (`bash -n`, the PowerShell parser), checks the pack, and installs a stand-in package with `--from`
against a stand-in pnpm, with `PLANIA_BOOTSTRAP_SKIP_DEPS=1` so nothing is installed or started on the machine running
the tests (no Docker check, no engine).

## The clean-machine install in CI

`.github/workflows/install.yml` packs the release on Linux, then on an `ubuntu-latest` runner pulls the devva engine's
image, runs the real installer (`--from <package> --yes --no-open`), which starts the engine with Docker from the
package's compose file, checks that `http://localhost:3737/health/ui` answers, `/primer-arranque` serves the screen and
`.env` names the store's prefix, and runs `pnpm uninstall:plania --delete-data`. It runs on pushes to `jl/**`, on pull
requests that touch the installers, by hand, and before every release. Claude Code is not on the runner; the install
goes on without it, as it does for a person. The job sets `PLANIA_UNSUPPORTED_SKIP_CHECK=memory`: a comma-separated
list of machine-check items the install lets pass when they are missing. It exists for that job and is read only on a
GitHub Actions runner (`GITHUB_ACTIONS=true`), so it does nothing on a user's machine.

Only Linux runs it: GitHub's macOS runners have no Docker and its Windows runners run Windows containers only, so the
install on macOS and on Windows is tried by hand before a release (below). The engine's image is not public: set the
repository variable `DEVVA_IMAGE` to an image the runner can pull (on `ghcr.io`, the workflow's own token signs in).
Without it the job, and the test and canary jobs in `.github/workflows/ci.yml`, warn that they did not run; the
build in `ci.yml` (both type-checks and the screen, on Linux and macOS) runs either way.

To try a release before it is published:

```bash
pnpm release:pack
sh release/install.sh --from release/plania-<version>.tar.gz --dir /tmp/plania-try
```

By hand, on a machine with Node 22+, pnpm and Docker:

```bash
tar -xzf plania-0.1.0.tar.gz && cd plania-0.1.0
pnpm install --prod --frozen-lockfile
# the devva engine, once (deploy/devva/README.md): a token file, then
DEVVA_TOKEN_FILE=$HOME/.config/plania/devva-token docker compose -f deploy/devva/compose.yml up -d
pnpm plania:install --service
```

A package serves its `dist/ui` as shipped: the start-up rebuild (PLA-I46-1) only happens in a git checkout, and a
`release.json` at the root turns it off even when the folder sits inside another git repository.

## The manifest (`release.json`)

The update command (PLA-I2-8) reads this file; its format is a contract. `VERSION` holds the same version, alone.

| Field | Meaning |
|---|---|
| `format` | `1`. Bumped when a field changes meaning. |
| `name` | `"plania"`. |
| `version` | `package.json`'s version, `MAJOR.MINOR.PATCH`. The archive is `plania-<version>.tar.gz`, with `plania-<version>.tar.gz.sha256` beside it (`<hex>  <file name>`). |
| `commit` | The full commit packed, or `null` when packed with uncommitted changes. |
| `built_at` | ISO time the package was made. |
| `node` | The `engines.node` range it needs. |
| `migrations` | The last migration file it carries, so an update can tell whether it brings new ones. On the devva store there are no migrations, so it is `null`; the field stays for the format. |
| `kit` | `{ "<path under kit/>": "<sha256>" }` of every kit file as shipped (line endings normalised). The update tells the buyer's edits from the release's with it; a manifest without it makes the update keep every kit file that differs. |

`GET /health/ui` (no auth) returns `{ version: { version, commit, built_at, packaged }, ui, head }`; in a checkout
`version` comes from `package.json` and the HEAD commit, with `packaged: false`. `GET /api/release` (session) adds
`notes`, the CHANGELOG.

## Licence and product copy

`LICENSE` is a placeholder until the owner writes the text; `pnpm release:pack` warns while it is. Plania's copy may
say in plain text that Plania runs Claude Code. Plania's own name and logo never use Claude's or Anthropic's names or
marks, per Anthropic's published conditions for products built on Claude Code.
