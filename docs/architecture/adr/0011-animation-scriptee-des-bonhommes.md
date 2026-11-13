# 0011 — Animation scriptée des bonhommes : machine d'états pure et chemins prédéfinis
Statut : Acceptée — Date : 2026-11-13
Remplace : le point 3 de l'ADR 0007, pour la partie « entités agents » et « interpolations ».

## Contexte

L'utilisateur veut des bonhommes **vivants mais scriptés** :
- au lancement, l'agent entre par la porte et marche jusqu'à son poste ;
- il tape au clavier tant qu'il travaille ;
- à son rapport, il montre une bulle de verdict ;
- à sa fin, il repart ;
- s'il est repris, il revient s'asseoir ;
- avec `prefers-reduced-motion`, il apparaît directement à son poste.

Trois contraintes viennent de l'existant :
- **le cycle de vie n'est pas monotone** (ADR 0008) : `finished` peut repasser à `running` ou à `reported` ;
- un agent peut finir **avant** d'avoir atteint son poste ;
- `state.js` garde un agent `finished` 10 min, puis le retire (`agent-remove`). La phase `unknown` arrive après 45 min sans signal.

Aucune brique existante ne donne ce comportement, qui encode le workflow gepet-squad. Il faut aussi qu'il reste testable sans WebGL (ADR 0006).

## Décision

- **`paths.js` (pur)** : un graphe fixe de points de passage `{ x, z }` : porte, couloir, entrée de chaque zone, chaque poste.
  - Le trajet porte → poste est une suite de points définie par `office-layout.js`. Il n'y a ni navmesh ni pathfinding : les postes sont fixes.
  - `pathTo(from, to)` renvoie la polyligne, et `sample(path, t)` la position et le cap.
  - La durée est proportionnelle à la longueur, **plafonnée à 3 s**.
- **`crew.js` (pur)** : il calcule `(bonhommes, modèle, transitions, now, reduced) → bonhommes`. Il ne fait aucun appel à `three`, au DOM ou à l'horloge : le temps est un argument.
  - **Attribution des postes** : stable par `agent.id`. Un développeur garde son poste tant qu'il est dans le modèle. On prend le premier poste libre, et un poste de plus est créé au-delà des postes par défaut.
  - **Modèle 3D** : choisi selon `type`. Pour les développeurs, il est choisi selon l'indice du poste, à partir du manifeste `assets.js`.
  - **États** d'un bonhomme, avec le clip Kenney associé :

    | État | Clip | Entrée |
    |---|---|---|
    | `entering` | `walk` | `agent-add`, ou reprise d'un agent sorti |
    | `working` | `sit`, puis `interact-right` en boucle (debout `idle` pour l'architecte au kanban) | arrivé au poste et phase `requested` ou `running` |
    | `reporting` | `emote-yes` (`PASS`, `LIVRÉ`, `APPROUVÉ`), `emote-no` (`FAIL`, `BLOQUÉ`, `À REVOIR`), `holding-both` sinon, et une bulle CSS2D du verdict | phase `reported` |
    | `leaving` | `walk` vers la porte | phase `finished` |
    | `gone` | invisible | arrivé à la porte |
    | `stale` | `idle`, avec une bulle « ? » | phase `unknown` |

  - **Occupants simultanés** : la squad lance plusieurs features en parallèle, donc plusieurs vérificateurs, testeurs ou architectes peuvent être actifs en même temps. Chaque zone à occupant unique (`cadrage`, `roadmap`, `verification`, `test`, `escalade`) offre `MAX_ZONE_SEATS = 3` places, données par `seatFor(station, role, rank)` : le rang 0 est le poste principal, les rangs 1 et 2 sont des places debout dans la zone (état `working` avec `interact-right` debout, sans `sit`). Le rang est attribué à l'entrée (première place libre de la zone, stable par `agent.id`). Au-delà de 3, le bonhomme prend la dernière place (superposition acceptée : la configuration par défaut a `maxParallelDevs: 3`).
  - **Station inconnue ou changeante** : un agent dont la station est `null` (architecte sans mode connu) prend une place de la salle de réunion (`cadrage`). La place est fixée à l'entrée : un `agent-move` pendant la présence ne déplace pas le bonhomme, et la nouvelle station ne compte qu'à la prochaine entrée.
  - **Interruptions** : chaque changement de phase calcule l'état cible **depuis la position courante**. Un `finished` reçu pendant `entering` fait demi-tour vers la porte. Une reprise pendant `leaving` ou `gone` relance `entering` vers le **même** poste s'il est libre. Tout autre changement de phase reçu pendant une marche (`reported`, `unknown`) est mis en attente et appliqué à l'arrivée : la bulle de verdict dure alors 4 s à partir de l'arrivée. La file garde au plus une transition en attente, la dernière reçue, ce qui évite les à-coups.
  - **Bulle de verdict** : affichée 4 s, puis le bonhomme se rassied tant que la phase reste `reported`.
  - **Dossier** : visible sur le poste quand `issue` est connu, avec l'étiquette `#N`.
  - **Chef de projet** : toujours présent et `working` à son bureau, mais au repos il est assis **sans taper** (`sit`) : sinon le geste se confondrait avec la frappe des autres agents. Il joue `interact-right` une fois (un cycle du clip, puis retour à `sit`) par transition `feature-move`, `feature-status`, ou `release` vers `merged` renvoyée par `state.js` (traces des `feature.status` et `pr.merged` du journal), au plus un geste par seconde ; les transitions en excès sont ignorées, sans file. `crew.js` ne lit que les transitions : `state.js` n'est pas modifié.
  - **Réduction de mouvement** : pas de marche ; l'état passe directement à l'état final (`working` au poste, ou `gone`). Les clips sont figés sur leur première image, et seules les bulles et les dossiers changent.
- **`characters.js` (rendu)** : il ne décide rien. Il clone les modèles (`SkeletonUtils.clone`), crée un `AnimationMixer` par bonhomme, applique position, cap et clip décidés par `crew.js`, avec un fondu croisé de 0,2 s entre clips (`crossFadeTo`). Il dessine aussi les bulles et les dossiers. Le texte passe toujours par `textContent`.
- **`motion.js`** garde les courbes et les fondus. On n'ajoute pas de bibliothèque de tween.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Navmesh avec `three-pathfinding`, ou A* maison | Déplacements libres | Dépendance ou code en plus, pour des postes fixes. Inutile. |
| Simulation riche (pauses café, visites entre agents) | Spectaculaire | Invente des comportements que les événements ne portent pas (écarté par l'utilisateur) |
| Bonhommes statiques animés en boucle, sans marche | Le plus simple | Moins vivant (écarté par l'utilisateur) |
| XState pour la machine d'états | Outillage et visualisation | Dépendance vendorée, pour six états |
| `@tweenjs/tween.js` ou GSAP | API éprouvée | `motion.js` couvre déjà le besoin. Dépendance inutile. |

## Conséquences

- Toute la logique de comportement est dans `crew.js` et `paths.js`, couverts par des tests unitaires :
  - chaque transition du tableau ;
  - la reprise après `finished` ;
  - `finished` pendant `entering` ;
  - le poste supplémentaire ;
  - les occupants simultanés d'une zone à occupant unique, et la station `null` ;
  - la réduction de mouvement ;
  - le plafond de 3 s.
- `characters.js` est testé sous Node avec les crochets `three-register.mjs` et un faux chargeur : clips joués et objets ajoutés ou retirés, sans WebGL.
- Ajouter un geste demande seulement un clip Kenney déjà présent et une ligne dans le tableau d'états de `crew.js`.
