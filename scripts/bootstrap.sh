#!/usr/bin/env bash
# Bootstrap idempotent d'un repo pour la squad gepet.
#
#   bootstrap.sh <owner/repo>          repo principal (le répertoire courant doit être son clone)
#                                      → labels, main + develop, .gepet-squad.json
#   bootstrap.sh <owner/repo> --sub    sous-repo en multi-repo (aucun clone local requis)
#                                      → branche develop créée via l'API GitHub
#   bootstrap.sh <owner/repo> --hybride mode économe hybride : comme le repo principal, mais
#                                      .gepet-squad.json en econome + suivi hybride, sans CI ni package
#   bootstrap.sh --local <nom>         mode économe : aucun appel à GitHub, aucun push
#                                      → main + develop locales, .gepet-squad.json en mode econome
set -euo pipefail

if [ "${1:-}" = "--local" ]; then
  NAME="${2:?usage: bootstrap.sh --local <nom-du-projet>}"
  git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERREUR: le répertoire courant n'est pas un repo Git (git init -b main)" >&2; exit 1; }

  # main avec au moins un commit
  if ! git rev-parse --verify --quiet HEAD >/dev/null; then
    git switch -c main --quiet 2>/dev/null || true
    [ -f README.md ] || printf '# %s\n' "$NAME" > README.md
    git add README.md
    git commit --quiet -m "chore: initial commit"
    echo "main: commit initial"
  fi
  git show-ref --verify --quiet refs/heads/main || git branch main
  if git show-ref --verify --quiet refs/heads/develop; then
    git switch --quiet develop
    echo "develop: déjà présente"
  else
    git switch --quiet -c develop main
    echo "develop: créée depuis main"
  fi

  if [ ! -f .gepet-squad.json ]; then
    cat > .gepet-squad.json <<EOF
{
  "version": 1,
  "mode": "econome",
  "repo": "local",
  "name": "$NAME",
  "layout": "monorepo",
  "scopes": {},
  "branches": { "integration": "develop", "production": "main" },
  "maxParallelDevs": 3,
  "maxRetries": 3,
  "ci": { "mode": "local", "commands": [] }
}
EOF
    git add .gepet-squad.json
    git commit --quiet -m "chore(squad): initialise la configuration gepet-squad (mode économe)"
    echo ".gepet-squad.json: créé (mode économe)"
  else
    echo ".gepet-squad.json: déjà présent"
  fi
  echo "OK: $NAME prêt en local (branche courante: develop, aucun remote utilisé)"
  exit 0
fi

REPO="${1:?usage: bootstrap.sh <owner/repo> [--sub|--hybride] | bootstrap.sh --local <nom>}"
MODE="${2:-main}"

gh auth status >/dev/null 2>&1 || { echo "ERREUR: gh n'est pas authentifié. Lancez: gh auth login" >&2; exit 1; }

ensure_develop_remote() {
  if gh api "repos/$REPO/branches/develop" >/dev/null 2>&1; then
    echo "develop: déjà présente"
    return
  fi
  local sha
  sha=$(gh api "repos/$REPO/git/ref/heads/main" --jq .object.sha 2>/dev/null) \
    || { echo "ERREUR: $REPO n'a pas de branche main avec au moins un commit" >&2; exit 1; }
  gh api "repos/$REPO/git/refs" -f ref=refs/heads/develop -f sha="$sha" >/dev/null
  echo "develop: créée depuis main"
}

if [ "$MODE" = "--sub" ]; then
  ensure_develop_remote
  echo "OK: sous-repo $REPO prêt"
  exit 0
fi

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || { echo "ERREUR: le répertoire courant n'est pas un repo Git" >&2; exit 1; }

# --- Labels -------------------------------------------------------------------
label() { gh label create "$1" --repo "$REPO" --color "$2" --description "$3" --force >/dev/null; }
label "status:backlog"           d4d4d4 "Dépendances non mergées"
label "status:ready"             0e8a16 "Prête à être développée"
label "status:in-progress"       1d76db "Un développeur travaille dessus"
label "status:in-review"         5319e7 "PR ouverte, chez le vérificateur"
label "status:in-test"           fbca04 "Vérification PASS, chez le testeur"
label "status:changes-requested" d93f0b "FAIL, correctifs en cours"
label "status:blocked"           b60205 "Escalade en cours"
label "status:done"              0b6e2b "Mergée sur develop"
label "type:feature"             c5def5 "Fonctionnalité"
label "type:tech"                c5def5 "Technique / socle"
label "type:infra"               c5def5 "Infrastructure / CI"
label "retry:1"                  f9d0c4 "1 échec de vérification ou de tests"
label "retry:2"                  f9d0c4 "2 échecs"
label "retry:3"                  f9d0c4 "3 échecs : escalade"
echo "labels: OK"

# --- main avec au moins un commit -----------------------------------------------
git fetch origin --quiet 2>/dev/null || true
if ! git ls-remote --exit-code --heads origin main >/dev/null 2>&1; then
  if ! git rev-parse --verify --quiet HEAD >/dev/null; then
    git switch -c main --quiet 2>/dev/null || true
    [ -f README.md ] || printf '# %s\n' "${REPO#*/}" > README.md
    git add README.md
    git commit --quiet -m "chore: initial commit"
  fi
  git push --quiet -u origin HEAD:main
  echo "main: poussée"
fi

# --- develop ------------------------------------------------------------------
ensure_develop_remote
git fetch origin --quiet
if git show-ref --verify --quiet refs/heads/develop; then
  git switch --quiet develop
  git pull --quiet --ff-only origin develop
else
  git switch --quiet -c develop --track origin/develop
fi

# --- .gepet-squad.json ----------------------------------------------------------
if [ "$MODE" = "--hybride" ]; then
  # Économe hybride : issues et PR sur GitHub, rapports en fichiers, ni CI ni package.
  MODE_LINES='  "mode": "econome",
  "suivi": "hybride",'
  TAIL_LINES='  "ci": { "mode": "local", "commands": [] }'
else
  MODE_LINES='  "mode": "normal",'
  TAIL_LINES='  "ci": { "mode": "release", "commands": [] },
  "packages": { "enabled": false }'
fi
if [ ! -f .gepet-squad.json ]; then
  cat > .gepet-squad.json <<EOF
{
  "version": 1,
$MODE_LINES
  "repo": "$REPO",
  "layout": "monorepo",
  "scopes": {},
  "branches": { "integration": "develop", "production": "main" },
  "maxParallelDevs": 3,
  "maxRetries": 3,
$TAIL_LINES
}
EOF
  git add .gepet-squad.json
  git commit --quiet -m "chore(squad): initialise la configuration gepet-squad"
  git push --quiet origin develop
  echo ".gepet-squad.json: créé"
else
  echo ".gepet-squad.json: déjà présent"
fi

echo "OK: $REPO prêt (branche courante: develop)"
