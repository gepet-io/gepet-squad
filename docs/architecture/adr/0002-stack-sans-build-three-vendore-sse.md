# 0002 — Stack sans build : Node standard, Three.js vendoré, SSE
Statut : Acceptée — Date : 2026-10-30 — **Amendée** le 2026-11-13 par l'[ADR 0010](0010-assets-3d-cc0-vendores-gltf.md) : la liste des addons vendorés devient `controls/OrbitControls.js`, `renderers/CSS2DRenderer.js`, `loaders/GLTFLoader.js`, `utils/SkeletonUtils.js` et `utils/BufferGeometryUtils.js`. Les addons `postprocessing/*` et les shaders du bloom sont remplacés par cette liste. Le reste de cet ADR est inchangé.

## Contexte

Le plugin s'installe tel quel : il n'y a ni `npm install` ni build chez l'utilisateur, et ses seuls prérequis sont Node, `gh`, `git` et `bash`. La visualisation doit rester dans ce cadre (choix de l'utilisateur), marcher hors ligne (sauf pour l'appel à `gh`) et rester maintenable par la squad.

## Décision

- **Runtime serveur et hooks** : Node.js **≥ 22** (LTS ; Node 20 est en fin de vie depuis avril 2026). On n'utilise que les modules standards : `node:http`, `node:fs`, `node:path`, `node:crypto`, `node:child_process`. Fichiers en CommonJS `.cjs`, comme `guard.cjs`.
- **Front** : HTML et modules ES natifs (ES2022), sans framework UI.
- **3D** : Three.js **0.187.0** (MIT), vendoré dans `viz/public/vendor/three/`.
  - Fichiers repris de `build/` : `three.module.js` et `three.core.js`. Le paquet 0.187 ne fournit plus de build minifié.
  - Addons repris de `examples/jsm/` : `controls/OrbitControls.js`, `renderers/CSS2DRenderer.js`, `postprocessing/{EffectComposer,RenderPass,ShaderPass,UnrealBloomPass,OutputPass,Pass,MaskPass}.js`, ainsi que les shaders dont ils dépendent.
  - On y joint `LICENSE` et un fichier `VERSION`.
  - Le chargement passe par un **importmap local** : `"three": "./vendor/three/build/three.module.js"`, `"three/addons/": "./vendor/three/addons/"`.
  - `scripts/vendor-three.sh <version>` (dev uniquement) met le vendoring à jour à partir de `npm pack three@<version>`.
  - Le dossier est marqué `linguist-vendored` dans `.gitattributes` et ignoré par ESLint.
- **Temps réel** : **Server-Sent Events** (`text/event-stream`), consommés par `EventSource`.
  - Le serveur envoie un battement (commentaire `:`) toutes les 15 s.
  - Le client reprend avec `Last-Event-ID`, l'identifiant étant l'offset dans le journal ; un `snapshot` est envoyé à chaque reconnexion et à chaque recalage GitHub.
- **Outillage de dev** : `package.json` racine `private`, avec pour seules `devDependencies` `eslint` 10, `@eslint/js` 10 et `globals`. Scripts : `test` (`node --test`) et `lint` (`eslint .`).

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Vite + React Three Fiber 9, `dist/` commité | Confort de développement, composants déclaratifs | Chaîne de build à maintenir, `dist` à régénérer à chaque version, revues de PR polluées (écarté par l'utilisateur) |
| Three.js par CDN (importmap distant) | Rien à vendorer | Il faut internet, on dépend d'un tiers à l'exécution, la CSP est plus large |
| WebSocket (`ws`) | Bidirectionnel | Dépendance npm à l'exécution, alors que le flux est unidirectionnel |
| Polling HTTP de `/state` | Le plus simple | Latence, et ce n'est pas du temps réel |
| Babylon.js | Moteur complet | Plus lourd, l'écosystème d'addons modules ES est moins direct pour ce besoin |

## Conséquences

- Le repo grossit d'environ 2,5 Mo (Three.js non minifié, plus les addons). C'est acceptable, et ce code est isolé dans `vendor/`.
- Aucune nouvelle dépendance à l'exécution : l'installation et la mise à jour du plugin ne changent pas.
- Le README doit indiquer le prérequis **Node ≥ 22** pour `/gepet-squad-viz`.
- Le front s'organise en modules purs (testables sous Node) et en modules de rendu (voir l'ADR 0006).
