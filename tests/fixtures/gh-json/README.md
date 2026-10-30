# Fixtures de sorties JSON de `gh`

Réponses de `gh` consommées par `tests/viz-server/github.test.cjs` (repo fictif `o/r`).

- `milestones.json` : `gh api repos/o/r/milestones` (API REST, champs en `snake_case`).
- `issues.json` : `gh issue list --json number,title,state,labels,milestone` (états en majuscules, labels en objets).
- `pulls-open.json`, `pulls-merged-develop.json`, `pulls-merged-main.json` : `gh pr list --json …` pour les PR ouvertes et les PR mergées vers `develop` et `main`.
- `expected-snapshot.json` : l'instantané normalisé attendu (avec `fetchedAt` fixé à `2026-10-30T12:00:00.000Z`).

Ces fixtures sont écrites d'après le format documenté de `gh`, pas capturées sur un vrai repo.
