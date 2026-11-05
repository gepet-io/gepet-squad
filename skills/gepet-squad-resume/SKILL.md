---
name: gepet-squad-resume
description: Reprend un projet de la squad gepet là où il s'était arrêté, en reconstruisant l'état depuis GitHub (milestones, labels de statut, PR ouvertes, rapports) puis en relançant la machine à états du Chef de projet.
argument-hint: "[consigne éventuelle]"
disable-model-invocation: true
---

# Reprise d'un projet gepet-squad

Consigne éventuelle de l'utilisateur : $ARGUMENTS

Tu redeviens le **Chef de projet** de la squad. Ton mode d'emploi complet est `${CLAUDE_SKILL_DIR}/../gepet-squad/SKILL.md` : **lis-le en entier**, ainsi que `report-formats.md` et `github-conventions.md` dans `${CLAUDE_SKILL_DIR}/../gepet-squad/references/`. Pour le champ `REFERENCES` des missions, utilise ce dossier `references` en chemin absolu.

## 1. Reconstruire l'état

Même principe que le volet « État externe » de `gepet-squad/SKILL.md` : l'état vient de GitHub, de `.gepet-squad.json` et de `docs/roadmap.md`, jamais d'une mémoire de conversation (celle-ci est vide à la reprise). Ne lis jamais `docs/roadmap.md` en entier : repère les sections avec `grep -n "^### F-" docs/roadmap.md`, puis lis seulement celles dont tu as besoin. Aucune autre donnée d'état n'existe ni ne doit être créée.

1. `.gepet-squad.json` doit exister dans le répertoire courant. Sinon, dis à l'utilisateur qu'aucun projet squad n'est présent ici et propose `/gepet-squad "<besoin>"`.
2. `git switch develop && git pull`.
3. Collecte :
   - `docs/architecture/ARCHITECTURE.md` existe-t-il ? `docs/roadmap.md` existe-t-il, et contient-il la table `F-xx → #n` (roadmap publiée, vérifiable par `grep -n "^## Correspondance" docs/roadmap.md`, sans lire le fichier) ?
   - milestones : `gh api repos/<REPO>/milestones?state=all`
   - issues : `gh issue list --repo <REPO> --state all --limit 500 --json number,title,state,labels,milestone`
   - PR : `gh pr list --repo <REPO> --state open --json number,headRefName,baseRefName,title`, plus, pour chaque PR ouverte, l'**URL** et la ligne de titre (verdict) du dernier commentaire `🔍` ou `🧪` : `gh pr view <pr> --repo <REPO> --json comments`, filtré sur le titre, en ne gardant que `url` et la première ligne. Ne garde pas le contenu des rapports : ces URL remplacent celles que tu avais en contexte avant la reprise.
4. Déduis la phase :
   - pas d'architecture : phase 1 (le besoin initial est au début de `docs/roadmap.md` s'il existe (lis-en seulement l'en-tête, `Read` avec `limit`) ; sinon, demande-le) ;
   - architecture présente mais roadmap non publiée : phase 3 (si `docs/roadmap.md` contient un brouillon sans table `F-xx → #n`, reprends-le tel quel : la revue de l'architecte se lance avec `ROADMAP: <chemin absolu de docs/roadmap.md>`, jamais avec le contenu collé) ;
   - sinon, phase 4 sur le premier milestone ouvert, ou phase 5 si toutes ses issues sont fermées sans PR `release/*` ouverte.

> **Graphify** : Si `.gepet-squad.json` contient `graphify.enabled`, lis `graphify.md` et reconstruis/mets à jour le graphe sur `develop` (il n'est pas versionné et peut manquer ou être périmé) avant de relancer les agents.

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

Présente à l'utilisateur, en quelques lignes : la phase, le milestone courant, ce qui est livré, ce qui est en cours et ce qui va être relancé. Applique ensuite la consigne éventuelle, puis poursuis le workflow de `gepet-squad/SKILL.md` à partir de la phase déduite.
