#!/usr/bin/env bash
# Vendoring de Three.js dans viz/public/vendor/three/ (dev uniquement, jamais exécuté chez l'utilisateur du plugin).
#
#   vendor-three.sh [version]      version de three à vendorer ; défaut : la version épinglée ci-dessous
#
# Récupère le paquet par `npm pack`, vérifie sa version, puis recopie :
#   build/three.module.js, build/three.core.js          → vendor/three/build/
#   les addons listés ci-dessous (avec leurs imports)    → vendor/three/addons/
#   LICENSE (MIT) et un fichier VERSION                  → vendor/three/
# Le dossier est reconstruit en entier : relancé avec la même version, le script ne produit aucune différence git.
# Prérequis : bash, npm, tar, node (déjà requis par le plugin).
# Si tu ajoutes un addon, ajoute-le aussi (avec ses imports relatifs) à la liste attendue de tests/viz-web/vendor.test.mjs.
set -euo pipefail

PINNED_VERSION="0.187.0"
VERSION="${1:-$PINNED_VERSION}"

# Chemins relatifs à examples/jsm/ : les 5 addons demandés, plus leurs imports internes.
ADDONS=(
  controls/OrbitControls.js
  renderers/CSS2DRenderer.js
  postprocessing/EffectComposer.js
  postprocessing/RenderPass.js
  postprocessing/ShaderPass.js
  postprocessing/UnrealBloomPass.js
  postprocessing/OutputPass.js
  postprocessing/Pass.js
  postprocessing/MaskPass.js
  shaders/CopyShader.js
  shaders/LuminosityHighPassShader.js
  shaders/OutputShader.js
)

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/viz/public/vendor/three"

for tool in npm tar node; do
  command -v "$tool" >/dev/null 2>&1 || { echo "ERREUR: $tool est introuvable dans le PATH." >&2; exit 1; }
done

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "Récupération de three@$VERSION (npm pack)…"
(cd "$WORK" && npm pack "three@$VERSION" --ignore-scripts --silent >/dev/null)
[ -f "$WORK/three-$VERSION.tgz" ] || { echo "ERREUR: archive three-$VERSION.tgz introuvable après npm pack." >&2; exit 1; }
(cd "$WORK" && tar -xzf "three-$VERSION.tgz")

PKG="$WORK/package"
ACTUAL="$(cd "$PKG" && node -p "require('./package.json').version")"
if [ "$ACTUAL" != "$VERSION" ]; then
  echo "ERREUR: version demandée $VERSION, version du paquet $ACTUAL." >&2
  exit 1
fi

# Tous les fichiers sources doivent exister avant de toucher au dossier de destination.
for file in build/three.module.js build/three.core.js LICENSE; do
  [ -f "$PKG/$file" ] || { echo "ERREUR: $file absent du paquet three@$VERSION." >&2; exit 1; }
done
for addon in "${ADDONS[@]}"; do
  [ -f "$PKG/examples/jsm/$addon" ] || { echo "ERREUR: addon $addon absent du paquet three@$VERSION." >&2; exit 1; }
done

rm -rf "$DEST"
mkdir -p "$DEST/build"
cp "$PKG/build/three.module.js" "$PKG/build/three.core.js" "$DEST/build/"
for addon in "${ADDONS[@]}"; do
  mkdir -p "$DEST/addons/$(dirname "$addon")"
  cp "$PKG/examples/jsm/$addon" "$DEST/addons/$addon"
done
cp "$PKG/LICENSE" "$DEST/LICENSE"
printf '%s\n' "$VERSION" > "$DEST/VERSION"

# Droits uniformes, pour que le résultat ne dépende ni de l'archive ni du système.
find "$DEST" -type f -exec chmod 644 {} +

echo "OK: three@$VERSION vendoré dans viz/public/vendor/three ($(find "$DEST" -type f | wc -l | tr -d ' ') fichiers)."
