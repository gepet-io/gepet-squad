# gepet-squad

Plugin Claude Code : une **squad IT d'agents** qui transforme un simple prompt en projet livré.

```
/gepet-squad "Créer une boutique e-commerce avec gestion des stocks et des livraisons"
```

## La squad

| Rôle | Où il vit | Ce qu'il fait |
|---|---|---|
| **Chef de projet** | la session principale (skill `gepet-squad`) | Orchestre tout le monde, rédige la roadmap et les features, tient les statuts, merge sur `develop`, ouvre les releases. Seul interlocuteur de l'utilisateur. |
| **Architecte** | agent `architecte` (opus) | Recueille le besoin, choisit l'architecture, la stack et le découpage en sous-projets, en réutilisant l'existant. Rédige ARCHITECTURE.md + ADR, valide la roadmap, gère les escalades. |
| **Développeur** | agent `developpeur` (sonnet), en worktree isolé | Implémente une feature et ses tests unitaires et d'intégration, puis ouvre la PR vers `develop`. Applique ensuite les correctifs. |
| **Vérificateur** | agent `verificateur` (opus), lecture seule | Code review : architecture, anti-patterns, sécurité, réinvention de l'existant, qualité des tests, critères d'acceptance. |
| **Testeur** | agent `testeur` (sonnet), lecture seule | Non-régression : suite complète sur la PR fusionnée localement avec `develop`, comparée à la baseline. |

> Pourquoi le Chef de projet est-il la session principale ? Dans Claude Code, un subagent ne peut ni lancer d'autres subagents ni parler à l'utilisateur. L'orchestrateur doit donc être la session.

## Le workflow

```
0. Bootstrap     gh auth · repo (créé après accord) · labels · develop · .gepet-squad.json
1. Cadrage       Architecte ⇄ vous (questions) → proposition → ✅ VOTRE VALIDATION → ADR sur develop
2. Pitch         Architecte → Chef de projet
3. Roadmap       CP rédige → Architecte relit → ✅ VOTRE VALIDATION → milestones + issues GitHub
4. Livraison     Dev ×3 en parallèle → PR → Vérificateur → Testeur → merge squash sur develop
                 FAIL → correctif (retry:1..3) → 3 échecs → escalade à l'architecte, ou à vous
5. Release       milestone complet → PR release/mX → main (c'est vous qui mergez)
6. Bilan
```

Après vos deux validations, tout est autonome. GitHub est la source de vérité : labels `status:*`, milestones, rapports en commentaires de PR.

## Commandes

| Commande | Rôle |
|---|---|
| `/gepet-squad "<besoin>"` | Lance un nouveau projet depuis le dossier du projet (vide ou repo existant). |
| `/gepet-squad-resume [consigne]` | Reprend un projet dans une nouvelle session, en reconstruisant l'état depuis GitHub. |
| `/gepet-squad-status` | Affiche l'avancement (lecture seule). |

Si un autre plugin utilise le même nom, la forme préfixée `/gepet-squad:gepet-squad` fonctionne toujours.

## Prérequis

- Claude Code récent
- [GitHub CLI](https://cli.github.com/) authentifiée : `gh auth login`
- `git`, `bash` (Git Bash sous Windows) et `node` (pour le hook garde-fou)

## Installation (une fois, au niveau utilisateur : disponible dans toutes les sessions)

Dans Claude Code :

```
/plugin marketplace add D:\DevClaude\claude-gepet-squad
/plugin install gepet-squad@claude-gepet-squad
```

Le plugin s'appelle `gepet-squad` ; le repo GitHub et la marketplace gardent le nom `claude-gepet-squad`.

Sur une autre machine, utilisez le repo GitHub : `/plugin marketplace add gepets/claude-gepet-squad`.

## Mettre à jour après une modification

1. Augmentez `version` dans `.claude-plugin/plugin.json` et complétez `CHANGELOG.md`.
2. Commitez (et poussez si le repo est sur GitHub).
3. Dans Claude Code : `/plugin marketplace update claude-gepet-squad`, puis redémarrez la session.

Pour tester une modification sans toucher la version installée :

```bash
claude --plugin-dir D:\DevClaude\claude-gepet-squad
```

## Personnalisation

| Quoi | Où |
|---|---|
| Nombre de devs en parallèle, nombre d'échecs avant escalade | `.gepet-squad.json` du projet (`maxParallelDevs`, `maxRetries`) |
| Modèle et effort d'un rôle | frontmatter `model:` / `effort:` dans `agents/<role>.md` |
| Format des features, des rapports et de la roadmap | `skills/gepet-squad/references/` |
| Règles du garde-fou | `hooks/guard.cjs` |

## Garde-fou

Dans un repo qui contient `.gepet-squad.json`, le hook bloque les actions suivantes pour Claude : push direct sur `main`, force-push sur `develop`, merge d'une PR vers `main`. Ailleurs, il n'a aucun effet. Le merge des releases reste votre décision.

## Structure

```
.claude-plugin/   plugin.json, marketplace.json
agents/           architecte, developpeur, verificateur, testeur
skills/           gepet-squad (Chef de projet + references/), gepet-squad-resume, gepet-squad-status
scripts/          bootstrap.sh
hooks/            hooks.json, guard.cjs
```
