# Modèle de roadmap (brouillon soumis à l'architecte, puis à l'utilisateur)

```markdown
# Roadmap — <nom du projet>

## Vue d'ensemble
| Milestone | Objectif livrable (démontrable) | Features | Sous-projets |
|---|---|---|---|
| M1 — Socle & <…> | <ce qu'on peut montrer à la fin> | F-01…F-05 | stock-api, web |

## Graphe de dépendances
F-01 → F-02 → F-04
F-01 → F-03
(les features sans dépendance entre elles d'un même milestone partent en parallèle)

## M1 — <titre>
**Objectif** : <…>
**Définition de fin** : <ce qui doit être vrai pour ouvrir la release/m1>

### F-01 · [<scope>] <titre>
<corps complet au format feature-template.md>

### F-02 · …

## M2 — …
```

## Règles de construction

- Un milestone produit un **incrément démontrable**, pas une couche technique isolée : on vise une tranche verticale dès que possible.
- 3 à 8 features par milestone. Au-delà, il faut découper le milestone.
- Les identifiants `F-xx` sont stables pendant la revue. À la publication, chaque `F-xx` devient une issue `#n`, et les dépendances sont réécrites avec les `#n`.
- Le brouillon s'écrit directement dans `docs/roadmap.md` (l'architecte le lit par son chemin, champ `ROADMAP`). Après validation, il est commité sur `develop`, et la table de correspondance `F-xx → #n` y est ajoutée.
