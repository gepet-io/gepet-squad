# Modèle de `docs/architecture/ARCHITECTURE.md`

```markdown
# Architecture — <nom du projet>

> Statut : validée par l'utilisateur le <date>. Toute évolution passe par un nouvel ADR.

## 1. Besoin
<résumé du besoin, utilisateurs, volumétrie, contraintes>

## 2. Vue d'ensemble
<pattern retenu, schéma (Mermaid) des sous-projets et de leurs échanges>

## 3. Sous-projets
| Sous-projet | Dossier | Rôle | Expose | Consomme |

## 4. Stack
| Sous-projet | Langage / version | Framework | Données | Tests unitaires | Tests d'intégration | Lint |

## 5. Commandes
| Sous-projet | install | lint | build | tests essentiels (≈ 3 min) | tests complexes | audit des dépendances | démarrer |
> Ce sont ces commandes exactes qu'utilisent le développeur et le testeur (tests essentiels) et le vérificateur (tests complexes, ciblés sur la feature). Voir `tests-et-ci.md`.

## 6. Données
<stockage, modèle principal, migrations, sauvegarde, données personnelles / RGPD>

## 7. Sécurité
<niveau retenu, authentification, autorisation, secrets (.env non versionné + .env.example), validation des entrées, dépendances>

## 8. Réutiliser avant de construire
| Besoin | Solution existante | Pourquoi | Alternative écartée |

## 9. Conventions
<structure des dossiers, nommage, gestion d'erreurs, logs, format de commit, stratégie de tests>

## 10. Hébergement & CI
<CI minimale (`tests-et-ci.md`) : `ci.commands` en local sur chaque feature ; GitHub Actions seulement sur la PR release/* → main (`ci.mode` = `release`), un job ubuntu, install + lint + build + tests essentiels, sans artefact ; environnements, déploiement>
<Packages : aucun, sauf accord de l'utilisateur (`packages.enabled`) : alors `release.yml` déclenché uniquement par la publication d'une release GitHub>
<Si `ci.mode` vaut `local` dans `.gepet-squad.json` (toujours le cas en mode économe) : pas de workflow GitHub Actions ; indiquer la liste `ci.commands` (install, lint, build, tests essentiels) exécutée localement par le développeur, le testeur et le Chef de projet>

## 11. Décisions (ADR)
- [0001 — <titre>](adr/0001-<slug>.md)
```

# Modèle d'ADR (`docs/architecture/adr/NNNN-<slug>.md`)

```markdown
# NNNN — <Titre de la décision>
Statut : Acceptée | Remplacée par NNNN — Date : <date>

## Contexte
## Décision
## Alternatives considérées
| Option | Avantages | Inconvénients |
## Conséquences
```
