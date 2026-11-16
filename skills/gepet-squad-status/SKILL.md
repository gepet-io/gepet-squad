---
name: gepet-squad-status
description: Affiche l'avancement d'un projet de la squad gepet (milestones, features par statut, PR en cours, échecs et escalades, releases en attente) à partir de GitHub, ou de docs/squad/etat.md en mode économe. Lecture seule.
---

# Avancement du projet gepet-squad

Lecture seule : ne modifie rien, ne lance aucun agent.

1. Lis `.gepet-squad.json` dans le répertoire courant pour obtenir `repo`. S'il est absent, réponds qu'aucun projet squad n'est présent ici.
   **Mode économe local** (`"mode": "econome"` sans `"suivi": "hybride"`) : aucune commande `gh`. Lis `docs/squad/etat.md` (milestones et une ligne par feature, colonnes `Statut` et `Retry`) et `git branch --list "feature/*" "release/*"`, puis passe directement à l'affichage du point 3 (« PR » devient « Branche », une release en attente est un milestone `release prête`).
2. Récupère :
   - `gh api "repos/<REPO>/milestones?state=all" --jq '.[] | {number,title,state,open_issues,closed_issues}'`
   - `gh issue list --repo <REPO> --state all --limit 500 --json number,title,state,labels,milestone`
   - `gh pr list --repo <REPO> --state open --json number,title,headRefName,baseRefName,url`
3. Affiche :
   - **Milestones** : une ligne par milestone, avec une barre de progression textuelle (`████░░░░ 4/8`) et son état (en cours / livré / release en attente de merge).
   - **Milestone courant** : un tableau `# | Feature | Scope | Statut | Retry | PR`, trié par statut (bloquées d'abord, puis en cours, puis prêtes, en attente et terminées).
   - **À surveiller** : les features `status:blocked` ou `retry:2+`, et les PR `release/*` qui attendent le merge de l'utilisateur (avec leur lien).
4. **Consommation** : la CLI de consommation est en lecture seule et ne lit jamais GitHub, c'est donc à toi de lui passer les features de chaque milestone. Lance `node "${CLAUDE_PLUGIN_ROOT}/conso/cli.cjs" --project "<cwd>"` avec un `--milestone "<titre>=<ids>"` par milestone (ids séparés par des virgules) :
   - **mode normal et hybride** : numéros d'issues lus dans le résultat de `gh issue list --state all` du point 2, groupés par milestone. Garde `--state all` : sans lui, les features des milestones livrés disparaîtraient de la consommation.
   - **mode économe local** : identifiants `F-xx` lus dans la colonne `Milestone` du tableau « Features » de `etat.md`.

   Affiche la sortie de la CLI sous un titre « Consommation ». Si elle ne renvoie rien, ou si elle signale des `warnings`, indique-le en une ligne (« Consommation indisponible » ou l'avertissement) sans faire échouer le statut.
5. Termine par une phrase sur la prochaine étape, et par `/gepet-squad-resume` si aucune session n'orchestre le projet en ce moment.
