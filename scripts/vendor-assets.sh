#!/usr/bin/env bash
# Vendoring des assets Kenney dans viz/public/vendor/kenney/ (dev uniquement, jamais exécuté chez l'utilisateur du plugin).
#
#   vendor-assets.sh <zip-mini-characters> <zip-furniture-kit>
#
# Les zips sont téléchargés à la main sur kenney.nl (le lien est signé et lié à une session : rien n'est téléchargé ici).
# Le script extrait UNIQUEMENT les fichiers listés ci-dessous, vérifie qu'ils sont tous présents avant de toucher au
# dossier de destination, puis le reconstruit et réécrit SOURCE.md (une ligne par fichier avec son sha256).
# Prérequis : bash, unzip, sha256sum ou shasum.
# Si tu changes la liste, vois aussi viz/public/js/assets.js et tests/viz-web/kenney-assets.test.mjs.
set -euo pipefail

PACK_VERSION="2.0"
CHARACTERS_URL="https://kenney.nl/assets/mini-characters"
FURNITURE_URL="https://kenney.nl/assets/furniture-kit"

# Dossiers internes aux zips.
CHARACTERS_ZIP_DIR="Models/GLB format"
FURNITURE_ZIP_DIR="Models/GLTF format"

# 7 personnages : chef de projet, architecte, vérificateur, testeur, puis 3 développeurs.
CHARACTERS=(
  character-male-a
  character-female-a
  character-male-b
  character-female-b
  character-male-c
  character-female-c
  character-male-d
)
# Une quinzaine de meubles et éléments de décor.
FURNITURE=(
  desk
  chairDesk
  computerScreen
  computerKeyboard
  laptop
  doorway
  wall
  wallWindow
  floorFull
  table
  bookcaseOpen
  pottedPlant
  kitchenCoffeeMachine
  trashcan
  lampSquareCeiling
)

usage() {
  echo "Usage: $0 <zip-mini-characters> <zip-furniture-kit>" >&2
  echo "Les zips sont à télécharger à la main : $CHARACTERS_URL et $FURNITURE_URL" >&2
}

[ "$#" -eq 2 ] || { usage; exit 2; }
CHARS_ZIP="$1"
FURN_ZIP="$2"

for zip in "$CHARS_ZIP" "$FURN_ZIP"; do
  [ -f "$zip" ] || { echo "ERREUR: zip introuvable : $zip" >&2; exit 1; }
done
command -v unzip >/dev/null 2>&1 || { echo "ERREUR: unzip est introuvable dans le PATH." >&2; exit 1; }

if command -v sha256sum >/dev/null 2>&1; then
  sha() { sha256sum "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  sha() { shasum -a 256 "$1" | cut -d' ' -f1; }
else
  echo "ERREUR: ni sha256sum ni shasum dans le PATH." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="$ROOT/viz/public/vendor/kenney"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
STAGE="$WORK/stage"
mkdir -p "$STAGE/characters/Textures" "$STAGE/furniture" "$WORK/one"

# Extrait un fichier du zip vers une destination, ou s'arrête en nommant le fichier manquant.
extract() { # <zip> <chemin dans le zip> <destination>
  local zip="$1" inner="$2" out="$3"
  rm -f "$WORK/one/$(basename "$inner")"
  unzip -qq -o -j "$zip" "$inner" -d "$WORK/one" >/dev/null 2>&1 || true
  if [ ! -f "$WORK/one/$(basename "$inner")" ]; then
    echo "ERREUR: fichier absent de $(basename "$zip") : $inner" >&2
    exit 1
  fi
  mv "$WORK/one/$(basename "$inner")" "$out"
}

for name in "${CHARACTERS[@]}"; do
  extract "$CHARS_ZIP" "$CHARACTERS_ZIP_DIR/$name.glb" "$STAGE/characters/$name.glb"
done
extract "$CHARS_ZIP" "$CHARACTERS_ZIP_DIR/Textures/colormap.png" "$STAGE/characters/Textures/colormap.png"
extract "$CHARS_ZIP" "License.txt" "$STAGE/LICENSE-mini-characters.txt"
for name in "${FURNITURE[@]}"; do
  extract "$FURN_ZIP" "$FURNITURE_ZIP_DIR/$name.glb" "$STAGE/furniture/$name.glb"
done
extract "$FURN_ZIP" "License.txt" "$STAGE/LICENSE-furniture-kit.txt"

# SOURCE.md : fichiers triés pour être reproductible.
{
  echo "# Assets Kenney vendorés"
  echo
  echo "Générés par \`scripts/vendor-assets.sh\`. Ne jamais modifier ces fichiers à la main (ADR 0010)."
  echo
  echo "- Mini Characters $PACK_VERSION (CC0) : $CHARACTERS_URL"
  echo "- Furniture Kit $PACK_VERSION (CC0) : $FURNITURE_URL"
  echo "- Version des packs : $PACK_VERSION"
  echo "- Date du vendoring : $(date +%Y-%m-%d)"
  echo
  echo "## Fichiers (chemin relatif, sha256)"
  echo
  (cd "$STAGE" && find . -type f | LC_ALL=C sort | while read -r f; do
    f="${f#./}"
    echo "- \`$f\` $(sha "$f")"
  done)
} > "$WORK/SOURCE.md"

# Tout est prêt : on remplace le contenu du dossier.
mkdir -p "$DEST"
rm -rf "$DEST/characters" "$DEST/furniture" "$DEST"/LICENSE-*.txt "$DEST/SOURCE.md"
mv "$STAGE/characters" "$STAGE/furniture" "$DEST/"
mv "$STAGE"/LICENSE-*.txt "$DEST/"
mv "$WORK/SOURCE.md" "$DEST/SOURCE.md"

echo "OK: ${#CHARACTERS[@]} personnages et ${#FURNITURE[@]} meubles vendorés dans $DEST"
