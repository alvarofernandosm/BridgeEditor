#!/usr/bin/env bash
# Instalador one-liner de BridgeEditor para Linux:
#   curl -fsSL https://raw.githubusercontent.com/alvarofernandosm/BridgeEditor/main/install.sh | bash
# En Debian/Ubuntu instala el .deb (pedirá sudo); en otras distros descarga el AppImage.
set -euo pipefail

REPO="alvarofernandosm/BridgeEditor"
API="https://api.github.com/repos/$REPO/releases/latest"

echo "Buscando la última versión de BridgeEditor…"
JSON=$(curl -fsSL "$API")

if command -v dpkg >/dev/null 2>&1; then
  URL=$(printf '%s' "$JSON" | grep -o 'https://[^"]*_amd64\.deb' | head -1)
  if [ -z "$URL" ]; then
    echo "No se encontró un .deb en el último release" >&2
    exit 1
  fi
  TMP=$(mktemp /tmp/bridge-editor-XXXX.deb)
  echo "Descargando $(basename "$URL")…"
  curl -fL --progress-bar "$URL" -o "$TMP"
  sudo dpkg -i "$TMP" || sudo apt-get -f install -y
  rm -f "$TMP"
  echo "✓ BridgeEditor instalado — búscalo en el menú de aplicaciones o corre: bridge-editor"
else
  URL=$(printf '%s' "$JSON" | grep -o 'https://[^"]*\.AppImage' | head -1)
  if [ -z "$URL" ]; then
    echo "No se encontró un AppImage en el último release" >&2
    exit 1
  fi
  OUT="$HOME/.local/bin/BridgeEditor.AppImage"
  mkdir -p "$(dirname "$OUT")"
  echo "Descargando $(basename "$URL")…"
  curl -fL --progress-bar "$URL" -o "$OUT"
  chmod +x "$OUT"
  echo "✓ Descargado en $OUT"
  echo "  Nota: en Ubuntu 24+ los AppImage requieren lanzarse con --no-sandbox"
fi
