# Conventions GitHub & Git de la squad

## Fichier de configuration du projet : `.gepet-squad.json`

Créé par le bootstrap à la racine du repo principal et versionné sur `develop`. Sa présence active le hook garde-fou du plugin dans ce repo.

```json
{
  "version": 1,
  "repo": "owner/projet",
  "layout": "monorepo",
  "scopes": {
    "stock-api": { "path": "apps/stock-api" },
    "web":       { "path": "apps/web" }
  },
  "branches": { "integration": "develop", "production": "main" },
  "maxParallelDevs": 3,
  "maxRetries": 3
}
```

Clé optionnelle `"graphify": { "enabled": true }` : active le graphe de connaissances du code (voir `graphify.md`). `graphify-out/` n'est jamais versionné.

En **multi-repo**, `layout` vaut `"multirepo"` et chaque scope porte son propre repo : `"stock-api": { "repo": "owner/stock-api", "path": "." }`. Le repo principal (« hub ») contient alors l'architecture, la roadmap, les milestones et **toutes les issues**. Les sous-repos ne contiennent que le code et suivent eux aussi le cycle `develop` / `release/*` / `main`. Les PR des sous-repos référencent l'issue du hub sous la forme `owner/projet#12`.

## Branches

| Branche | Rôle | Qui y écrit |
|---|---|---|
| `main` | production, une release par milestone | **l'utilisateur seulement** (merge de la PR `release/mX`) |
| `develop` | intégration | le CP : docs, merges squash des PR de feature |
| `feature/<n°issue>-<slug>` | une feature | le développeur assigné |
| `release/m<k>-<slug>` | stabilisation du milestone k | le CP (créée depuis `develop`) |

Ne jamais pousser directement sur `main`. Le hook `guard.cjs` bloque `git push … main`.

## Labels (créés par `scripts/bootstrap.sh`)

| Label | Sens | Couleur |
|---|---|---|
| `status:backlog` | dépendances non mergées | `#d4d4d4` |
| `status:ready` | prête à être développée | `#0e8a16` |
| `status:in-progress` | un dev travaille dessus | `#1d76db` |
| `status:in-review` | PR ouverte, chez le vérificateur | `#5319e7` |
| `status:in-test` | vérification PASS, chez le testeur | `#fbca04` |
| `status:changes-requested` | FAIL, correctifs en cours | `#d93f0b` |
| `status:blocked` | 3 échecs ou blocage : escalade | `#b60205` |
| `status:done` | mergée sur develop | `#0b6e2b` |
| `type:feature` / `type:tech` / `type:infra` | nature | `#c5def5` |
| `retry:1` / `retry:2` / `retry:3` | nombre d'échecs | `#f9d0c4` |
| `scope:<sous-projet>` | créés à la publication de la roadmap | `#bfdadc` |

**Une issue porte un seul label `status:*` à la fois.** Pour changer de statut :
`gh issue edit <n> --repo <REPO> --remove-label status:<ancien> --add-label status:<nouveau>`

## Commandes de référence

```bash
# Milestone
gh api repos/<REPO>/milestones -f title="M1 — Socle" -f description="<objectif>"
# Issue de feature
gh issue create --repo <REPO> --title "[scope] titre" --body-file <f> \
  --milestone "M1 — Socle" --label "type:feature,scope:<x>,status:ready"
# État
gh issue list --repo <REPO> --milestone "M1 — Socle" --state all --json number,title,labels,state
gh pr list --repo <REPO> --base develop --json number,headRefName,title,mergeable
# Merge d'une feature (par le CP, après PASS + PASS)
gh pr merge <pr> --repo <REPO> --squash --delete-branch
gh issue close <n> --repo <REPO> --comment "Mergée sur develop via #<pr>"
# Release du milestone
git switch -c release/m1-socle origin/develop && git push -u origin release/m1-socle
gh pr create --repo <REPO> --base main --head release/m1-socle --title "Release M1 — Socle" --body-file <f>
```

> `Closes #n` ne ferme une issue automatiquement que lors d'un merge sur la branche par défaut. Comme les features sont mergées sur `develop`, **le CP ferme l'issue explicitement** après le merge.

## Corps de PR de feature (rédigé par le développeur)

```markdown
Closes #<n>

## Résumé
<ce qui a été fait, en 3 à 6 lignes>

## Critères d'acceptance
- [x] <critère> — preuve : <test / fichier:ligne>

## Tests
`<commande>` → <N passés / 0 échoué>

## Points d'attention
<choix notables, limites, suites possibles>
```

## Corps de PR de release (rédigé par le CP)

```markdown
## Release M<k> — <titre>
<objectif du milestone, en une phrase>

## Features incluses
- #<n> <titre> (PR #<p>)

## Vérifications
- Suite complète sur `develop` : <résultat>
- Rapports de vérification et de tests : PASS sur toutes les PR

## À faire par l'utilisateur
Relire, puis merger cette PR sur `main`.
```
