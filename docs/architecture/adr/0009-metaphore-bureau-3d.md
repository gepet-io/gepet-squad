# 0009 — Métaphore « bureau 3D » à la place du pipeline abstrait
Statut : Acceptée — Date : 2026-11-13
Remplace : le point 3 de l'ADR 0007 (scène du pipeline à 7 stations). Complète l'ADR 0006 (tests du front).

## Contexte

La version 0.4.0 de `/gepet-squad-viz` montre un pipeline abstrait : 7 stations alignées, des features en files et des agents sous forme de sphères lumineuses (bloom). L'utilisateur veut voir **de petits bonhommes qui représentent les agents et qui travaillent dans un bureau**. Il a validé les points suivants le 2026-11-13 :

- le bureau **remplace** le pipeline : une seule vue 3D, sans bascule ;
- le style est en **3D low-poly**, avec des assets glTF CC0 (ADR 0010) ;
- les features deviennent des **post-its sur un kanban mural**, une colonne par station, plus le **dossier** de la feature sur le bureau de l'agent qui la traite ;
- les bonhommes sont **vivants mais scriptés** (ADR 0011).

Le reste de la chaîne ne change pas : collecteur, journal, serveur, contrat `/state`, SSE, `state.js`, `sync.js`, repli texte.

## Décision

**La donnée ne change pas, seul le rendu change.** Les identifiants de station de `/state` (`cadrage` … `release`, `escalade`) restent la clé. `office-layout.js` traduit chaque station en zone du bureau :

| Station | Zone du bureau | Occupant |
|---|---|---|
| `cadrage` | Salle de réunion (table, chaises) | Architecte en `CADRAGE_*` |
| `roadmap` | Devant le kanban, debout | Architecte en `REVUE_ROADMAP` |
| `dev` | Open space : un poste par développeur. 3 postes par défaut ; un poste de plus apparaît si plus de développeurs sont actifs en même temps. | Développeurs |
| `verification` | Bureau du vérificateur | Vérificateur |
| `test` | Labo (bureau, laptop, écrans) | Testeur |
| `merge`, `release` | Colonnes du kanban uniquement | — |
| `escalade` | Salle de réunion éclairée en rouge, colonne rouge du kanban | Architecte en `ESCALADE` |

- **Chef de projet** : un bonhomme permanent à son bureau. Il fait le geste `interact-right` quand le journal reçoit un `feature.status` ou un `pr.merged`. Ce sont des commandes que le CP lance réellement : on n'invente aucun comportement.
- **Kanban** : un plan mural, avec une colonne par station plus `escalade`. Les post-its forment un seul `InstancedMesh`, colorés par statut (couleurs de `view-model.js`). Le badge retry et l'étiquette au survol passent par `CSS2DRenderer`.
  - Dans chaque colonne, on affiche d'abord les features du milestone ouvert le plus ancien, puis les autres par numéro.
  - Au-delà d'un plafond par colonne, un compteur « +N » remplace les post-its en trop. Le plafond est une constante de `office-layout.js`.
  - Un déplacement de feature (`feature-move`) fait glisser le post-it d'une colonne à l'autre, par les courbes de `motion.js`.
- **Dossier sur le bureau** : quand un agent porte un `issue`, un dossier (primitive Three.js) est posé sur son poste, avec l'étiquette CSS2D `#N`.
- **Fin du bloom et des sphères** : `agents.js` et la chaîne `EffectComposer`/`UnrealBloomPass` disparaissent. Les addons `postprocessing/*` et les shaders associés sortent du vendoring (ADR 0010).
- **Découpage du front** (`viz/public/js/`). Les modules sont soit purs (aucun import de `three`, aucun DOM, aucune horloge), soit de rendu :

  | Module | Nature | Rôle |
  |---|---|---|
  | `state.js`, `sync.js`, `fallback.js`, `ui.js`, `main.js` | inchangés | `main.js` ne change que l'import de la couche agents |
  | `view-model.js` | pur, conservé | Couleurs, noms, correspondance instance → feature, cadrage caméra. Ajout des noms de zones. |
  | `motion.js` | pur, conservé | Courbes, fondus, réduction de mouvement. Les fonctions de glow et de bloom sont retirées. |
  | `office-layout.js` | **pur, nouveau** | Plan du bureau : zones, postes, porte, positions et échelles du mobilier, colonnes du kanban, positions des post-its, plafond « +N ». Remplace `layout.js`, supprimé une fois la scène migrée. |
  | `paths.js` | **pur, nouveau** | Graphe de points de passage, trajets, échantillonnage (ADR 0011) |
  | `crew.js` | **pur, nouveau** | Décisions des bonhommes : attribution des postes, modèle par type, machine d'états, clip, bulle, dossier (ADR 0011) |
  | `assets.js` | **pur, nouveau** | Manifeste des assets : chemin, rôle, clips requis, échelle (ADR 0010) |
  | `scene.js` | rendu | Boucle, caméra `OrbitControls`, décor (mobilier GLB, murs, sol), kanban et post-its |
  | `characters.js` | **rendu, nouveau** | `GLTFLoader`, `SkeletonUtils.clone`, un `AnimationMixer` par bonhomme, bulles et dossiers en CSS2D. Remplace `agents.js`. |
  | `labels.js` | rendu | Noms de zones, étiquettes au survol |

- **Repli** : si un asset ne se charge pas, la vue reste utilisable. Un bonhomme manquant est remplacé par une capsule colorée par type, un meuble manquant est simplement omis, et un avertissement est affiché par `ui.js`. Sans WebGL, le repli texte actuel s'applique sans changement.
- **Tests** (complète l'ADR 0006) :
  - **unitaires** sur les modules purs `office-layout`, `paths`, `crew`, `assets` et `motion`, ajoutés à `tests/viz-web/purity.test.mjs` ;
  - **intégration** : lecture des GLB vendorés sous Node (ADR 0010), et `scene.js` et `characters.js` chargés sous Node avec les crochets existants (`three-register.mjs`) et un faux chargeur, sans WebGL ;
  - **smoke manuel** dans le navigateur, documenté dans la PR. Il couvre trois points :
    - un agent entre, travaille, rend son verdict et sort ;
    - avec `prefers-reduced-motion`, il n'y a aucune marche ;
    - aucune erreur CSP ne s'affiche dans la console.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Garder le pipeline et ajouter le bureau en 2e vue | Rien n'est perdu | Deux scènes et deux jeux de tests à maintenir (écarté par l'utilisateur) |
| Bureau sans features, avec un panneau texte latéral | Plus simple | On perd la vue d'ensemble spatiale du milestone |
| Piles de dossiers dans chaque zone | Transposition directe des files | Illisible au-delà de quelques dizaines de features |
| Garder le bloom pour les écrans | Effet « vivant » | Coût de rendu et addons à garder, pour un gain faible |

## Conséquences

- Le contrat `/state`, le schéma d'événements v1 et le réducteur ne changent pas. Le scope `hooks` n'est pas touché, et `viz-server` ne reçoit que le type MIME `.glb` (ADR 0010).
- Les tests `layout`, `scene`, `agents` et `motion` sont réécrits ou adaptés. `stations-parity` et `state` ne bougent pas.
- La version 0.8.0 (milestone M5) est portée par la dernière feature du milestone, comme pour les milestones précédents.
- Ajouter une station ou un type d'agent demande désormais une zone dans `office-layout.js` et un modèle dans `assets.js`.
