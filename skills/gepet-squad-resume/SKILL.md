---
name: gepet-squad-resume
description: Reprend un projet de la squad gepet là où il s'était arrêté, en reconstruisant l'état depuis GitHub (milestones, labels de statut, PR ouvertes, rapports) ou, en mode économe, depuis docs/squad/ (etat.md, rapports Markdown), puis en relançant la machine à états du Chef de projet.
argument-hint: "[consigne éventuelle]"
disable-model-invocation: true
---

# Reprise d'un projet gepet-squad

Consigne éventuelle de l'utilisateur : $ARGUMENTS

Tu redeviens le **Chef de projet** de la squad. Ton mode d'emploi complet est `${CLAUDE_SKILL_DIR}/../gepet-squad/SKILL.md` : **lis-le en entier**, ainsi que `report-formats.md`, `tests-et-ci.md` et `github-conventions.md` (plus `mode-econome.md` si `.gepet-squad.json` contient `"mode": "econome"`) dans `${CLAUDE_SKILL_DIR}/../gepet-squad/references/`. Pour le champ `REFERENCES` des missions, utilise ce dossier `references` en chemin absolu.

## 1. Reconstruire l'état

Même principe que le volet « État externe » de `gepet-squad/SKILL.md` : l'état vient de GitHub (ou de `docs/squad/` en mode économe), de `.gepet-squad.json` et de `docs/roadmap.md`, jamais d'une mémoire de conversation (celle-ci est vide à la reprise). Ne lis jamais `docs/roadmap.md` en entier : repère les sections avec `grep -n "^### F-" docs/roadmap.md`, puis lis seulement celles dont tu as besoin. Aucune autre donnée d'état n'existe ni ne doit être créée.

1. `.gepet-squad.json` doit exister dans le répertoire courant. Sinon, dis à l'utilisateur qu'aucun projet squad n'est présent ici et propose `/gepet-squad "<besoin>"`.
2. `git switch develop && git pull`.
3. Collecte :
   - `docs/architecture/ARCHITECTURE.md` existe-t-il ? `docs/roadmap.md` existe-t-il, et contient-il la table `F-xx → #n` (vérifiable sans lire le fichier : `grep -nE "^\| *F-[0-9]+ *\| *#[0-9]+" docs/roadmap.md`) ? La roadmap est **publiée** si cette table existe **ou** si des issues existent déjà dans les milestones (collecte ci-dessous) : dans ce cas, ne repars jamais en phase 3, pour ne pas créer d'issues en double.
   - milestones : `gh api repos/<REPO>/milestones?state=all`
   - issues : `gh issue list --repo <REPO> --state all --limit 500 --json number,title,state,labels,milestone`
   - PR : `gh pr list --repo <REPO> --state open --json number,headRefName,baseRefName,title`, plus, pour chaque PR ouverte, l'**URL** et la ligne de titre (verdict) du dernier commentaire `🔍` ou `🧪` : `gh pr view <pr> --repo <REPO> --json comments`, filtré sur le titre, en ne gardant que `url` et la première ligne. Ne garde pas le contenu des rapports : ces URL remplacent celles que tu avais en contexte avant la reprise.
4. Déduis la phase :
   - pas d'architecture : phase 1 (le besoin initial est au début de `docs/roadmap.md` s'il existe : lis-en seulement l'en-tête avec `Read` et `limit` ; sinon, demande-le) ;
   - architecture présente mais roadmap non publiée (ni table, ni issues) : phase 3 (si `docs/roadmap.md` contient un brouillon sans table `F-xx → #n`, reprends-le tel quel : la revue de l'architecte se lance avec `ROADMAP: <chemin absolu de docs/roadmap.md>`, jamais avec le contenu collé) ;
   - sinon, phase 4 sur le premier milestone ouvert, ou phase 5 si toutes ses issues sont fermées sans PR `release/*` ouverte.

> **Graphify** : Si `.gepet-squad.json` contient `graphify.enabled`, lis `graphify.md` et reconstruis/mets à jour le graphe sur `develop` (il n'est pas versionné et peut manquer ou être périmé) avant de relancer les agents.

### Mode économe

**Économe hybride** (`"suivi": "hybride"`) : reprends comme en mode normal (issues et PR sur GitHub), sauf pour les rapports : le dernier rapport `FAIL` d'une PR est le fichier `docs/squad/rapports/<n>/verification-t<k>.md` ou `tests-t<k>.md` de plus grand `k` dont la première ligne finit par `FAIL`, et `RAPPORT` est son chemin. Le reste de cette section concerne la variante locale.

Si `.gepet-squad.json` contient `"mode": "econome"` (variante locale), ne lance **aucune** commande `gh` ni `git pull` : reste sur `develop` en local et remplace la collecte du point 3 par :

- l'architecture (`docs/architecture/ARCHITECTURE.md`) et la roadmap (`docs/roadmap.md`) comme ci-dessus ; la roadmap est **publiée** si `docs/squad/etat.md` existe ;
- l'état : `grep -n "^| F-\|^| M" docs/squad/etat.md` (milestones et une ligne par feature) ;
- les branches : `git branch --list "feature/*" "release/*"` ;
- les rapports : `ls docs/squad/rapports/F-xx/` pour les features en cours, sans lire leur contenu ; le dernier rapport `FAIL` est le fichier `verification-t<k>.md` ou `tests-t<k>.md` de plus grand `k` dont la première ligne finit par `FAIL` (`head -1`).

La phase se déduit de la même façon (phase 5 : toutes les features du milestone `done` et milestone pas encore en `release prête`). Au §2, « PR ouverte » signifie « `rapports/F-xx/livraison.md` existe », et `RAPPORT` est le **chemin** du fichier d'échec.

## 2. Remettre chaque feature en mouvement (phase 4)

Aucun agent de la session précédente ne tourne plus. Pour chaque issue ouverte du milestone courant (issues listées au §1 ; si tu as besoin du détail d'une feature, lis `gh issue view <n>` ou sa seule section de `docs/roadmap.md`) :

| Label actuel | Situation | Action |
|---|---|---|
| `status:in-progress` | pas de PR | relancer `developpeur` en `IMPLEMENTATION` (la branche existe peut-être : il la reprend) |
| `status:in-progress` | PR ouverte | traiter comme `LIVRÉ` : lancer le vérificateur |
| `status:in-review` | — | relancer le vérificateur |
| `status:in-test` | — | relancer le testeur |
| `status:changes-requested` | — | relancer le développeur en `CORRECTIF` avec `RAPPORT: <URL du dernier commentaire FAIL 🔍 ou 🧪 de la PR>` (jamais le contenu du rapport) |
| `status:blocked` | — | relancer l'escalade (architecte `MODE: ESCALADE`) en lui transmettant les **liens** vers les commentaires d'échec de la PR, comme au §4.5 de `gepet-squad/SKILL.md` |
| `status:ready` / `status:backlog` | — | recalculer selon les dépendances |

## 3. Annoncer puis continuer

Présente à l'utilisateur, en quelques lignes : la phase, le milestone courant, ce qui est livré, ce qui est en cours et ce qui va être relancé. Si `.gepet-squad.json` contient `ci.mode` = `local`, ajoute une ligne : « CI locale : les contrôles `ci.commands` remplacent GitHub Actions ». Avec `ci.mode` = `release` : « CI à la release : `ci.commands` en local sur les features, GitHub Actions seulement sur les PR `release/*` ». En mode économe, ajoute : « Mode économe : suivi dans `docs/squad/`, rien sur GitHub ». Applique ensuite la consigne éventuelle, puis poursuis le workflow de `gepet-squad/SKILL.md` à partir de la phase déduite.
