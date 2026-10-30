# Roadmap — claude-gepet-squad : visualisation 3D temps réel (`/gepet-squad-viz`)

Référence : [ARCHITECTURE.md](architecture/ARCHITECTURE.md) et ses ADR. Versions du plugin : **0.2.0** (M1, collecte), **0.3.0** (M2, serveur), **0.4.0** (M3, vue 3D et commande).

## Vue d'ensemble
| Milestone | Objectif livrable (démontrable) | Features | Sous-projets |
|---|---|---|---|
| M1 — Socle et collecte | Pendant un cycle squad réel, `<git-common-dir>/gepet-squad/events.jsonl` se remplit d'événements v1 (agents, transitions `gh`), et `npm test` / `npm run lint` passent en CI sur ubuntu et windows | F-01…F-04 | repo, hooks |
| M2 — Serveur temps réel | `node viz/server.cjs --project <dir>` sert `/state` (état fusionné journal + GitHub), pousse les nouveaux événements en SSE et gère `status` / `stop` ; le modèle client (`state.js`, `layout.js`) est prêt et testé | F-05…F-09, F-15 | viz-server, viz-web |
| M3 — Vue 3D et commande | `/gepet-squad-viz` ouvre une page 3D qui montre le pipeline, les features et les agents lumineux en temps réel ; repli texte sans WebGL ; plugin en 0.4.0 | F-10…F-14 | viz-web, skills |

## Graphe de dépendances
```
F-01 → F-02 → F-03 → F-04
F-01 → F-06
F-02 → F-05 → F-09
F-04 + F-05 + F-06 → F-07 → F-08   (F-07 réutilise hooks/lib/journal.cjs pour résoudre le journal)
F-01 → F-10
F-08 + F-09 + F-10 → F-11 → F-12
                     F-11 → F-13
F-08 → F-15
F-12 + F-13 + F-15 → F-14
```
Parallélisations prévues : F-05 ∥ F-06 puis F-07 ∥ F-09 (M2) ; F-12 ∥ F-13 (M3).
À ne pas paralléliser : deux features qui touchent `hooks/hooks.json` (seule F-04 le modifie) ; F-07, F-08 et F-15 (mêmes fichiers `http.cjs` / `server.cjs`).

Versionnage (`CLAUDE.md` : bump + CHANGELOG à chaque changement de comportement) : la **dernière feature de chaque milestone** fait le bump mineur de `.claude-plugin/plugin.json` et rédige l'entrée de `CHANGELOG.md` de son milestone ; aucune autre feature ne touche ces deux fichiers. F-04 → 0.2.0, F-15 → 0.3.0, F-14 → 0.4.0.

---

## M1 — Socle et collecte
**Objectif** : poser l'outillage du repo et capter de façon fiable le cycle de vie des agents et les transitions du CP dans un journal local.
**Définition de fin** : F-01 à F-04 mergées ; la CI est verte sur ubuntu et windows ; un cycle squad jetable produit un `events.jsonl` conforme au schéma v1, et le test du garde-fou de `CLAUDE.md` passe toujours. Les points ouverts de l'ADR 0004 sont confirmés par une capture réelle (`claude --plugin-dir . --debug-file <f>`, un agent synchrone et un agent en arrière-plan), faite par le CP ou l'utilisateur, et les fixtures `doc` sont remplacées ou confirmées ; en cas d'écart, un correctif est ouvert sur `normalize.cjs` et l'architecte rédige l'ADR complémentaire.

### F-01 · [repo] Mettre en place l'outillage de lint, de tests et de CI
## Contexte
Le plugin n'a aujourd'hui ni tests automatisés ni lint : il ne contenait que des prompts, un script bash et un hook. La visualisation ajoute du code Node et navigateur qui doit être testé et linté par la squad (vérificateur, testeur) avec des commandes uniques. Cette feature pose le socle commun à tous les scopes, sans aucune dépendance à l'exécution pour l'utilisateur du plugin.

## Objectif
`npm ci && npm run lint && npm test` fonctionnent à la racine, localement et en CI GitHub Actions sur ubuntu et windows.

## Critères d'acceptance
- [ ] `package.json` racine `"private": true`, `engines.node >= 22`, sans `dependencies`, avec les seules `devDependencies` `eslint` 10, `@eslint/js` 10 et `globals` 17, figées par `package-lock.json` ; scripts `test` (`node --test`) et `lint` (`eslint .`).
- [ ] `eslint.config.mjs` (flat config) : globals Node pour `**/*.cjs` et `tests/**`, globals navigateur pour `viz/public/js/**`, `viz/public/vendor/**` et `node_modules/**` ignorés, et règle `no-restricted-properties` (ou `no-restricted-syntax`) qui interdit `innerHTML` / `outerHTML` dans `viz/public/js/**`. `npm run lint` passe sur le code existant (`hooks/guard.cjs`).
- [ ] `tests/helpers/eslint-rules.test.mjs` utilise l'API `ESLint` : `lintText("el.innerHTML = x", { filePath: "viz/public/js/x.js" })` produit une erreur, et le même code avec `filePath: "hooks/x.cjs"` n'est pas soumis à cette règle.
- [ ] `tests/helpers/` fournit : création d'un repo git temporaire avec un worktree, installation d'un faux `gh` dans un `PATH` temporaire (script node + `gh.cmd` pour Windows) qui renvoie des réponses JSON de fixture et journalise ses arguments, et un client SSE minimal basé sur `node:http`.
- [ ] `.github/workflows/ci.yml` : sur PR vers `develop` et push sur `develop`, matrice `ubuntu-latest` × `windows-latest`, Node 22, étapes `npm ci` → `npm run lint` → `npm test` → `bash -n scripts/bootstrap.sh`.
- [ ] `.gitattributes` marque `viz/public/vendor/**` en `linguist-vendored`.
- [ ] Tests unitaires : aucun module métier ici ; un test `tests/helpers/helpers.test.cjs` vérifie les fonctions pures des helpers (construction du `PATH`, parsing d'un flux SSE en événements).
- [ ] Tests d'intégration : `tests/helpers/helpers.test.cjs` crée réellement un repo git temporaire et un worktree (et vérifie que `git rev-parse --git-common-dir` donne le même dossier depuis les deux), exécute le faux `gh` via `execFile` et vérifie sa sortie et son journal d'arguments, sur Linux et Windows.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`, `claude plugin validate .`, `bash -n scripts/bootstrap.sh`).

## Notes techniques
- Sous-projet : racine (`repo`)
- ADR de référence : `docs/architecture/adr/0002-stack-sans-build-three-vendore-sse.md`, `0006-strategie-de-tests.md`
- Fichiers / modules concernés : `package.json`, `package-lock.json`, `eslint.config.mjs`, `.github/workflows/ci.yml`, `.gitattributes`, `.gitignore`, `tests/helpers/`
- Contraintes : aucune dépendance npm à l'exécution ; Node ≥ 22 ; code et messages en français ; ne pas modifier `hooks/guard.cjs` ni `hooks/hooks.json`.

## Skills / outils recommandés
- `engineering:testing-strategy` : organisation de `tests/` et des helpers.
- Documentation ESLint 10 (flat config) et GitHub Actions `actions/setup-node`.

## Dépendances
- aucune

## Taille
M

### F-02 · [hooks] Normaliser les payloads de hooks d'agent en événements v1
## Contexte
La vue doit savoir quel agent de la squad travaille, sur quelle feature, et quand il a fini, y compris pour les agents lancés en arrière-plan (ADR 0004). Cette feature pose le **contrat schéma d'événement v1** consommé par `viz-server`, et la normalisation pure des payloads de hooks. Elle valide aussi, avec des payloads réels, les hypothèses de l'ADR 0004 avant que le reste du collecteur ne s'appuie dessus.

## Objectif
`hooks/lib/schema.cjs` et `hooks/lib/normalize.cjs` transforment chaque payload de hook pertinent en événement v1 conforme, ou en `null`, vérifié sur des fixtures réelles.

## Critères d'acceptance
- [ ] `hooks/lib/schema.cjs` exporte la liste des types v1 (ARCHITECTURE § 6), les champs autorisés et une fonction `validate(event)` qui rejette tout champ inconnu, tout type inconnu et toute ligne sérialisée de plus de 4 Ko.
- [ ] Fixtures dans `tests/fixtures/hooks/` pour `PreToolUse` Agent, `PostToolUse` Agent (`async_launched` et `completed`), `SubagentStart`, `SubagentStop` et `PreToolUse` SubagentHandback, capturées avec `claude --debug-file` dans un projet jetable et anonymisées. À défaut de capture réelle, une fixture tirée de la documentation officielle est acceptée si elle porte `"_provenance": "doc:<URL>"`. Un `tests/fixtures/hooks/README.md` indique la provenance de chaque fixture et l'état des deux points ouverts de l'ADR 0004 (déclenchement de `SubagentStart`/`SubagentStop` en arrière-plan, format `agentId` vs `agent_id`) : « confirmé par capture » ou « non confirmé ». Les points non confirmés sont signalés dans les « Points d'attention » du rapport.
- [ ] Étant donné chaque fixture, `normalize(payload)` renvoie l'événement attendu (`agent.requested` avec `mode`, `issue`, `pr` extraits du prompt ; `agent.launched` ; `agent.started` ; `agent.reported` avec `block` et `verdict` ; `agent.finished` avec `source` `tool` ou `stop`).
- [ ] Un payload d'un agent qui n'est pas `claude-gepet-squad:*`, un outil non suivi ou un JSON incomplet donne `null` sans exception.
- [ ] Minimisation : aucun événement produit ne contient le prompt, `last_assistant_message`, `tool_input.message` ni `content` (test qui vérifie l'absence de ces textes dans la sortie sérialisée).
- [ ] Les identifiants `agent-xxx` et `xxx` sont normalisés sous la même forme.
- [ ] Tests unitaires : `tests/hooks/schema.test.cjs` et `tests/hooks/normalize.test.cjs` couvrent chaque type, chaque fixture, les cas `null`, la minimisation et la limite de 4 Ko.
- [ ] Tests d'intégration : sans objet (modules purs, aucune I/O) — la capture des fixtures est documentée dans la PR.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `hooks`
- ADR de référence : `0003-journal-evenements-et-etat-fusionne.md`, `0004-capture-cycle-de-vie-des-agents.md`
- Fichiers / modules concernés : `hooks/lib/schema.cjs`, `hooks/lib/normalize.cjs`, `tests/hooks/`, `tests/fixtures/hooks/`
- Contraintes : modules purs (aucune I/O) ; `node:*` uniquement ; ne pas modifier `hooks/hooks.json`. Si la capture montre que `SubagentStop` ne se déclenche pas en arrière-plan, le signaler dans `Points d'attention` du rapport : le CP déclenchera l'ADR complémentaire.

## Skills / outils recommandés
- `plugin-authoring` : forme des payloads et des événements de hooks.
- Documentation officielle des hooks (code.claude.com/docs/en/hooks) et `claude --debug-file` pour la capture.
- `engineering:testing-strategy`.

## Dépendances
- F-01

## Taille
M

### F-03 · [hooks] Traduire les commandes `gh` du CP en événements v1
## Contexte
Après chaque rapport d'agent, le Chef de projet change le statut des issues et merge les PR via `gh`. Ces transitions font foi pour l'état des features entre deux recalages GitHub (ADR 0004, signal 6). Cette feature traduit une ligne de commande Bash en zéro, un ou plusieurs événements v1, de manière pure et testable.

## Objectif
`hooks/lib/gh-command.cjs` convertit toutes les formes de commandes `gh` utilisées par le CP en événements v1 conformes à `schema.cjs`.

## Critères d'acceptance
- [ ] Étant donné `gh issue edit 12 --repo o/r --remove-label status:ready --add-label status:in-progress`, alors un événement `feature.status` `{issue: 12, status: "in-progress"}` est produit ; `--add-label retry:2` produit `feature.retry` `{issue, retry: 2}` ; des labels séparés par des virgules sont gérés.
- [ ] `gh pr create … --head feature/12-x` → `pr.opened` (avec `issue` déduit de la branche) ; `--head release/m1-socle` → `release.opened` ; `gh pr merge 34` → `pr.merged` ; `gh issue close 12` → `issue.closed` ; `gh issue create … --milestone` → `issue.created` ; `gh api -X PATCH repos/o/r/milestones/3 -f state=closed` → `milestone.changed`.
- [ ] Les commandes chaînées (`&&`, `||`, `;`, retour à la ligne) sont découpées comme dans `guard.cjs`, et chaque segment est traité ; les guillemets simples et doubles sont respectés.
- [ ] Une commande non `gh`, une commande `gh` non suivie (`gh pr view`, `gh issue list`) ou une syntaxe inconnue donne une liste vide, sans exception.
- [ ] Tests unitaires : `tests/hooks/gh-command.test.cjs` couvre chaque commande de `skills/gepet-squad/references/github-conventions.md` et de `skills/gepet-squad/SKILL.md` (fixtures texte dans `tests/fixtures/gh/`), les chaînages, les guillemets et les cas vides ; chaque événement passe `validate()`.
- [ ] Tests d'intégration : sans objet (module pur, aucune I/O).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `hooks`
- ADR de référence : `0004-capture-cycle-de-vie-des-agents.md`
- Fichiers / modules concernés : `hooks/lib/gh-command.cjs`, `tests/hooks/gh-command.test.cjs`, `tests/fixtures/gh/`
- Contraintes : module pur ; `guard.cjs` reste inchangé (reprendre sa logique de découpage, sans le modifier ni l'importer s'il n'exporte rien).

## Skills / outils recommandés
- `engineering:testing-strategy` : tests pilotés par table.

## Dépendances
- F-02

## Taille
S

### F-04 · [hooks] Brancher le collecteur et écrire le journal d'événements
## Contexte
Les modules purs de F-02 et F-03 doivent être appelés par Claude Code à chaque hook pertinent, et leur sortie écrite dans un journal local partagé entre la session principale et les worktrees des agents. Le collecteur ne doit jamais ralentir ni faire échouer la session de l'utilisateur, et ne s'active que dans un projet squad.

## Objectif
Dans un repo qui contient `.gepet-squad.json`, chaque hook suivi ajoute une ligne v1 à `<git-common-dir>/gepet-squad/events.jsonl`, sans jamais bloquer la session.

## Critères d'acceptance
- [ ] `hooks/hooks.json` déclare, en plus de l'entrée `guard.cjs` inchangée, des entrées `"async": true` qui appellent `node "${CLAUDE_PLUGIN_ROOT}/hooks/events.cjs"` : `PreToolUse` (`Agent|Task` et `SubagentHandback`), `PostToolUse` (`Agent|Task` et `Bash`), `SubagentStart` et `SubagentStop` (matcher `^claude-gepet-squad:`).
- [ ] `hooks/lib/journal.cjs` résout le journal par `git rev-parse --git-common-dir` depuis le `cwd` du payload, crée le dossier `gepet-squad/` si besoin, ajoute une ligne par `fs.appendFileSync`, et fait tourner le fichier au-delà de 5 Mo (`events.jsonl` → `events.1.jsonl`, un seul ancien conservé).
- [ ] Étant donné un `cwd` hors d'un repo contenant `.gepet-squad.json` (recherche en remontant, comme `guard.cjs`), aucun fichier n'est écrit.
- [ ] Étant donné un stdin invalide, un payload inconnu ou une erreur d'écriture, `events.cjs` sort avec le code 0, n'écrit rien sur stdout et trace l'erreur dans `collector.log`, borné à 256 Ko.
- [ ] Le même journal est alimenté depuis le repo principal et depuis un worktree du même repo.
- [ ] Tests unitaires : `tests/hooks/journal.test.cjs` couvre le calcul du chemin, la décision de rotation et le bornage du log (fonctions pures extraites).
- [ ] Tests d'intégration : `tests/hooks/events.test.cjs` exécute `hooks/events.cjs` en sous-processus avec chaque fixture de F-02 et une commande `gh` de F-03 sur stdin, dans un repo git temporaire avec `.gepet-squad.json` et dans un de ses worktrees, puis vérifie les lignes écrites ; cas hors squad (rien écrit), stdin invalide (code 0, stdout vide, `collector.log` alimenté), rotation au-delà de 5 Mo.
- [ ] Le test manuel du garde-fou de `CLAUDE.md` (`git push origin main` refusé) passe toujours, résultat collé dans la PR.
- [ ] Versionnage (dernière feature de M1) : `.claude-plugin/plugin.json` passe en `0.2.0` et `CHANGELOG.md` reçoit une entrée `0.2.0` qui décrit le collecteur d'événements (hooks async, journal local, données minimisées).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`, `claude plugin validate .`).

## Notes techniques
- Sous-projet : `hooks`
- ADR de référence : `0003-journal-evenements-et-etat-fusionne.md`, `0004-capture-cycle-de-vie-des-agents.md`, `0005-securite-serveur-local.md`
- Fichiers / modules concernés : `hooks/events.cjs`, `hooks/lib/journal.cjs`, `hooks/hooks.json`, `tests/hooks/`, `.claude-plugin/plugin.json`, `CHANGELOG.md`
- Contraintes : `async: true` partout ; code 0 toujours ; aucune donnée de prompt ni de rapport dans le journal ; `guard.cjs` inchangé ; seule feature qui modifie `hooks/hooks.json`.

## Skills / outils recommandés
- `plugin-authoring` : déclaration des hooks, matchers, `async`.
- `engineering:testing-strategy`.

## Dépendances
- F-02, F-03

## Taille
M

---

## M2 — Serveur temps réel
**Objectif** : fournir un serveur local sécurisé qui expose l'état fusionné et le flux temps réel, et le modèle client prêt à être rendu.
**Définition de fin** : F-05 à F-09 et F-15 mergées ; `node viz/server.cjs --project <projet squad>` sert `/state` et reçoit en SSE, en moins de 2 s, un événement ajouté au journal ; `status` et `stop` fonctionnent ; plugin en 0.3.0 ; CI verte.

### F-05 · [viz-server] Calculer l'état fusionné par un réducteur pur
## Contexte
La vue a besoin d'un état unique — features, agents, milestones, releases — à partir de deux sources : l'instantané GitHub, qui fait foi, et les événements du journal, qui animent l'intervalle entre deux recalages. Cette feature pose le **contrat `/state`** consommé par `viz-web` et toute la logique de corrélation des agents (ADR 0003, 0004).

## Objectif
`viz/lib/reducer.cjs` calcule, de manière pure, l'état `/state` à partir d'un instantané et d'une suite d'événements v1.

## Critères d'acceptance
- [ ] `reduce(snapshot, events, now)` renvoie `{ repo, updatedAt, milestones[], features[], agents[], releases[], warnings[{code, message, at}] }` dans la forme d'ARCHITECTURE § 6 ; la forme est documentée en tête de module.
- [ ] Correspondance statut → station conforme à ARCHITECTURE § 6 (`backlog`/`ready` → Roadmap, `in-progress`/`changes-requested` → Dev, `in-review` → Vérification, `in-test` → Test, `done` → Merge, milestone fermé ou `release.opened` → Release, `blocked` → zone escalade accolée à la dernière station connue par le journal, **Dev** par défaut si le journal ne la donne pas).
- [ ] Purge des agents : sont conservés tous les agents non `finished` de la session la plus récente (`sessionId`), et les agents `finished` de cette session depuis moins de 10 min (horloge injectée) ; tous les autres sont retirés de `agents[]`.
- [ ] Étant donné un événement `feature.status` plus récent que l'instantané, la feature change de station ; étant donné un nouvel instantané qui contredit le journal, l'instantané gagne.
- [ ] Corrélation des agents : clé `toolUseId` puis `agentId`, FIFO par `agentType` en l'absence de correspondance, au plus un agent `developpeur`/`verificateur`/`testeur` actif par issue, `agent.finished` idempotent, et un agent sans signal depuis 45 min passe en `unknown` sans être déclaré fini.
- [ ] Un `feature.status` qui fait sortir l'issue de la station de son agent marque cet agent `finished`.
- [ ] Tests unitaires : `tests/viz-server/reducer.test.cjs` couvre chaque statut, la priorité GitHub, un cycle complet synchrone et un cycle en arrière-plan rejoués à partir des fixtures de F-02, la FIFO, l'idempotence, le passage en `unknown`, la station de `blocked` (avec et sans journal), la purge des agents et `warnings[]` (horloge injectée).
- [ ] Tests d'intégration : sans objet (module pur) ; le cycle complet est rejoué en unitaire.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server` (`viz/`)
- ADR de référence : `0003-journal-evenements-et-etat-fusionne.md`, `0004-capture-cycle-de-vie-des-agents.md`, `0007-logique-metier-sur-mesure.md`
- Fichiers / modules concernés : `viz/lib/reducer.cjs`, `tests/viz-server/reducer.test.cjs`
- Contraintes : module pur ; lit `hooks/lib/schema.cjs` par chemin relatif ; GitHub fait foi.

## Skills / outils recommandés
- `engineering:system-design` : modèle d'état et corrélation.
- `engineering:testing-strategy`.

## Dépendances
- F-02

## Taille
M

### F-06 · [viz-server] Récupérer l'instantané GitHub via `gh`
## Contexte
GitHub est la source de vérité du projet squad : labels `status:*` et `retry:*`, milestones, PR. Le serveur doit en tirer un instantané au démarrage puis toutes les 60 s, en réutilisant l'authentification `gh` de l'utilisateur, sans token et sans shell.

## Objectif
`viz/lib/github.cjs` produit un instantané normalisé du projet à partir de `gh`, ou une erreur explicite.

## Critères d'acceptance
- [ ] `fetchSnapshot({ repo, cwd })` appelle `gh` par `execFile` avec des arguments en tableau (issues avec labels et milestone, milestones avec état, PR ouvertes et mergées vers `develop` et `main`), avec un délai maximum de 15 s par appel, et renvoie `{ repo, fetchedAt, issues[], milestones[], pulls[] }`.
- [ ] Le repo est lu dans `.gepet-squad.json` et validé par `^[\w.-]+/[\w.-]+$` ; un repo invalide est refusé avant tout appel à `gh`.
- [ ] Si `gh` est absent, non authentifié, hors délai ou renvoie un JSON invalide, la fonction rejette avec une erreur typée (`GH_MISSING`, `GH_AUTH`, `GH_TIMEOUT`, `GH_PARSE`) sans planter le processus.
- [ ] Tests unitaires : `tests/viz-server/github.test.cjs` couvre la validation du repo et la normalisation des réponses `gh` (fonctions pures extraites, fixtures JSON dans `tests/fixtures/gh-json/`).
- [ ] Tests d'intégration : avec le faux `gh` de `tests/helpers/` dans le `PATH`, `fetchSnapshot` renvoie l'instantané attendu ; les arguments passés à `gh` sont vérifiés ; les cas `gh` absent, code de sortie non nul (auth), délai dépassé et JSON invalide donnent la bonne erreur ; sur Linux et Windows.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server` (`viz/`)
- ADR de référence : `0003-journal-evenements-et-etat-fusionne.md`, `0005-securite-serveur-local.md`
- Fichiers / modules concernés : `viz/lib/github.cjs`, `tests/viz-server/github.test.cjs`, `tests/fixtures/gh-json/`
- Contraintes : `execFile` sans shell ; aucun token manipulé ; `node:*` uniquement.

## Skills / outils recommandés
- `engineering:testing-strategy` : faux `gh` dans le `PATH`.

## Dépendances
- F-01

## Taille
S

### F-07 · [viz-server] Servir `/state` et les fichiers statiques de façon sécurisée
## Contexte
Le navigateur de l'utilisateur doit pouvoir charger la page et l'état fusionné depuis un serveur local, sans exposer quoi que ce soit au réseau ni aux autres sites ouverts dans le navigateur (DNS rebinding, CORS, traversée de chemin). Cette feature pose la CLI `node viz/server.cjs` consommée par la commande `/gepet-squad-viz`.

## Objectif
`node viz/server.cjs --project <dir> [--port 0]` démarre un serveur `127.0.0.1` qui sert `/health`, `/state` et `viz/public/` avec les protections de l'ADR 0005.

## Critères d'acceptance
- [ ] Le serveur écoute uniquement sur `127.0.0.1` (port `0` par défaut), affiche `[gepet-squad-viz] info http://127.0.0.1:<port>` sur stderr et écrit `<git-common-dir>/gepet-squad/viz.lock` (`{port, pid}`), supprimé à l'arrêt propre (SIGINT/SIGTERM).
- [ ] `GET /state` renvoie le JSON du réducteur (instantané F-06 + journal lu en entier au démarrage) ; `GET /health` renvoie `{ok: true}`.
- [ ] Les fichiers statiques sont servis depuis `--public-dir` (par défaut `viz/public`) ; les tests utilisent `tests/fixtures/public/` (avec un `index.html` qui contient un importmap, pour le test de l'empreinte CSP).
- [ ] Un en-tête `Host` autre que `127.0.0.1:<port>` ou `localhost:<port>` → 421 ; méthode autre que GET/HEAD → 405 ; chemin qui sort du `--public-dir` (y compris encodé, `..%2f`, `%2e%2e`) → 403 ; fichier absent → 404 ; aucun en-tête CORS.
- [ ] Chaque réponse porte la CSP de l'ADR 0005 (avec l'empreinte `sha256` de l'importmap calculée au démarrage depuis l'`index.html` du `--public-dir`, ou sans empreinte si l'`index.html` n'a pas d'importmap), `X-Content-Type-Options: nosniff` et `Referrer-Policy: no-referrer`.
- [ ] Si `.gepet-squad.json` est absent du projet, le serveur sort avec un code non nul et un message clair ; si `gh` échoue au démarrage, il sert un état vide avec une entrée dans `warnings[]` de `/state`.
- [ ] Tests unitaires : `tests/viz-server/http.test.cjs` couvre le contrôle de `Host`, la résolution des chemins statiques, le calcul de l'empreinte et la construction des en-têtes (fonctions pures).
- [ ] Tests d'intégration : `tests/viz-server/server.test.cjs` démarre le serveur sur un port éphémère avec le faux `gh` et un journal de fixture, vérifie `/health`, `/state`, un fichier statique, les codes 421/405/403/404, les en-têtes, la création et la suppression de `viz.lock`, sur Linux et Windows.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server` (`viz/`)
- ADR de référence : `0005-securite-serveur-local.md`, `0003-journal-evenements-et-etat-fusionne.md`
- Fichiers / modules concernés : `viz/server.cjs`, `viz/lib/http.cjs`, `tests/viz-server/`, `tests/fixtures/public/`
- Contraintes : `node:*` uniquement ; lecture seule ; la résolution du journal réutilise `hooks/lib/journal.cjs`. **Ne pas toucher `viz/public/`** (scope `viz-web`).

## Skills / outils recommandés
- `engineering:system-design`, `engineering:testing-strategy`.
- `run` : démarrer le serveur et vérifier les réponses.

## Dépendances
- F-04, F-05, F-06

## Taille
M

### F-08 · [viz-server] Pousser les événements du journal en SSE et se recaler sur GitHub
## Contexte
Le « temps réel » de la vue repose sur le suivi du journal : chaque événement ajouté par le collecteur doit arriver au navigateur en moins de 2 s, et la vue doit se recaler sur GitHub toutes les 60 s. Sous Windows, `fs.watch` n'est pas fiable : on suit le fichier par offset (ADR 0003).

## Objectif
`GET /events` diffuse en SSE les nouveaux événements du journal, les instantanés de recalage et les avertissements, avec reprise par `Last-Event-ID`.

## Critères d'acceptance
- [ ] `viz/lib/tail.cjs` suit `events.jsonl` par offset avec `fs.watchFile` (500 ms), gère une ligne partielle (attente du `\n`), la rotation (`events.jsonl` recréé plus petit → reprise à 0) et ignore les lignes qui ne passent pas `validate()`.
- [ ] `GET /events` répond `text/event-stream` ; chaque événement du journal est envoyé en `event: evt` avec `id` = `<génération>:<offset>`, la génération étant incrémentée à chaque rotation détectée ; un battement de commentaire est envoyé toutes les 15 s ; une reconnexion avec un `Last-Event-ID` de la génération courante reçoit les événements postérieurs à cet offset ; un `Last-Event-ID` inconnu ou d'une autre génération reçoit d'abord un `snapshot` complet, puis le flux.
- [ ] Toutes les 60 s (intervalle injectable), le serveur reprend l'instantané GitHub et pousse `event: snapshot` avec l'état fusionné ; si `gh` échoue, il garde le dernier instantané et pousse `event: warning` avec le code d'erreur.
- [ ] Les connexions SSE fermées par le client sont libérées (aucune fuite d'écouteur après 20 connexions/déconnexions).
- [ ] Tests unitaires : `tests/viz-server/tail.test.cjs` couvre le découpage en lignes, la ligne partielle, la détection de rotation et le formatage SSE (fonctions pures).
- [ ] Tests d'intégration : `tests/viz-server/sse.test.cjs` démarre le serveur (faux `gh`, journal temporaire), connecte le client SSE de `tests/helpers/`, ajoute une ligne au journal et la reçoit en moins de 2 s ; vérifie la reprise par `Last-Event-ID` (même génération, et génération périmée → `snapshot` puis flux), la rotation, le `snapshot` (intervalle réduit) et le `warning` quand le faux `gh` échoue ; sur Linux et Windows.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server` (`viz/`)
- ADR de référence : `0002-stack-sans-build-three-vendore-sse.md`, `0003-journal-evenements-et-etat-fusionne.md`
- Fichiers / modules concernés : `viz/lib/tail.cjs`, `viz/lib/http.cjs`, `viz/server.cjs`, `tests/viz-server/`
- Contraintes : pas de WebSocket ; `node:*` uniquement ; ne pas paralléliser avec F-07 ni F-15 ; ne pas toucher `viz/public/`.

## Skills / outils recommandés
- `engineering:system-design` : SSE, reprise, recalage.
- `engineering:testing-strategy` ; `run`.

## Dépendances
- F-07

## Taille
M

### F-09 · [viz-web] Appliquer les événements et calculer la disposition côté client
## Contexte
La scène 3D doit rester testable sans WebGL : toute la logique de décision du front (appliquer un événement SSE à l'état, placer les stations, les files de features et les agents) vit dans des modules purs, sans import de `three`. Cette feature prépare le modèle que F-11 et F-13 rendront.

## Objectif
`viz/public/js/state.js` et `viz/public/js/layout.js` calculent l'état client et les positions 3D à partir de `/state` et des événements SSE.

## Critères d'acceptance
- [ ] `state.js` : `init(state)` puis `apply(model, message)` pour les messages `evt`, `snapshot` et `warning` ; un `snapshot` remplace l'état ; un `evt` met à jour la feature ou l'agent concerné selon les mêmes règles de station que le réducteur serveur ; `apply` renvoie aussi la liste des transitions à animer (`{kind, id, from, to}`).
- [ ] `layout.js` : positions fixes et ordonnées des 7 stations sur un axe, plus la zone escalade ; positions des features en file dans chaque station (grille stable triée par numéro, regroupée par milestone), positions des agents au-dessus de la feature qu'ils traitent ou de leur station ; les positions sont déterministes.
- [ ] Avec 100 features dans une même station, aucune paire de positions n'est identique et toutes tiennent dans la boîte de la station.
- [ ] Aucun des deux modules n'importe `three` ni n'accède au DOM (vérifié par un test qui charge les modules dans Node).
- [ ] Test de parité `tests/viz-web/stations-parity.test.mjs` : pour chaque statut `status:*`, plus `blocked` et le milestone fermé, la station calculée par `state.js` est identique à celle de `viz/lib/reducer.cjs` (chargé en lecture par `createRequire`, sans modifier `viz-server`).
- [ ] Tests unitaires : `tests/viz-web/state.test.mjs`, `tests/viz-web/layout.test.mjs` et `tests/viz-web/stations-parity.test.mjs` couvrent chaque type de message, la liste des transitions, le déterminisme, le cas 100 features, la zone escalade et la parité des stations.
- [ ] Tests d'intégration : sans objet (modules purs).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web` (`viz/public`)
- ADR de référence : `0006-strategie-de-tests.md`, `0007-logique-metier-sur-mesure.md`
- Fichiers / modules concernés : `viz/public/js/state.js`, `viz/public/js/layout.js`, `tests/viz-web/`
- Contraintes : modules ES purs, sans `three` ni DOM ; contrat `/state` de F-05.

## Skills / outils recommandés
- `dataviz` : encodage des statuts, lisibilité des files.
- `engineering:testing-strategy`.

## Dépendances
- F-05

## Taille
M

### F-15 · [viz-server] Gérer le cycle de vie du serveur : status, stop et démarrage unique
## Contexte
La commande `/gepet-squad-viz` doit pouvoir savoir si un serveur tourne déjà pour le projet, réafficher son URL, nettoyer un verrou périmé et arrêter le serveur. Cette logique (pid vivant ou non, arrêt du processus) doit vivre dans le serveur, testée sur Linux et Windows, et non dans un skill Markdown. C'est la dernière feature de M2 : elle porte le bump 0.3.0.

## Objectif
`node viz/server.cjs` expose les sous-commandes `status` et `stop`, et refuse de lancer un second serveur pour un même projet.

## Critères d'acceptance
- [ ] `node viz/server.cjs status --project <dir>` affiche l'URL et sort avec le code 0 si le pid de `viz.lock` est vivant ; sinon il sort avec le code 1 et supprime un verrou périmé.
- [ ] `status --wait <s>` attend jusqu'à `<s>` secondes l'apparition d'un verrou vivant avant de répondre.
- [ ] `node viz/server.cjs stop --project <dir>` arrête le processus par `process.kill`, attend sa fin, supprime le verrou et sort avec le code 0 ; sans serveur vivant, il sort avec le code 1 et un message clair.
- [ ] Un démarrage alors qu'un serveur vivant existe pour ce projet affiche l'URL existante et sort avec le code 0, sans lancer un second serveur.
- [ ] Versionnage (dernière feature de M2) : `.claude-plugin/plugin.json` passe en `0.3.0` et `CHANGELOG.md` reçoit une entrée `0.3.0` qui décrit le serveur local (`/state`, SSE, sécurité, `status`/`stop`).
- [ ] Tests unitaires : `tests/viz-server/cli.test.cjs` couvre le parsing de la CLI (sous-commandes, options, erreurs) et la décision verrou vivant ou périmé (fonction de vérification du pid injectée).
- [ ] Tests d'intégration : `tests/viz-server/lifecycle.test.cjs` démarre un serveur réel (faux `gh`), puis vérifie `status`, le second démarrage (même URL, un seul processus), `stop` (processus arrêté, verrou supprimé), un verrou périmé (pid inexistant → nettoyé) et `status --wait`, sur Linux et Windows.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server` (`viz/`)
- ADR de référence : `0005-securite-serveur-local.md`
- Fichiers / modules concernés : `viz/server.cjs`, `viz/lib/lock.cjs`, `tests/viz-server/`, `.claude-plugin/plugin.json`, `CHANGELOG.md`
- Contraintes : `node:*` uniquement ; ne pas paralléliser avec F-07 ni F-08 ; ne pas toucher `viz/public/`.

## Skills / outils recommandés
- `engineering:testing-strategy` : tests de processus multiplateformes.
- `run` : démarrer, interroger et arrêter le serveur.

## Dépendances
- F-08

## Taille
S

---

## M3 — Vue 3D et commande
**Objectif** : rendre le workflow en 3D dans le navigateur et le rendre accessible par `/gepet-squad-viz`.
**Définition de fin** : F-10 à F-14 mergées ; `/gepet-squad-viz` sur un projet squad ouvre une scène qui reflète l'état GitHub et réagit en direct aux agents ; repli texte vérifié ; plugin en 0.4.0 ; CI verte.

### F-10 · [viz-web] Vendoriser Three.js 0.187.0
## Contexte
Le plugin s'installe sans build ni dépendance npm à l'exécution et doit fonctionner hors ligne : Three.js et ses addons (`OrbitControls`, `CSS2DRenderer`, `EffectComposer`, `UnrealBloomPass`, `OutputPass`) sont donc copiés dans le plugin, à une version épinglée, avec leur licence (ADR 0002).

## Objectif
`viz/public/vendor/three/` contient Three.js 0.187.0 et les addons nécessaires, reproductibles par `scripts/vendor-three.sh`.

## Critères d'acceptance
- [ ] `scripts/vendor-three.sh` (dev uniquement) récupère `three@0.187.0` par `npm pack`, vérifie la version et copie `build/three.module.js`, `build/three.core.js`, les addons listés (et leurs imports internes), `LICENSE`, puis écrit `VERSION` ; il est idempotent et passe `bash -n`.
- [ ] Les fichiers vendorés ne contiennent aucun import vers un chemin absent du dossier (vérifié par un test qui résout récursivement les `import` relatifs et `three` / `three/addons/` selon l'importmap prévu).
- [ ] `viz/public/vendor/three/VERSION` vaut `0.187.0` et `LICENSE` est la licence MIT de Three.js.
- [ ] Tests unitaires : `tests/viz-web/vendor.test.mjs` vérifie `VERSION`, la présence de chaque fichier attendu et la résolution complète des imports.
- [ ] Tests d'intégration : le script est exécuté une fois dans la PR (sortie collée) ; relancé, il ne produit aucune différence (`git status` propre).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint` ignore bien `vendor/`, `npm test`, `bash -n scripts/vendor-three.sh`).

## Notes techniques
- Sous-projet : `viz-web` (`viz/public`)
- ADR de référence : `0002-stack-sans-build-three-vendore-sse.md`
- Fichiers / modules concernés : `scripts/vendor-three.sh`, `viz/public/vendor/three/`, `tests/viz-web/vendor.test.mjs`
- Contraintes : version épinglée 0.187.0 ; aucun CDN ; `linguist-vendored` déjà posé par F-01.

## Skills / outils recommandés
- Documentation Three.js (installation par modules ES, `examples/jsm`).

## Dépendances
- F-01

## Taille
S

### F-11 · [viz-web] Afficher le pipeline et les features en 3D en temps réel
## Contexte
C'est le cœur visible de la brique : l'utilisateur ouvre la page et voit les 7 stations du workflow, les features placées à leur station selon l'état GitHub, mises à jour en direct par le flux SSE. Le rendu s'appuie uniquement sur les modules purs de F-09 et les addons vendorés.

## Objectif
La page servie par `viz-server` affiche une scène Three.js des stations et des features, qui se met à jour en direct à chaque message SSE.

## Critères d'acceptance
- [ ] `index.html` déclare l'importmap (`three`, `three/addons/`) comme unique script inline, charge `js/main.js` en module, et ne déclenche aucune violation de CSP dans la console.
- [ ] `main.js` charge `/state`, ouvre `EventSource('/events')`, applique chaque message par `state.js` et demande le rendu ; un indicateur textuel « connecté / reconnexion » reflète l'état de l'`EventSource`.
- [ ] `scene.js` : les 7 stations sont rendues à leurs positions `layout.js`, les features par un `InstancedMesh` coloré selon la palette des labels `status:*` de `github-conventions.md`, caméra `OrbitControls`, redimensionnement de la fenêtre géré.
- [ ] `labels.js` : noms des stations et numéro + titre des features au survol via `CSS2DRenderer`, uniquement par `textContent` (un titre contenant `<img onerror=…>` s'affiche tel quel).
- [ ] `scene.js` expose `onFrame(cb)` (rappel à chaque image avec le temps écoulé) et `addLayer(obj)` (ajout d'un objet à la scène), pour que F-13 se branche sans modifier `main.js`.
- [ ] Étant donné un serveur lancé sur un projet de fixture, quand une ligne `feature.status` est ajoutée au journal, alors la feature change de station à l'écran en moins de 3 s sans rechargement.
- [ ] Tests unitaires : les fonctions de couleur et de correspondance instance → feature sont extraites en module pur et testées dans `tests/viz-web/` (aucune logique de décision dans `scene.js`).
- [ ] Tests d'intégration : smoke manuel avec le navigateur intégré, documenté dans la PR (commande, capture d'écran avant/après un événement, console sans erreur ni violation CSP).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web` (`viz/public`)
- ADR de référence : `0002-stack-sans-build-three-vendore-sse.md`, `0005-securite-serveur-local.md`, `0006-strategie-de-tests.md`
- Fichiers / modules concernés : `viz/public/index.html`, `viz/public/js/main.js`, `viz/public/js/scene.js`, `viz/public/js/labels.js`, `viz/public/css/`
- Contraintes : `textContent` uniquement ; pas de logique de décision dans les modules qui importent `three` ; `InstancedMesh` pour les features.

## Skills / outils recommandés
- `dataviz` : palette et encodage des statuts.
- `high-end-visual-design` / `impeccable` : composition et finition de la scène.
- `run` et le navigateur intégré (`mcp__Claude_Browser__*`) : smoke, captures, console.
- Documentation et exemples Three.js.

## Dépendances
- F-08, F-09, F-10

## Taille
M

### F-12 · [viz-web] Afficher une vue texte de repli sans WebGL
## Contexte
Sur un poste sans WebGL (pilote, VM, navigateur restreint), la page ne doit pas rester blanche : l'utilisateur doit quand même suivre l'avancement du projet squad. Cette vue texte sert aussi d'alternative accessible à la scène 3D.

## Objectif
Quand WebGL est indisponible, la page affiche une liste texte des stations, des features et des agents actifs, mise à jour en direct.

## Critères d'acceptance
- [ ] `main.js` détecte l'absence de WebGL (échec de création du contexte) et bascule sur `js/fallback.js` sans exception dans la console.
- [ ] La vue de repli liste, par station, les features (`#n titre`, badge retry) et les agents actifs (type, mode, issue), et se met à jour à chaque message SSE ; elle est construite uniquement par `createElement` / `textContent`.
- [ ] Le paramètre d'URL `?mode=texte` force la vue de repli, pour pouvoir la vérifier sur un poste avec WebGL.
- [ ] Tests unitaires : la transformation état → structure de liste est un module pur testé dans `tests/viz-web/fallback.test.mjs` (ordre des stations, tri, badges, agents).
- [ ] Tests d'intégration : smoke manuel avec le navigateur intégré en `?mode=texte`, documenté dans la PR (capture avant/après un événement ajouté au journal).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web` (`viz/public`)
- ADR de référence : `0006-strategie-de-tests.md`
- Fichiers / modules concernés : `viz/public/js/fallback.js`, `viz/public/css/fallback.css`, et dans `viz/public/js/main.js` uniquement le point de bascule
- Contraintes : aucun `innerHTML` ; réutiliser `state.js` sans le dupliquer. **Ne pas toucher** `scene.js`, `agents.js`, `motion.js`, `css/agents.css` (F-13, en parallèle).

## Skills / outils recommandés
- `impeccable` : lisibilité et accessibilité de la liste.
- `run` et le navigateur intégré.

## Dépendances
- F-11

## Taille
S

### F-13 · [viz-web] Animer les agents lumineux et les transitions de features
## Contexte
La métaphore choisie montre les agents comme des entités lumineuses qui travaillent sur les features, et les features qui circulent d'une station à l'autre. C'est ce qui rend visible le travail en cours de la squad, au-delà du simple état des labels.

## Objectif
Les agents actifs apparaissent en entités lumineuses (bloom), les features glissent d'une station à l'autre, les retries et les escalades sont visibles.

## Critères d'acceptance
- [ ] Chaque agent de l'état (`requested`, `running`, `reported`) est rendu par une entité lumineuse dont la couleur dépend de son type (architecte, développeur, vérificateur, testeur), via `EffectComposer` + `RenderPass` + `UnrealBloomPass` + `OutputPass` ; un agent `unknown` est atténué ; un agent `finished` disparaît en fondu.
- [ ] Chaque transition renvoyée par `state.js` anime la feature de sa position de départ à sa position d'arrivée par interpolation (durée et courbe définies dans un module pur), sans bibliothèque de tween.
- [ ] Les features avec `retry ≥ 1` portent un badge visible (CSS2D, `textContent`) ; les features `blocked` sont rendues dans la zone escalade rouge accolée à leur station.
- [ ] `prefers-reduced-motion: reduce` désactive les interpolations (déplacement immédiat) et la pulsation des agents.
- [ ] Tests unitaires : `tests/viz-web/motion.test.mjs` couvre la fonction d'interpolation (bornes, courbe), la couleur par type d'agent et la décision d'opacité par phase (modules purs).
- [ ] Tests d'intégration : smoke manuel avec le navigateur intégré sur un cycle rejoué depuis un journal de fixture (agent lancé → rapport → transition → merge), documenté dans la PR avec captures et console sans erreur.
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web` (`viz/public`)
- ADR de référence : `0002-stack-sans-build-three-vendore-sse.md`, `0007-logique-metier-sur-mesure.md`
- Fichiers / modules concernés : `viz/public/js/agents.js`, `viz/public/js/motion.js`, `viz/public/css/agents.css`, `viz/public/js/scene.js` (branchement par `onFrame` / `addLayer`)
- Contraintes : pas de shader de glow maison ; pas de bibliothèque de tween ; logique de décision hors des modules qui importent `three`. **Ne pas toucher** `main.js`, `fallback.js`, `css/fallback.css` (F-12, en parallèle).

## Skills / outils recommandés
- `animate` / `emil-design-eng` : durées, courbes, pulsation, réduction de mouvement.
- `dataviz` : couleurs des agents distinctes de la palette des statuts.
- `run` et le navigateur intégré.

## Dépendances
- F-11

## Taille
M

### F-14 · [skills] Ajouter la commande `/gepet-squad-viz` et publier la 0.4.0
## Contexte
L'utilisateur doit pouvoir ouvrir la visualisation d'un projet squad d'une seule commande depuis Claude Code, sans connaître la CLI du serveur, et l'arrêter proprement. C'est la dernière feature de M3 : elle livre aussi la documentation et la version 0.4.0 du plugin.

## Objectif
`/gepet-squad-viz` démarre le serveur en arrière-plan et affiche l'URL ; `/gepet-squad-viz stop` l'arrête ; le plugin passe en 0.4.0, documenté.

## Critères d'acceptance
- [ ] `skills/gepet-squad-viz/SKILL.md` (frontmatter valide, `disable-model-invocation: true`, en français) : vérifie la présence de `.gepet-squad.json` en remontant depuis le répertoire courant et `node --version ≥ 22`, avec un message clair sinon ; appelle `node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" status --project <cwd>` et réaffiche l'URL si un serveur tourne ; sinon lance `node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" --project <cwd>` en arrière-plan, puis `status --wait 10` pour afficher l'URL.
- [ ] `/gepet-squad-viz stop` appelle `node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" stop --project <cwd>` et rapporte son résultat ; le skill ne contient aucune logique de pid ni de `kill`.
- [ ] README : section de la commande (usage, prérequis Node ≥ 22, ce qui est capté, confidentialité du journal), mise à jour des sections « Garde-fou » (collecteur async) et « Structure ».
- [ ] Versionnage (dernière feature de M3) : `.claude-plugin/plugin.json` passe en `0.4.0` et `CHANGELOG.md` reçoit une entrée `0.4.0` qui décrit la vue 3D et la commande.
- [ ] Tests unitaires : sans objet (Markdown) ; la logique de cycle de vie est couverte par F-15.
- [ ] Tests d'intégration : `claude plugin validate .` au vert ; smoke documenté dans la PR avec `claude --plugin-dir .` sur un projet squad jetable : `/gepet-squad-viz` (URL affichée et page chargée), second appel (même URL), `/gepet-squad-viz stop` (processus arrêté, `viz.lock` supprimé), appel hors projet squad (message clair).
- [ ] Lint, build et suite de tests complète du sous-projet au vert (`npm run lint`, `npm test`, `claude plugin validate .`).

## Notes techniques
- Sous-projet : `skills` (`skills/gepet-squad-viz`)
- ADR de référence : `0001-decoupage-visualisation-dans-le-plugin.md`, `0005-securite-serveur-local.md`
- Fichiers / modules concernés : `skills/gepet-squad-viz/SKILL.md`, `README.md`, `CHANGELOG.md`, `.claude-plugin/plugin.json`
- Contraintes : `${CLAUDE_PLUGIN_ROOT}` autorisé dans un skill ; aucune modification de `skills/gepet-squad/SKILL.md` ni de `guard.cjs`.

## Skills / outils recommandés
- `plugin-authoring` : frontmatter de skill, slash command.
- `run` : smoke de bout en bout.

## Dépendances
- F-12, F-13, F-15

## Taille
S

---

## Correspondance F-xx → issues GitHub
| Feature | Issue |
|---|---|
| F-01 | #1 |
| F-02 | #2 |
| F-03 | #3 |
| F-04 | #4 |
| F-05 | #5 |
| F-06 | #6 |
| F-07 | #7 |
| F-08 | #8 |
| F-09 | #9 |
| F-10 | #11 |
| F-11 | #12 |
| F-12 | #13 |
| F-13 | #14 |
| F-14 | #15 |
| F-15 | #10 |
