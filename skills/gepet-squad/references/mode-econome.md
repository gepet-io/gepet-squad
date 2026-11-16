# Mode économe : suivi local en Markdown

Actif quand `.gepet-squad.json` contient `"mode": "econome"` (mode proposé **par défaut** au démarrage d'un projet). Le projet ne consomme **rien** sur GitHub : ni repo créé, ni labels, ni milestones, ni issues, ni PR, ni commentaires, ni workflow GitHub Actions, ni package. Tout vit dans le dépôt Git local : le code sur les branches habituelles, le suivi dans `docs/squad/`, en fichiers Markdown que le Chef de projet (CP) et les agents se passent par leur **chemin**.

Sans `"mode"`, ou avec `"mode": "normal"`, ce fichier ne s'applique pas.

## Deux variantes : local ou hybride

`.gepet-squad.json` porte `"suivi": "local" | "hybride"` (clé absente : `local`). Le CP demande la variante en phase 0, en même temps que le mode.

| | Économe local (défaut) | Économe hybride |
|---|---|---|
| Repo GitHub | aucun | oui, créé après accord comme en mode normal |
| Labels, milestones, issues | `docs/squad/etat.md` et fiches | sur GitHub, comme en mode normal |
| Branches, PR, merge | locales, merge squash local | poussées, PR vers `develop`, `gh pr merge` |
| Rapports des agents | fichiers `docs/squad/rapports/<ISSUE>/` | **fichiers** `docs/squad/rapports/<ISSUE>/` (jamais de commentaire de PR ni d'issue) |
| CI GitHub Actions, packages | aucun | aucun (`ci.mode` = `local`) |
| Push | aucun | branches de feature, `develop`, `release/*` |
| Release | branche locale, merge par l'utilisateur | PR `release/*` → `main`, merge par l'utilisateur |

**Hybride = mode normal, sauf trois points** : les rapports sont des fichiers Markdown (moins d'appels d'API, des PR sans bruit), aucun workflow ni package, et le CP commite les rapports sur `develop` (`git pull`, puis `git add docs/squad && git commit -m "docs(squad): rapports de #<n>"` et push) après chaque merge de feature. Missions : comme en mode normal (`REPO: <owner/repo>`, `ISSUE: <n>`, `PR: <n>`), plus `SUIVI`, et `RAPPORT` est un chemin. Bloc Flash : `PR: #<n>` réel, `Détail:` donne le chemin du fichier. Bootstrap : `bootstrap.sh <owner/repo> --hybride`. Le garde-fou y interdit `gh pr comment`, `gh issue comment` et `gh pr review`.

Tout le reste de ce fichier (`etat.md`, fiches, Git local, release locale, garde-fou sans push) ne concerne que la variante **locale**, sauf « Arborescence du suivi » pour le dossier `rapports/`. Dans `SKILL.md` et les agents, « mode économe » sans précision désigne la variante locale.

## Ce qui remplace GitHub

| Mode normal (GitHub) | Mode économe (local) |
|---|---|
| `gh auth`, repo GitHub | dépôt Git local (`git init -b main`) ; `gh` n'est jamais appelé |
| labels `status:*` et `retry:*` | colonnes `Statut` et `Retry` de `docs/squad/etat.md` (mêmes valeurs que les labels, sans préfixe) |
| milestones | tableau « Milestones » de `etat.md` (titres de `docs/roadmap.md`) |
| issue `#n` | fiche `docs/squad/features/F-xx-<slug>.md` ; l'identifiant reste `F-xx` |
| PR vers `develop` | branche locale `feature/F-xx-<slug>` + rapport `livraison.md` |
| commentaire de PR (rapport) | fichier `docs/squad/rapports/F-xx/<rapport>.md` |
| `gh pr merge --squash` | `git merge --squash` sur `develop`, par le CP |
| PR `release/*` → `main` | branche locale `release/m<k>-<slug>` + note `docs/squad/releases/m<k>-<slug>.md` ; l'utilisateur merge sur `main` lui-même |
| CI GitHub Actions | CI locale : `ci.commands`, toujours active (`"ci": { "mode": "local" }`) |
| `git push` | **aucun push** : l'utilisateur pousse lui-même s'il le souhaite |

Le hook garde-fou bloque, dans un projet économe, `git push` et les commandes `gh` qui écrivent sur GitHub.

## Arborescence du suivi

```
docs/squad/
  etat.md                         tableau de bord : seul le CP l'écrit
  features/F-01-<slug>.md         une fiche par feature (l'équivalent d'une issue)
  rapports/F-01/
    livraison.md                  développeur, MODE IMPLEMENTATION
    blocage.md                    développeur BLOQUÉ (au lieu d'un commentaire d'issue)
    verification-t1.md            vérificateur, tentative 1
    tests-t1.md                   testeur, tentative 1
    correctifs-t1.md              développeur, correctif du rapport d'échec de la tentative 1
  releases/m1-<slug>.md           note de release (l'équivalent du corps de PR de release)
```

- Le contenu de chaque rapport est **exactement** celui du « Contenu du commentaire de PR » de l'agent dans `report-formats.md`, précédé de sa ligne de titre (`# 🔍 Vérification — tentative 1 — PASS`). Une nouvelle tentative crée un nouveau fichier : on n'écrase jamais un rapport.
- `livraison.md` commence par le « Corps de PR de feature » de `github-conventions.md` (sans `Closes #n`), suivi du contenu « Développeur ».
- Le **chemin absolu** de `docs/squad` dans le checkout principal (celui du CP, sur `develop`) est transmis aux agents dans le champ `SUIVI`. Les agents lisent les fiches et écrivent leurs rapports **à ce chemin**, jamais dans leur worktree : ces fichiers ne vont jamais dans une branche de feature.
- Le vérificateur et le testeur n'ont pas d'outil d'écriture : ils écrivent leur rapport avec Bash (`cat > "<SUIVI>/rapports/F-xx/verification-t<k>.md" <<'EOF'`). C'est la seule écriture qui leur est permise.

## `docs/squad/etat.md`

Créé par le CP à la publication de la roadmap. Une ligne par feature, que le CP modifie avec `Edit` à chaque transition (une seule ligne à la fois). Il se lit sans tout charger : `grep -n "^| F-" docs/squad/etat.md`.

```markdown
# État du projet — <nom>

> Tenu par le Chef de projet uniquement. Statuts : backlog, ready, in-progress, in-review, in-test, changes-requested, blocked, done.

## Milestones
| Milestone | Statut | Release |
|---|---|---|
| M1 — Socle | en cours | — |
| M2 — <titre> | à venir | — |

## Features
| Feature | Titre | Milestone | Scope | Statut | Retry | Dépendances | Branche |
|---|---|---|---|---|---|---|---|
| F-01 | Initialiser l'API | M1 — Socle | api | ready | 0 | aucune | — |
| F-02 | Exposer la réservation | M1 — Socle | api | backlog | 0 | F-01 | — |
```

Statut d'un milestone : `à venir`, `en cours`, `release prête` (branche `release/*` créée, en attente du merge de l'utilisateur).

## Fiche de feature

`docs/squad/features/F-xx-<slug>.md` : la ligne `# F-xx · [<scope>] <titre>`, la ligne `Milestone: <titre>`, puis le corps complet de `feature-template.md`, dépendances écrites en `F-xx`. Le statut n'y figure **pas** : il n'existe que dans `etat.md`.

## Git en local

- Le CP travaille dans le checkout principal, sur `develop`, et n'en change pas (sauf pour créer la branche de release sans la quitter : `git branch release/m<k>-<slug> develop`).
- Les agents partent des **branches locales**, jamais de `origin/…` : `develop` au lieu de `origin/develop`, `feature/F-xx-<slug>` au lieu de `origin/feature/…`. Pas de `git fetch` ni de `git pull` : les worktrees partagent les branches du dépôt.
- Une branche ne peut être active que dans un seul worktree : le développeur termine toujours sa mission par `git switch --detach`, pour libérer sa branche (correctif suivant, merge du CP).
- Merge d'une feature par le CP, sur `develop` :
  ```bash
  git merge --squash feature/F-xx-<slug>
  git commit -m "<type>(<scope>): <titre> (F-xx)"
  git branch -D feature/F-xx-<slug>
  ```
  En cas de conflit, `git merge --abort` (ou `git reset --merge`), puis correctif du développeur (rebase sur `develop`).
- Le suivi se commite à part, par le CP seulement : `git add docs/squad docs/roadmap.md && git commit -m "docs(squad): <événement>"` (publication, merge d'une feature, escalade, release). Les changements de statut intermédiaires peuvent rester non commités jusqu'au prochain merge.

## Missions en mode économe

Mêmes missions qu'en mode normal (`SKILL.md`, phase 4), avec ces différences :

- `REPO: local` ;
- nouvelle ligne `SUIVI: <chemin absolu de docs/squad>`, juste après `REPO` ;
- `ISSUE: F-xx` (au lieu d'un numéro) ; la ligne `PR` est omise ; `BRANCHE: feature/F-xx-<slug>` ;
- `RAPPORT: <chemin absolu du fichier de rapport d'échec>` (au lieu d'une URL).

Les blocs « Output Flash » ne changent pas, sauf : `Issue: F-xx`, `PR: local`, et la ligne `Détail:` donne le **chemin absolu** du fichier de rapport.

## Release en mode économe

1. Toutes les features du milestone sont `done` dans `etat.md`.
2. Le CP rejoue chaque commande de `ci.commands` sur `develop` (règle de la CI locale). En cas d'échec : il le signale en une ligne et s'arrête. Il lance ensuite l'audit des dépendances (`tests-et-ci.md`) : une faille haute ou critique devient une nouvelle fiche et une ligne `ready` de `etat.md` dans le milestone courant, et la release attend son merge.
3. Il écrit `docs/squad/releases/m<k>-<slug>.md` (corps « PR de release » de `github-conventions.md`, avec la ligne CI locale et la section « Consommation » : sortie de `conso/cli.cjs` avec tous les `--milestone` et `--focus "<titre du milestone livré>"`, ou une ligne si la CLI échoue ou renvoie des `warnings`, sans jamais bloquer la release), passe le milestone en `release prête`, commite le suivi, puis crée la branche : `git branch release/m<k>-<slug> develop`.
4. Il donne à l'utilisateur les commandes à lancer lui-même (le garde-fou interdit à Claude de merger sur `main`) :
   ```bash
   git switch main
   git merge --no-ff release/m<k>-<slug>
   git switch develop
   ```
5. Il passe au milestone suivant sans attendre.

## Reprise et avancement

`/gepet-squad-resume` et `/gepet-squad-status` lisent `etat.md` (et les fichiers de `rapports/`) au lieu de GitHub. Une feature `in-progress` dont `rapports/F-xx/livraison.md` existe est traitée comme livrée ; le dernier rapport `FAIL` d'une feature est le fichier `verification-t<k>.md` ou `tests-t<k>.md` de plus grand `k` dont le titre finit par `FAIL`.

## Limites

- Pas de multi-repo : un projet économe est toujours un monorepo. Si l'architecture l'exige, l'architecte le signale et l'utilisateur choisit entre le monorepo et le mode normal.
- La vue `/gepet-squad-viz` montre les agents, mais pas les statuts des features (elle les lit sur GitHub).
- Aucune sauvegarde distante : le dépôt n'existe que sur la machine, tant que l'utilisateur ne pousse pas.
