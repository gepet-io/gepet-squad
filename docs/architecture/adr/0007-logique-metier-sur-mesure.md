# 0007 — Logique métier sur mesure (normalisation, réducteur, scène)
Statut : Acceptée — Date : 2026-10-30 — **Partiellement remplacée** le 2026-11-13 : le point 3 (scène du pipeline, entités lumineuses, bloom) est remplacé par l'[ADR 0009](0009-metaphore-bureau-3d.md) (bureau 3D) et l'[ADR 0011](0011-animation-scriptee-des-bonhommes.md) (animation des bonhommes). Les points 1 et 2 restent en vigueur.

## Contexte

Le principe « réutiliser avant de construire » impose de justifier toute brique faite maison. La visualisation s'appuie sur des briques standards : Three.js et ses addons, SSE, `gh`, les hooks Claude Code et `node:test`. Il reste trois éléments qui n'existent nulle part, parce qu'ils encodent le workflow gepet-squad lui-même.

## Décision

On développe sur mesure, et uniquement :

1. **`hooks/lib/normalize.cjs` et `hooks/lib/gh-command.cjs`** : ils traduisent les payloads de hooks et les commandes `gh` du CP en événements v1. Ils dépendent des conventions propres au plugin : champs `MODE:` et `ISSUE:` des missions, blocs de `report-formats.md`, labels `status:*` et `retry:*`.
2. **`viz/lib/reducer.cjs` et `viz/public/js/state.js`** : la fusion de l'instantané et du journal, la corrélation des agents (ADR 0004), et la correspondance entre statuts et stations. C'est un réducteur pur de type `(état, événement) → état`, sans bibliothèque de gestion d'état.
3. **`viz/public/js/layout.js` et `scene.js`** : la scène du pipeline à 7 stations, les files de features et les entités agents. On n'écrit ni shader ni moteur maison : uniquement des primitives Three.js, `InstancedMesh`, `CSS2DRenderer` et `UnrealBloomPass`. Les animations sont des interpolations dans la boucle `requestAnimationFrame`, sans bibliothèque de tween.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Redux, Zustand ou XState pour l'état | Outillage, devtools | Dépendance et build, pour un réducteur d'une centaine de lignes |
| `@tweenjs/tween.js` pour les animations | API de tween éprouvée | Une dépendance vendorée de plus, pour des transitions qu'une interpolation suffit à couvrir. À reconsidérer par ADR si des courbes complexes deviennent nécessaires. |
| Bibliothèque de graphes 3D (`3d-force-graph`) | Rendu de graphe immédiat | La disposition force-directed contredit la métaphore du pipeline linéaire validée, et elle tire d'autres dépendances (d3) |

## Conséquences

- Ces modules portent la valeur métier : ce sont eux que les tests unitaires couvrent en priorité (ADR 0006).
- Toute proposition d'un développeur qui recode une brique listée dans `ARCHITECTURE.md`, § 8 (shader de glow, contrôles de caméra, WebSocket maison…) est renvoyée à l'architecte.
