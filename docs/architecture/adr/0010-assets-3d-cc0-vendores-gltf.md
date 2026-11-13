# 0010 — Assets 3D CC0 vendorés (Kenney) et chargement glTF
Statut : Acceptée — Date : 2026-11-13
Amende : l'ADR 0002 (liste des addons Three.js vendorés). Complète l'ADR 0005 (type MIME `.glb`).

## Contexte

Le bureau de l'ADR 0009 a besoin de bonhommes **riggés et animés** (marcher, s'asseoir, taper, approuver, refuser, porter) et de mobilier de bureau. Ces modèles doivent répondre à cinq contraintes :
- rester cohérents entre eux ;
- avoir une licence compatible avec une distribution par marketplace ;
- se charger sans build ;
- passer la CSP de l'ADR 0005 sans l'élargir ;
- ne pas alourdir excessivement le plugin.

Vérifications faites le 2026-11-13 sur les zips officiels :
- **Kenney Mini Characters 2.0** : `License.txt` CC0 1.0. Le dossier `Models/GLB format/` contient 22 personnages d'environ 250 Ko chacun. Chaque personnage a un squelette de 7 os, 2 meshes et 32 clips, dont `idle`, `walk`, `sit`, `interact-right`, `emote-yes`, `emote-no`, `holding-both` et `pick-up`. La texture est **externe** (`Textures/colormap.png`, 10,6 Ko), partagée par tous.
- **Kenney Furniture Kit 2.0** : `License.txt` CC0 1.0. Le dossier `Models/GLTF format/` contient 140 GLB, **sans image et sans skin** : `desk`, `chairDesk`, `computerScreen`, `computerKeyboard`, `laptop`, `doorway`, `wall`, `wallWindow`, `floorFull`, `table`, `bookcaseOpen`, `pottedPlant`, `kitchenCoffeeMachine`, `trashcan`, `lampSquareCeiling`, etc. Il n'y a pas de tableau blanc.
- **Three.js 0.187.0** (dernière version publiée) : `examples/jsm/loaders/GLTFLoader.js` importe `../utils/BufferGeometryUtils.js` et `../utils/SkeletonUtils.js`.
- **Téléchargement Kenney** : le lien est signé et lié à une session navigateur, donc pas fiable à automatiser.

## Décision

- **Packs retenus** : Kenney Mini Characters 2.0 pour les bonhommes, Kenney Furniture Kit 2.0 pour le mobilier. Le tableau kanban et les dossiers sont des primitives Three.js.
- **Emplacement** : `viz/public/vendor/kenney/` :
  - `characters/*.glb`, avec `characters/Textures/colormap.png`, en gardant le chemin relatif attendu par les GLB ;
  - `furniture/*.glb` ;
  - `LICENSE-mini-characters.txt` et `LICENSE-furniture-kit.txt` (copies de `License.txt`) ;
  - `SOURCE.md` : URL des pages des packs, version, date, et liste des fichiers retenus avec leur sha256.
- **Sélection** : 7 personnages au plus, environ 1,7 Mo, et une quinzaine de meubles, environ 160 Ko. La liste fait foi dans `viz/public/js/assets.js` (module pur), qui donne pour chaque asset son chemin, son rôle et son échelle, ainsi que les clips requis pour les personnages.
  - Un modèle distinct par rôle : chef de projet, architecte, vérificateur, testeur.
  - 3 modèles pour les développeurs, attribués selon le poste.
  - Les modèles de type armes ou fantaisie ne sont pas retenus.
- **Vendoring** : `scripts/vendor-assets.sh <zip-mini-characters> <zip-furniture-kit>` (dev uniquement, scope `repo`). Le script prend les zips **téléchargés à la main**, extrait les seuls fichiers listés et réécrit `SOURCE.md` avec leurs sha256. Il ne télécharge rien.
- **Addons Three.js** (amende l'ADR 0002) :
  - `scripts/vendor-three.sh` ajoute `loaders/GLTFLoader.js`, `utils/SkeletonUtils.js` et `utils/BufferGeometryUtils.js` ;
  - il retire `postprocessing/*` et les shaders du bloom (`CopyShader`, `LuminosityHighPassShader`, `OutputShader`), qui ne servent plus ;
  - Three.js reste en **0.187.0**.
- **Serveur** : `.glb` entre dans la liste blanche MIME de `viz/lib/http.cjs`, avec `model/gltf-binary`. `.png` y est déjà. Tout le reste de l'ADR 0005 est inchangé.
- **CSP inchangée** (`img-src 'self' data:`, `connect-src 'self'`) :
  - on n'accepte que des assets **sans image embarquée** dans le GLB, parce que `GLTFLoader` charge ces images par une URL `blob:` que la CSP refuse ;
  - les textures externes servies depuis `vendor/` sont autorisées.
- **Dépôt** : `.gitattributes` reçoit `*.glb binary` et `*.png binary` (la règle `* text=auto eol=lf` ne doit pas les toucher). `vendor/**` reste `linguist-vendored` et ignoré par ESLint.
- **Contrôle automatique** (`tests/viz-web/assets.test.mjs`, intégration) :
  - chaque fichier du manifeste existe et son sha256 correspond à `SOURCE.md` ;
  - le chunk JSON de chaque GLB est lu sous Node, sans WebGL. On vérifie que les clips requis sont présents et qu'aucune image n'est embarquée (`bufferView`), et que toute image référencée existe ;
  - les deux licences sont présentes.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Quaternius Universal Base Characters et Animation Library (CC0, glTF) | Animations riches | Environ 13 000 triangles par personnage, style réaliste, pas de mobilier assorti |
| Bonhommes en primitives, animés de façon procédurale | Aucun asset | Gestes peu lisibles, rendu « jouet », animation maison à écrire |
| Assets à texture embarquée | Un seul fichier par modèle | Il faudrait ajouter `blob:` à la CSP (ADR 0005) |
| Téléchargement automatique depuis kenney.nl | Mise à jour en une commande | Lien signé lié à une session, donc fragile. Dépendance réseau dans le script. |
| Conversion et compression (Draco, meshopt) | Fichiers plus petits | Ajoute un décodeur vendoré (WASM), pour un gain faible sur environ 2 Mo |

## Conséquences

- Le plugin grossit d'environ 1,9 Mo d'assets. Le retrait des addons de post-traitement en compense une petite partie.
- Le scope `viz-server` reçoit une seule retouche (type MIME `.glb`), avec ses tests unitaires et d'intégration.
- Le README crédite Kenney (www.kenney.nl). Ce n'est pas exigé par CC0, mais c'est recommandé par l'auteur.
- Changer de pack, ou accepter un asset à image embarquée, demande un nouvel ADR.
