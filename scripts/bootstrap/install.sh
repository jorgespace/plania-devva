#!/bin/sh
# PLA-I2-4 (audit B2): install Plania on macOS or Linux from one line, without corepack, on a brand-new machine.
#   curl -fsSL https://github.com/Jorg3L3on/plania/releases/latest/download/install.sh | sh
#   curl -fsSL <same address> | sh -s -- --dir ~/otra-carpeta
#   sh install.sh --from plania-0.1.0.tar.gz          a package already on this machine, nothing downloaded
#   sh install.sh [options] -- --prefix plania_casa   everything after -- goes to pnpm plania:install
# Options: --dir <folder> (default ~/plania, or PLANIA_DIR), --version <x.y.z> (or PLANIA_VERSION), --from <file>
# (or PLANIA_FROM), --no-service, --no-open (no browser at the end), --yes (ask nothing, install what is missing).
# Steps: install what the machine lacks (Node 22+, git) after one question, check that Docker is there (Plania keeps
# its data in a devva engine that runs in it), get the release and check its .sha256, unpack it, get the pnpm its
# package.json pins (npm; npx when a global install is not allowed), `pnpm install --prod --frozen-lockfile`, start
# the devva engine with Docker when it does not answer (deploy/devva/, with a token file made here when there is none),
# then `pnpm plania:install`, which starts Plania as a service.
# Downloads come from PLANIA_DOWNLOAD_BASE (default: the latest GitHub Release). pnpm release:pack stamps the
# release's version into DEFAULT_VERSION; with no version the installer takes plania-latest.tar.gz, which every
# release carries. Another version: PLANIA_DOWNLOAD_BASE=https://github.com/Jorg3L3on/plania/releases/download/v<x.y.z>.
set -eu

DEFAULT_VERSION=""
DEFAULT_BASE="https://github.com/Jorg3L3on/plania/releases/latest/download"

say() { printf '%s\n' "$*"; }
fail() { printf 'Plania: %s\n' "$*" >&2; exit 1; }

dir="${PLANIA_DIR:-}"
version="${PLANIA_VERSION:-$DEFAULT_VERSION}"
from="${PLANIA_FROM:-}"
base="${PLANIA_DOWNLOAD_BASE:-$DEFAULT_BASE}"
service=1
ask=1
open=1
while [ $# -gt 0 ]; do
  case "$1" in
    --dir) [ $# -ge 2 ] || fail "--dir necesita una carpeta."; dir="$2"; shift 2 ;;
    --version) [ $# -ge 2 ] || fail "--version necesita un número."; version="$2"; shift 2 ;;
    --from) [ $# -ge 2 ] || fail "--from necesita un archivo."; from="$2"; shift 2 ;;
    --no-service) service=0; shift ;;
    --no-open) open=0; shift ;;
    --yes|-y) ask=0; shift ;;
    --help|-h) sed -n '2,15p' "$0" 2>/dev/null || true; exit 0 ;;
    --) shift; break ;;
    *) fail "No conozco la opción $1." ;;
  esac
done
[ "$open" = 1 ] || set -- --no-open "$@"
if [ -n "$from" ]; then
  [ -f "$from" ] || fail "No encuentro el paquete $from."
  from="$(cd "$(dirname "$from")" && pwd)/$(basename "$from")"
fi

can_ask() { { : </dev/tty; } 2>/dev/null; }

# 1. The folder: --dir, PLANIA_DIR, or asked (default ~/plania). Checked before anything is installed.
if [ -z "$dir" ]; then
  dir="$HOME/plania"
  if [ "$ask" = 1 ] && can_ask; then
    printf 'Carpeta donde instalar Plania [%s]: ' "$dir" >/dev/tty
    read -r answer </dev/tty || answer=""
    [ -n "$answer" ] && dir="$answer"
  fi
fi
case "$dir" in "~"|"~/"*) dir="$HOME${dir#\~}" ;; esac
if [ -e "$dir" ]; then
  [ -f "$dir/release.json" ] && fail "Plania ya está instalado en $dir. Para pasar a otra versión, desde esa carpeta: pnpm update:plania <paquete>."
  [ -d "$dir" ] || fail "$dir ya existe y no es una carpeta. Elige otra con --dir."
  [ -z "$(ls -A "$dir")" ] || fail "La carpeta $dir no está vacía. Elige otra con --dir."
fi

work="$(mktemp -d "${TMPDIR:-/tmp}/plania-install.XXXXXX")"
trap 'rm -rf "$work"' EXIT INT TERM

# 2. What this machine lacks: Node 22+ and git, installed after one question (none with --yes), and Docker, where
# the devva engine runs: Docker is the owner's to install, so its absence stops the install before anything changes.
# PLA-I2-4 (from zero): Claude Code stays the owner's to install and sign in; the install says so.
node_ok() { command -v node >/dev/null 2>&1 && [ "$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)" -ge 22 ]; }
docker_ok() { command -v docker >/dev/null 2>&1 && docker info >/dev/null 2>&1; }
os="$(uname -s)"
need_node=0
need_git=0
need_docker=0
node_ok || need_node=1
git --version >/dev/null 2>&1 || need_git=1
docker_ok || need_docker=1
# test/bootstrap.test.ts only: nothing is installed or started on the machine running the tests.
if [ "${PLANIA_BOOTSTRAP_SKIP_DEPS:-}" = 1 ]; then need_node=0; need_git=0; need_docker=0; fi
if [ "$need_docker" = 1 ]; then
  if command -v docker >/dev/null 2>&1; then
    fail "Docker está instalado pero no responde: enciéndelo (en Mac, abre Docker Desktop; en Linux, sudo systemctl start docker) y vuelve a correr esta línea."
  fi
  fail "Falta Docker: ahí corre el motor devva, donde Plania guarda sus datos. Instálalo (https://docs.docker.com/get-docker/) y vuelve a correr esta línea."
fi

missing=""
add_missing() { missing="${missing:+$missing, }$1"; }
[ "$need_node" = 0 ] || add_missing "Node 22"
[ "$need_git" = 0 ] || add_missing "git"

brew=""
SUDO=""
pm=""
if [ -n "$missing" ]; then
  case "$os" in
    Darwin)
      for b in "$(command -v brew 2>/dev/null || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do
        if [ -n "$b" ] && [ -x "$b" ]; then brew="$b"; break; fi
      done
      if [ -z "$brew" ]; then
        say "A esta Mac le falta: $missing."
        say "Para instalarlo hace falta Homebrew: instálalo con la línea que da https://brew.sh y vuelve a correr esta línea."
        exit 1
      fi
      ;;
    Linux)
      if command -v apt-get >/dev/null 2>&1; then pm=apt
      elif command -v dnf >/dev/null 2>&1; then pm=dnf
      else fail "A esta máquina le falta: $missing. Instálalo con el gestor de paquetes de tu sistema y vuelve a correr esta línea."
      fi
      if [ "$(id -u)" != 0 ]; then
        command -v sudo >/dev/null 2>&1 || fail "A esta máquina le falta: $missing, y para instalarlo hace falta sudo."
        SUDO="sudo"
      fi
      ;;
    *) fail "A esta máquina le falta: $missing. Instálalo y vuelve a correr esta línea." ;;
  esac
  say "A esta máquina le falta: $missing."
  if [ "$ask" = 1 ]; then
    can_ask || fail "Vuelve a correr la línea con --yes para instalarlo, o instálalo tú."
    printf '¿Lo instalo ahora? Puede pedir la contraseña de tu computadora. [S/n] ' >/dev/tty
    read -r answer </dev/tty || answer=""
    case "$answer" in [nN]*) say "No se instaló nada."; exit 1 ;; esac
  fi
fi

# Homebrew's folders in this script's PATH, so the next step finds what was just installed.
brew_path() {
  eval "$("$brew" shellenv)"
  hash -r 2>/dev/null || true
}
# A package manager's output only when it fails.
quiet() {
  if "$@" >"$work/step.log" 2>&1; then return 0; fi
  tail -n 20 "$work/step.log" >&2
  return 1
}
apt_updated=0
apt_update() {
  [ "$apt_updated" = 1 ] && return 0
  quiet $SUDO apt-get update -q || fail "apt-get update falló."
  apt_updated=1
}
apt_install() { quiet $SUDO env DEBIAN_FRONTEND=noninteractive apt-get install -y -q "$@" || fail "apt-get no pudo instalar $*."; }
dnf_install() { quiet $SUDO dnf install -y -q "$@" || fail "dnf no pudo instalar $*."; }
fetch() { # <url> <file>
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "Falta curl o wget para bajar Plania."
  fi
}

if [ "$need_node" = 1 ]; then
  say "Instalando Node..."
  case "$os" in
    Darwin)
      "$brew" install node >/dev/null || fail "Homebrew no pudo instalar Node."
      brew_path
      ;;
    Linux)
      if [ "$pm" = apt ]; then
        apt_update
        cand="$(apt-cache policy nodejs 2>/dev/null | sed -n 's/^ *Candidate: *\([0-9]*\).*/\1/p' | head -n 1)"
        if [ -n "$cand" ] && [ "$cand" -ge 22 ] 2>/dev/null; then
          apt_install nodejs npm
        else
          # The distribution's Node is older: NodeSource's Node 22 package, which carries npm.
          apt_install ca-certificates curl gnupg
          fetch https://deb.nodesource.com/setup_22.x "$work/nodesource.sh" || fail "No se pudo bajar el instalador de Node (deb.nodesource.com)."
          quiet $SUDO bash "$work/nodesource.sh" || fail "No se pudo agregar el repositorio de Node (deb.nodesource.com)."
          apt_install nodejs
        fi
      else
        cand="$(dnf -q info nodejs 2>/dev/null | sed -n 's/^Version *: *\([0-9]*\).*/\1/p' | sort -n | tail -n 1)"
        if [ -n "$cand" ] && [ "$cand" -ge 22 ] 2>/dev/null; then
          dnf_install nodejs npm
        else
          fetch https://rpm.nodesource.com/setup_22.x "$work/nodesource.sh" || fail "No se pudo bajar el instalador de Node (rpm.nodesource.com)."
          quiet $SUDO bash "$work/nodesource.sh" || fail "No se pudo agregar el repositorio de Node (rpm.nodesource.com)."
          dnf_install nodejs
        fi
      fi
      hash -r 2>/dev/null || true
      ;;
  esac
  node_ok || fail "Node se instaló pero no responde como Node 22 o más nuevo. Abre una terminal nueva y vuelve a correr esta línea."
fi

if [ "$need_git" = 1 ]; then
  say "Instalando git..."
  case "$os" in
    Darwin)
      "$brew" install git >/dev/null || fail "Homebrew no pudo instalar git."
      brew_path
      ;;
    Linux)
      if [ "$pm" = apt ]; then apt_update; apt_install git; else dnf_install git; fi
      ;;
  esac
fi

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else node -e 'const h=require("crypto").createHash("sha256");h.update(require("fs").readFileSync(process.argv[1]));console.log(h.digest("hex"))' "$1"
  fi
}
check_sha() { # <archive> <sha256 file>
  want="$(cut -d' ' -f1 <"$2" | tr 'A-F' 'a-f' | head -n 1)"
  got="$(sha256_of "$1")"
  [ "$want" = "$got" ] || fail "El paquete no coincide con su .sha256: puede estar dañado o no ser el publicado. No se instaló nada."
  say "El paquete coincide con su .sha256."
}

# 3. The package: --from, or downloaded with its .sha256 (required).
if [ -n "$from" ]; then
  archive="$from"
  if [ -f "$from.sha256" ]; then check_sha "$archive" "$from.sha256"
  else say "Sin $(basename "$from").sha256 al lado: se instala sin comprobarlo."
  fi
else
  # No version: plania-latest.tar.gz, which every release carries beside plania-<version>.tar.gz.
  name="plania-${version:-latest}.tar.gz"
  say "Bajando Plania ${version:-(la última versión)}..."
  fetch "${base%/}/$name" "$work/$name" || fail "No se pudo bajar ${base%/}/$name."
  fetch "${base%/}/$name.sha256" "$work/$name.sha256" || fail "No se pudo bajar ${base%/}/$name.sha256, así que no se puede comprobar el paquete."
  archive="$work/$name"
  check_sha "$archive" "$work/$name.sha256"
fi

# 4. Unpack: the archive holds one folder, plania-<version>.
command -v tar >/dev/null 2>&1 || fail "Falta tar para abrir el paquete."
mkdir -p "$work/unpack"
tar -xzf "$archive" -C "$work/unpack" || fail "No se pudo abrir el paquete."
inner=""
for d in "$work/unpack"/plania-*; do [ -d "$d" ] && inner="$d"; done
[ -n "$inner" ] && [ -f "$inner/package.json" ] || fail "El paquete no tiene la carpeta plania-<versión> que se espera."
mkdir -p "$(dirname "$dir")"
if [ -d "$dir" ]; then rmdir "$dir"; fi
mv "$inner" "$dir"
say "Plania quedó en $dir."
cd "$dir"

# 5. pnpm, the version package.json pins. No corepack: Node 25 and newer do not ship it.
want_pnpm="$(node -p 'String(require("./package.json").packageManager || "").replace(/^pnpm@/, "").replace(/\+.*$/, "")')"
[ -n "$want_pnpm" ] || fail "package.json no dice qué versión de pnpm usar."
pnpm_cmd=""
if command -v pnpm >/dev/null 2>&1 && [ "$(pnpm --version 2>/dev/null)" = "$want_pnpm" ]; then
  pnpm_cmd="pnpm"
else
  say "Instalando pnpm $want_pnpm con npm..."
  if npm install -g "pnpm@$want_pnpm" >/dev/null 2>&1; then
    prefix="$(npm prefix -g)"
    if [ -x "$prefix/bin/pnpm" ]; then pnpm_cmd="$prefix/bin/pnpm"; else pnpm_cmd="pnpm"; fi
  else
    say "npm no pudo instalar pnpm para todo el sistema; se usa con npx, sin instalarlo."
    pnpm_cmd="npx --yes pnpm@$want_pnpm"
  fi
fi

# 6. Dependencies from the lockfile.
say "Instalando lo que Plania necesita..."
# shellcheck disable=SC2086
$pnpm_cmd install --prod --frozen-lockfile || fail "pnpm install falló. Corre pnpm help:report en $dir y manda el informe."

# 7. The devva engine, where Plania keeps its data (deploy/devva/README.md). When nothing answers at DEVVA_HOST and
# DEVVA_PORT (default 127.0.0.1:2505), it is started here with Docker from the package's compose file, with the token
# file DEVVA_TOKEN_FILE names (default ~/.config/plania/devva-token), made here, readable by its owner only, when it
# is not there. The install command then checks it answers with that token and writes where it is into .env.
engine_host="${DEVVA_HOST:-127.0.0.1}"
engine_port="${DEVVA_PORT:-2505}"
engine_answers() {
  node -e 'const s=require("net").connect(Number(process.argv[2]),process.argv[1]);s.setTimeout(3000);s.on("connect",()=>process.exit(0));s.on("error",()=>process.exit(1));s.on("timeout",()=>process.exit(1))' "$engine_host" "$engine_port" 2>/dev/null
}
if [ "${PLANIA_BOOTSTRAP_SKIP_DEPS:-}" != 1 ] && ! engine_answers; then
  token_file="${DEVVA_TOKEN_FILE:-$HOME/.config/plania/devva-token}"
  if [ ! -s "$token_file" ]; then
    (umask 077 && mkdir -p "$(dirname "$token_file")" && od -An -tx1 -N24 /dev/urandom | tr -d ' \n' >"$token_file") || fail "No se pudo escribir la clave del motor devva en $token_file."
  fi
  DEVVA_TOKEN_FILE="$token_file"
  export DEVVA_TOKEN_FILE
  say "Encendiendo el motor devva con Docker..."
  quiet docker compose -f "$dir/deploy/devva/compose.yml" up -d || fail "Docker no pudo encender el motor devva. Enciéndelo como dice $dir/deploy/devva/README.md y luego, en $dir, corre: pnpm plania:install"
  i=0
  until engine_answers; do
    i=$((i + 1))
    [ "$i" -lt 60 ] || fail "El motor devva no responde en $engine_host:$engine_port. Enciéndelo como dice $dir/deploy/devva/README.md y luego, en $dir, corre: pnpm plania:install"
    sleep 1
  done
  say "El motor devva quedó encendido."
fi

# 8. The install command (the store, .env, the service).
# The install command starts Plania as a service by default; --no-service tells it not to (--no-start).
[ "$service" = 1 ] || set -- --no-start "$@"
# Under `curl … | sh` this shell's stdin is the script itself, so the install command would see no terminal. It reads
# the terminal instead when there is one.
if [ "$ask" = 1 ] && can_ask; then
  # shellcheck disable=SC2086
  $pnpm_cmd plania:install "$@" </dev/tty || exit 1
else
  # shellcheck disable=SC2086
  $pnpm_cmd plania:install "$@" || exit 1
fi
