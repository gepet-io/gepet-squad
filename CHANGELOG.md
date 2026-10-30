# Changelog

## 0.2.0 — 2026-10-30

Collecteur d'événements : première brique de la vue du projet.

- Nouveaux hooks asynchrones (`async: true`, `hooks/events.cjs`) sur `PreToolUse` (`Agent|Task`, `SubagentHandback`), `PostToolUse` (`Agent|Task`, `Bash`), `SubagentStart` et `SubagentStop` (agents `claude-gepet-squad:*`). Le garde-fou `guard.cjs` est inchangé.
- Journal local `<git-common-dir>/gepet-squad/events.jsonl`, une ligne JSON (schéma v1) par événement, partagé entre le repo principal et ses worktrees. Rotation à 5 Mo (`events.1.jsonl`, un seul ancien fichier). Jamais commité.
- Actif uniquement dans un repo contenant `.gepet-squad.json` ; ailleurs, rien n'est écrit.
- Données minimisées : ni prompt ni rapport complet, seulement `MODE`, `ISSUE`, `PR`, `TENTATIVE`, l'en-tête du bloc de rapport et le verdict, plus les transitions des commandes `gh` du Chef de projet.
- Le collecteur ne bloque ni ne fait échouer la session : code de sortie 0, rien sur stdout, erreurs tracées dans `collector.log` (borné à 256 Ko).

## 0.1.0 — 2026-10-30

Première version.

- Chef de projet (skill `/gepet-squad`) : workflow complet en phases 0 à 6, avec deux validations utilisateur (architecture, roadmap).
- Agents `architecte`, `developpeur`, `verificateur`, `testeur`.
- Suivi sur GitHub via `gh` : milestones, issues au format feature (Contexte + Critères d'acceptance avec tests), labels `status:*` et `retry:*`, PR `feature/*` → `develop`, PR `release/mX` → `main` par milestone.
- Développement en parallèle dans des worktrees isolés (3 par défaut), escalade après 3 échecs.
- `/gepet-squad-resume` (reprise depuis GitHub) et `/gepet-squad-status` (avancement).
- `scripts/bootstrap.sh` (labels, branches, `.gepet-squad.json`), plus un hook garde-fou sur `main`.
