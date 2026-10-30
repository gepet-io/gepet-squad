# Changelog

## 0.1.0 — 2026-10-30

Première version.

- Chef de projet (skill `/gepet-squad`) : workflow complet en phases 0 à 6, avec deux validations utilisateur (architecture, roadmap).
- Agents `architecte`, `developpeur`, `verificateur`, `testeur`.
- Suivi sur GitHub via `gh` : milestones, issues au format feature (Contexte + Critères d'acceptance avec tests), labels `status:*` et `retry:*`, PR `feature/*` → `develop`, PR `release/mX` → `main` par milestone.
- Développement en parallèle dans des worktrees isolés (3 par défaut), escalade après 3 échecs.
- `/gepet-squad-resume` (reprise depuis GitHub) et `/gepet-squad-status` (avancement).
- `scripts/bootstrap.sh` (labels, branches, `.gepet-squad.json`), plus un hook garde-fou sur `main`.
