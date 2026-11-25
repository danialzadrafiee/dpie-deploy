#!/usr/bin/env bash
# Install the `deploy` CLI from the latest GitHub release.
#   curl -fsSL https://raw.githubusercontent.com/danialzadrafiee/dpie-deploy/main/scripts/install.sh | bash
set -euo pipefail

REPO="${DPIE_REPO:-danialzadrafiee/dpie-deploy}"
VERSION="${DPIE_VERSION:-latest}"

case "$(uname -s)" in
  Linux) os=linux ;;
  Darwin) os=darwin ;;
  *) echo "Unsupported OS: $(uname -s). On Windows use install.ps1" >&2; exit 1 ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch=x64 ;;
  aarch64 | arm64) arch=arm64 ;;
  *) echo "Unsupported CPU: $(uname -m)" >&2; exit 1 ;;
esac

if [ "$VERSION" = "latest" ]; then
  url="https://github.com/$REPO/releases/latest/download/deploy-$os-$arch"
else
  url="https://github.com/$REPO/releases/download/$VERSION/deploy-$os-$arch"
fi

dir="${DPIE_INSTALL_DIR:-$HOME/.local/bin}"
mkdir -p "$dir"
echo "Downloading $url"
curl -fL --progress-bar "$url" -o "$dir/deploy.tmp"
chmod +x "$dir/deploy.tmp"
mv "$dir/deploy.tmp" "$dir/deploy"
echo "Installed: $dir/deploy ($("$dir/deploy" --version))"

case ":$PATH:" in
  *":$dir:"*) ;;
  *)
    rc="$HOME/.bashrc"; [ -n "${ZSH_VERSION:-}" ] || [ "$(basename "${SHELL:-}")" = "zsh" ] && rc="$HOME/.zshrc"
    echo "export PATH=\"$dir:\$PATH\"" >> "$rc"
    echo "Added $dir to PATH in $rc. Open a new terminal or run: export PATH=\"$dir:\$PATH\""
    ;;
esac
