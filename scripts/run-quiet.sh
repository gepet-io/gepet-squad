#!/usr/bin/env bash
# Lance une commande sans inonder le contexte de l'agent : le log complet va dans un fichier, la sortie
# affichée se limite au verdict, aux lignes d'erreur et à la fin du log.
#
#   bash run-quiet.sh '<commande>'      une commande (chaîne passée à bash -c, depuis le répertoire courant)
#   bash run-quiet.sh --ci              chaque commande de ci.commands (.gepet-squad.json), dans l'ordre,
#                                       à la racine du repo ; une ligne « <commande> → OK | ÉCHEC » par commande
#
# Variables : GEPET_LOG_DIR (dossier des logs, défaut : $TMPDIR/gepet-squad-logs),
#             GEPET_QUIET_LINES (lignes d'erreur affichées au plus, défaut 30).
# Code de sortie : celui de la commande ; avec --ci, 0 si tout passe, 1 sinon ; 2 : usage.
set -uo pipefail

LOG_DIR="${GEPET_LOG_DIR:-${TMPDIR:-${TEMP:-/tmp}}/gepet-squad-logs}"
MAX_LINES="${GEPET_QUIET_LINES:-30}"
# Motifs d'échec usuels (tests, lint, compilateurs), insensibles à la casse.
PATTERN='(fail|error|erreur|exception|panic|assert|traceback|✗|❌|not ok|fatal)'

usage() {
  echo "usage : bash run-quiet.sh '<commande>' | bash run-quiet.sh --ci" >&2
  exit 2
}

mkdir -p "$LOG_DIR" 2>/dev/null || LOG_DIR="$(mktemp -d)"

# run_one <commande> : lance, journalise, résume. Retourne le code de la commande.
run_one() {
  local cmd="$1" log start end code
  log="$(mktemp "$LOG_DIR/run-XXXXXX.log" 2>/dev/null || echo "$LOG_DIR/run-$$-$RANDOM.log")"
  start=$(date +%s)
  bash -c "$cmd" >"$log" 2>&1
  code=$?
  end=$(date +%s)
  # Sans codes ANSI, pour que les motifs et la fin du log restent lisibles.
  sed -i 's/\x1b\[[0-9;]*[A-Za-z]//g' "$log" 2>/dev/null || true
  if [ "$code" -eq 0 ]; then
    echo "$cmd → OK ($((end - start)) s) — log : $log"
    tail -n 3 "$log" | sed 's/^/  | /'
  else
    echo "$cmd → ÉCHEC (code $code, $((end - start)) s) — log : $log"
    local hits
    hits=$(grep -inE "$PATTERN" "$log" | head -n "$MAX_LINES")
    if [ -n "$hits" ]; then
      echo "  lignes d'erreur (au plus $MAX_LINES) :"
      echo "$hits" | cut -c1-300 | sed 's/^/  | /'
    fi
    echo "  fin du log :"
    tail -n 15 "$log" | cut -c1-300 | sed 's/^/  | /'
  fi
  return "$code"
}

[ $# -ge 1 ] || usage

if [ "$1" = "--ci" ]; then
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  cd "$root" || exit 2
  if [ ! -f .gepet-squad.json ]; then
    echo "run-quiet : .gepet-squad.json absent de $root" >&2
    exit 2
  fi
  # Commandes séparées par NUL : une commande peut contenir n'importe quel caractère imprimable.
  mapfile -d '' cmds < <(node -e '
    const c = JSON.parse(require("fs").readFileSync(".gepet-squad.json", "utf8"));
    const list = c.ci && Array.isArray(c.ci.commands) ? c.ci.commands : [];
    process.stdout.write(list.filter((s) => typeof s === "string" && s.trim() !== "").map((s) => s + "\0").join(""));
  ')
  if [ "${#cmds[@]}" -eq 0 ]; then
    echo "run-quiet : ci.commands est vide" >&2
    exit 2
  fi
  failed=0
  for c in "${cmds[@]}"; do
    run_one "$c" || failed=$((failed + 1))
  done
  echo "CI locale : $(( ${#cmds[@]} - failed ))/${#cmds[@]} commandes OK"
  [ "$failed" -eq 0 ]
  exit $?
fi

[ $# -eq 1 ] || usage
run_one "$1"
