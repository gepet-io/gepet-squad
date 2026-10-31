# 0006 — Stratégie de tests
Statut : Acceptée — Date : 2026-10-30

## Contexte

Jusqu'ici, le plugin n'a pas de suite de tests automatisée : la vérification passe par `claude plugin validate .`, un test manuel du garde-fou et `bash -n`. La visualisation ajoute du code exécutable (collecteur, serveur, front). Il faut une suite unique, lancée par une seule commande, sans dépendance à l'exécution, et qui tourne sous Windows et Linux. Le rendu WebGL est difficile à tester automatiquement sans navigateur.

## Décision

- **Framework** : `node:test` et `node:assert/strict` (Node ≥ 22). Pas de Jest ni de Vitest.
- **Commande unique** : `npm test` (= `node --test`), qui découvre `tests/**/*.test.{cjs,mjs}`. Lint : `npm run lint` (ESLint 10, flat config `eslint.config.mjs`, `viz/public/vendor/**` ignoré).
- **Arborescence** :
  - `tests/hooks/`, `tests/viz-server/` et `tests/viz-web/` : un dossier par scope, pour que des features parallèles ne touchent pas les mêmes fichiers ;
  - `tests/fixtures/hooks/` : payloads réels anonymisés, un fichier par type d'événement et par mode (synchrone ou arrière-plan) ;
  - `tests/fixtures/gh/` : sorties JSON de `gh` ;
  - `tests/helpers/` : repo git temporaire, faux `gh`, client SSE.
- **Unitaires** (modules purs, sans I/O) :
  - `hooks/lib/normalize.cjs` : chaque fixture de payload donne l'événement v1 attendu ; un payload hors squad (`subagent_type` d'un autre plugin) ne donne rien ;
  - `hooks/lib/gh-command.cjs` : chaque forme de `github-conventions.md` et de `SKILL.md`, plus les commandes chaînées et les commandes non pertinentes ;
  - `viz/lib/reducer.cjs` : fusion de l'instantané et des événements, priorité GitHub, corrélation `toolUseId`/`agentId` et FIFO, idempotence de `agent.finished`, phase `unknown` après 45 min (horloge simulée avec `mock.timers`) ;
  - `viz/lib/http.cjs` : validation du `Host`, résolution des chemins, construction de la CSP ;
  - `viz/public/js/state.js` et `layout.js` : importés en modules ES depuis `tests/viz-web/*.test.mjs`, sans DOM. Ils ne doivent donc **pas importer `three`** : on y manipule des positions sous forme de tableaux ou d'objets simples, et c'est `scene.js` qui les convertit en `Vector3`.
- **Intégration** (I/O réelles) :
  - collecteur : `child_process.spawn('node', ['hooks/events.cjs'])` avec la fixture sur stdin, dans un repo git temporaire avec `.gepet-squad.json` (et un worktree). On vérifie la ligne écrite dans `<git-common-dir>/gepet-squad/events.jsonl`, l'absence d'écriture hors repo squad, la rotation à 5 Mo et le code de sortie 0 sur une entrée invalide ;
  - serveur : démarré sur un port éphémère, avec un **faux `gh`** (script Node placé en tête du `PATH`, avec un `gh.cmd` pour Windows) qui renvoie les fixtures. On vérifie `/state`, la réception SSE d'un événement ajouté au journal en moins de 2 s, la reprise avec `Last-Event-ID`, le recalage et les cas de sécurité de l'ADR 0005 ;
  - cycle complet : rejouer la séquence de fixtures d'un agent en arrière-plan (`requested` → `launched` → `started` → `reported` → `finished` → `feature.status`) dans le réducteur, puis vérifier l'état final.
- **Front 3D** : pas de test WebGL automatisé au MVP. On fait un **smoke manuel**, documenté dans la PR, avec le skill `run` et le navigateur intégré : la page se charge, il n'y a pas d'erreur console, un événement ajouté au journal anime la feature, et le repli texte s'affiche quand WebGL est désactivé.
- **CI** : GitHub Actions, matrice `ubuntu-latest` et `windows-latest`, Node 22 : `npm ci`, `npm run lint`, `npm test`, `bash -n scripts/bootstrap.sh`. `claude plugin validate .` reste une vérification locale obligatoire si la CLI ne s'installe pas en CI.
- **Couverture** : `node --test --experimental-test-coverage`, en information uniquement. Pas de seuil bloquant au MVP, mais les modules purs doivent dépasser 80 % de lignes.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Vitest ou Jest | Écosystème, watch, snapshots | Dépendances supplémentaires, et sans valeur décisive pour des modules CommonJS et ES simples |
| Playwright (test visuel de la scène) | Couvre le rendu | Lourd (navigateurs à télécharger en CI), tests fragiles sur WebGL, coût disproportionné au MVP |
| Pas de tests d'intégration du serveur | Plus rapide | Laisse sans couverture la sécurité (ADR 0005) et le temps réel, qui sont les risques principaux |

## Conséquences

- Les features doivent chacune livrer leurs tests unitaires, et des tests d'intégration dès qu'il y a de l'I/O (fichier, HTTP, SSE, `gh`).
- La séparation entre modules purs et rendu est une **contrainte d'architecture** : un module de `viz/public/js/` qui importe `three` ne peut contenir aucune logique de décision.
- Le testeur utilise `npm test` et `npm run lint` comme suite de non-régression du repo.
