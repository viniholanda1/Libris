#!/usr/bin/env bash
set -Eeuo pipefail

repo_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$repo_dir"

if [[ "$(git branch --show-current)" != "main" ]]; then
  echo "Execute este script na branch main." >&2
  exit 1
fi

stash_before="$(git rev-parse -q --verify refs/stash || true)"
git stash push --include-untracked -m "Libris pre-build $(date +%Y-%m-%d-%H%M%S)"
stash_after="$(git rev-parse -q --verify refs/stash || true)"
stash_ref=""
if [[ -n "$stash_after" && "$stash_after" != "$stash_before" ]]; then
  stash_ref="$stash_after"
fi

git pull origin main --rebase
if [[ -n "$stash_ref" ]]; then
  git stash pop "$stash_ref"
fi

sudo apt-get update && sudo apt-get install -y \
  libwebkit2gtk-4.1-dev \
  build-essential \
  curl \
  wget \
  file \
  libssl-dev \
  libdbus-1-dev \
  libxdo-dev \
  librsvg2-dev

if [[ -f "$HOME/.cargo/env" ]]; then
  source "$HOME/.cargo/env"
fi
if ! command -v cargo >/dev/null 2>&1; then
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
  source "$HOME/.cargo/env"
fi

command -v npm >/dev/null 2>&1 || {
  echo "npm não encontrado. Instale o Node.js e tente novamente." >&2
  exit 1
}

npm ci
npm run build:desktop

version="$(node -p "require('./package.json').version")"
package="src-tauri/target/release/bundle/deb/Libris_${version}_amd64.deb"
archive="versoes/${version}/Libris_${version}_amd64.deb"
if [[ ! -f "$package" ]]; then
  echo "Pacote Debian não encontrado: $package" >&2
  exit 1
fi

mkdir -p "versoes/${version}"
cp "$package" "$archive"
dpkg-deb --info "$archive"
printf 'Build concluído: %s/%s\n' "$repo_dir" "$archive"
