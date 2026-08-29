#!/bin/bash
set -euo pipefail
root="$(cd "$(dirname "$0")/.." && pwd)"
src="$root/dist/desktop/linux-unpacked"
dest="${XDG_DATA_HOME:-$HOME/.local/share}/ezscreenshare"
bin="$HOME/.local/bin/ezscreenshare"

if [[ ! -x "$src/ezscreenshare" ]]; then
  echo "missing $src/ezscreenshare — run: pnpm dist:linux" >&2
  exit 1
fi

mkdir -p "$(dirname "$dest")" "$HOME/.local/bin"
rm -rf "$dest"
cp -a "$src" "$dest"
cp -f "$root/dist-linux-README.txt" "$dest/README.txt"

cat > "$bin" <<EOF
#!/bin/sh
exec "$dest/ezscreenshare" --no-sandbox "\$@"
EOF
chmod +x "$bin" "$dest/ezscreenshare"

echo "installed $bin"
echo "data      $dest"
echo "try:      ezscreenshare"
