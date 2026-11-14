# Roadmap — gepet-squad : visualisation 3D temps réel (`/gepet-squad-viz`)

Référence : [ARCHITECTURE.md](architecture/ARCHITECTURE.md) et ses ADR. Versions du plugin : **0.2.0** (M1, collecte), **0.3.0** (M2, serveur), **0.4.0** (M3, vue 3D et commande), **0.6.0** (M4, économie de tokens), **0.8.0** (M5, bureau 3D), **0.9.0** (M6, bonshommes vivants).

## Vue d'ensemble
| Milestone | Objectif livrable (démontrable) | Features | Sous-projets |
|---|---|---|---|
| M1 — Socle et collecte | Pendant un cycle squad réel, `<git-common-dir>/gepet-squad/events.jsonl` se remplit d'événements v1 (agents, transitions `gh`), et `npm test` / `npm run lint` passent en CI sur ubuntu et windows | F-01…F-04 | repo, hooks |
| M2 — Serveur temps réel | `node viz/server.cjs --project <dir>` sert `/state` (état fusionné journal + GitHub), pousse les nouveaux événements en SSE et gère `status` / `stop` ; le modèle client (`state.js`, `layout.js`) est prêt et testé | F-05…F-09, F-15 | viz-server, viz-web |
| M3 — Vue 3D et commande | `/gepet-squad-viz` ouvre une page 3D qui montre le pipeline, les features et les agents lumineux en temps réel ; repli texte sans WebGL ; plugin en 0.4.0 | F-10…F-14 | viz-web, skills |
| M4 — Économie de tokens | Rapports d'agents en 5 lignes (détail sur la PR), missions épurées à préfixe stable, état du CP lu à la demande dans GitHub et `docs/roadmap.md` ; plugin en 0.6.0 | F-16…F-18 | skills |
| M5 — Bureau 3D : décor et kanban | `/gepet-squad-viz` montre un bureau 3D low-poly meublé (assets Kenney CC0) et un kanban mural de post-its à la place du pipeline ; agents encore en sphères, placés dans leur zone ; plugin en 0.8.0 | F-19…F-25 | repo, viz-server, viz-web, skills |
| M6 — Bonshommes vivants | Les agents sont de petits bonhommes animés qui entrent, travaillent à leur poste, montrent leur verdict et repartent ; bloom et sphères retirés ; plugin en 0.9.0 | F-26…F-32 | viz-web, skills |

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
F-19 → F-22 → F-23 → F-24 → F-25
F-20 → F-24 ; F-21 → F-24
F-23 → F-26 → F-27 → F-31 → F-28 → F-29 → F-30
F-24 → F-28
F-32 → F-30   (mode « CI locale », ajouté le 2026-11-14 à la demande de l'utilisateur)
```
Parallélisations prévues : F-05 ∥ F-06 puis F-07 ∥ F-09 (M2) ; F-12 ∥ F-13 (M3) ; F-19 ∥ F-20 ∥ F-21 (M5).
À ne pas paralléliser : deux features qui touchent `hooks/hooks.json` (seule F-04 le modifie) ; F-07, F-08 et F-15 (mêmes fichiers `http.cjs` / `server.cjs`).

Versionnage (`CLAUDE.md` : bump + CHANGELOG à chaque changement de comportement) : la **dernière feature de chaque milestone** fait le bump mineur de `.claude-plugin/plugin.json` et rédige l'entrée de `CHANGELOG.md` de son milestone ; aucune autre feature ne touche ces deux fichiers. F-04 → 0.2.0, F-15 → 0.3.0, F-14 → 0.4.0, F-18 → 0.6.0, F-25 → 0.8.0, F-30 → 0.9.0.

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
- [ ] Un payload d'un agent qui n'est ni `gepet-squad:*` ni `claude-gepet-squad:*`, un outil non suivi ou un JSON incomplet donne `null` sans exception.
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
- [ ] `hooks/hooks.json` déclare, en plus de l'entrée `guard.cjs` inchangée, des entrées `"async": true` qui appellent `node "${CLAUDE_PLUGIN_ROOT}/hooks/events.cjs"` : `PreToolUse` (`Agent|Task` et `SubagentHandback`), `PostToolUse` (`Agent|Task` et `Bash`), `SubagentStart` et `SubagentStop` (matcher `^(gepet-squad|claude-gepet-squad):`).
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

## M4 — Économie de tokens
**Objectif** : réduire la consommation de la session principale (Chef de projet) sans perdre de traçabilité.
**Définition de fin** : F-16 à F-18 mergées ; les agents répondent en blocs compacts, le détail vit sur les PR ; plugin en 0.6.0.

### F-16 · [skills] Rapports Flash : réponses d'agents en 5 lignes max
## Contexte
Chaque agent poste déjà son rapport détaillé en commentaire de PR, puis le renvoie une seconde fois, en entier, au Chef de projet (CP). Le CP le garde dans son contexte et le recopie dans la mission du correctif. Sur un milestone de plusieurs features avec retries, c'est le principal poste de consommation de la session principale.

## Objectif
Protocole « Output Flash » : la réponse d'un agent au CP tient en **5 lignes maximum** (verdict, références, chiffres clés) ; le détail vit uniquement dans le commentaire de PR, que le développeur relit lui-même en correctif.

## Critères d'acceptance
- [ ] `skills/gepet-squad/references/report-formats.md` : `RAPPORT_DEV`, `RAPPORT_VERIFICATION` et `RAPPORT_TESTS` deviennent des blocs compacts (≤ 5 lignes : verdict/statut, issue/PR/tentative, une ligne de chiffres — critères tenus, tests passés/échoués —, une ligne « difficultés / points bloquants » en une phrase, et l'URL du commentaire de PR qui porte le détail). Les anciens sous-blocs détaillés passent dans une section « Contenu du commentaire de PR » (format du commentaire, inchangé sur le fond). Les blocs de l'architecte ne changent pas (ils servent aux échanges avec l'utilisateur).
- [ ] `agents/developpeur.md` : le rapport final respecte le bloc compact ; le détail (preuve par critère, fichiers, tests) est écrit dans le commentaire de PR (« Livraison » ou « Correctifs tentative N »). En `MODE: CORRECTIF`, il lit le rapport d'échec dans le commentaire de PR indiqué par `RAPPORT` (URL ou numéro de commentaire), pas dans la mission.
- [ ] `agents/verificateur.md` et `agents/testeur.md` : le détail complet reste dans le commentaire de PR (titres existants conservés : `🔍 Vérification — tentative k — PASS|FAIL`, `🧪 Tests de non-régression — …`) ; la réponse au CP est le bloc compact. Un FAIL indique dans le bloc compact le nombre de correctifs bloquants, pas leur détail.
- [ ] `skills/gepet-squad/SKILL.md` §4.2 à 4.6 : le CP ne lit que le bloc compact ; en échec (§4.6), la mission `MODE: CORRECTIF` reçoit `RAPPORT: <URL du commentaire de PR>` au lieu du bloc complet ; l'escalade (§4.5) transmet à l'architecte les liens vers les commentaires, comme déjà prévu. Aucune instruction ne demande plus au CP de recopier un rapport.
- [ ] Cohérence du contrat (`CLAUDE.md`) : pour chaque bloc modifié, l'agent producteur et la section du SKILL qui le lit parlent du même format ; `grep` ne trouve plus de renvoi à l'ancien format dans `agents/`, `skills/` et `README.md`.
- [ ] Tests unitaires : sans objet (prompts Markdown, aucun code applicatif).
- [ ] Tests d'intégration : `claude plugin validate .`, `bash -n scripts/bootstrap.sh` et le test du hook `guard.cjs` de `CLAUDE.md` au vert ; `npm run lint` et `npm test` au vert.

## Notes techniques
- Sous-projet : `skills`
- Fichiers / modules concernés : `skills/gepet-squad/references/report-formats.md`, `agents/developpeur.md`, `agents/verificateur.md`, `agents/testeur.md`, `skills/gepet-squad/SKILL.md` (§4.2 à 4.6)
- Contraintes : tout en français ; ne pas toucher `.claude-plugin/plugin.json` ni `CHANGELOG.md` (bump dans F-18) ; ne pas toucher aux lignes `tools:` des agents (modifications locales de l'utilisateur hors périmètre).
- Le CP peut toujours relire le détail à la demande via `gh pr view --comments` (escalade, litige).

## Skills / outils recommandés
- `plugin-authoring` : conventions de prompts de plugin.

## Dépendances
Aucune

## Taille
M

### F-17 · [skills] Missions épurées, isolation documentée et préfixe stable (prompt caching)
## Contexte
Les missions que le CP envoie aux agents doivent rester minimales et ne contenir que des références (numéros, chemins), jamais de contenu que l'agent peut lire lui-même. L'isolation des sous-agents (contexte vierge, pas d'historique de la session principale) est acquise par l'outil Agent mais n'est écrite nulle part, et l'ordre des champs des missions n'est pas pensé pour le cache de prompt d'Anthropic (préfixe identique d'un appel à l'autre).

## Objectif
Formaliser « Input épuré », l'isolation stricte des sous-agents et un préfixe de mission stable pour maximiser les hits du cache de prompt.

## Critères d'acceptance
- [ ] `skills/gepet-squad/SKILL.md` : nouvelle section « Économie de contexte » courte avec : (a) règle « Input épuré » — une mission contient des instructions strictes et des références (n° d'issue/PR, branche, chemins) ; jamais le corps d'une issue, un diff, un rapport ou le contenu d'un fichier, que l'agent lit lui-même (`gh issue view`, `gh pr diff`, Read) ; (b) isolation — chaque agent est lancé par l'outil Agent (contexte vierge, sans l'historique du CP) ; ne jamais continuer par `SendMessage` un agent d'un autre ticket pour « gagner du contexte » ; `SendMessage` reste réservé à l'architecte pendant le cadrage ; (c) préfixe stable.
- [ ] Toutes les missions du SKILL (§1.1, 4.1, 4.2, 4.3, 4.5, 4.6) sont ordonnées du **plus stable au plus variable** : `MODE`, `REFERENCES`, `REPO`, puis `SOUS_PROJET`/`GRAPHE`, puis `ISSUE`/`PR`/`BRANCHE`/`TENTATIVE`, et le texte libre (`BESOIN`, `RAPPORT`) en dernier. `github-conventions.md` ou `report-formats.md` documente cet ordre.
- [ ] Chaque agent (`agents/*.md`) indique en tête de sa section de mission qu'il lit lui-même ce dont il a besoin à partir des références reçues (issue, PR, `docs/architecture/`, graphe) et n'exige aucun contenu collé dans la mission.
- [ ] `README.md` : paragraphe « Consommation » (isolation, input épuré, rapports Flash de F-16, cache de prompt) en quelques lignes.
- [ ] Tests unitaires : sans objet (prompts Markdown).
- [ ] Tests d'intégration : `claude plugin validate .`, `bash -n scripts/bootstrap.sh`, test du hook `guard.cjs` de `CLAUDE.md`, `npm run lint` et `npm test` au vert.

## Notes techniques
- Sous-projet : `skills`
- Fichiers / modules concernés : `skills/gepet-squad/SKILL.md`, `agents/architecte.md`, `agents/developpeur.md`, `agents/verificateur.md`, `agents/testeur.md`, `skills/gepet-squad/references/github-conventions.md`, `README.md`
- Contraintes : tout en français ; ne pas toucher `plugin.json` ni `CHANGELOG.md` ; ne pas toucher aux lignes `tools:` des agents ; le `BESOIN` de l'utilisateur reste mot pour mot dans la mission de cadrage (donnée utilisateur, pas un fichier).

## Skills / outils recommandés
- `plugin-authoring`.

## Dépendances
- F-16

## Taille
S

### F-18 · [skills] État externe du Chef de projet et publication de la 0.6.0
## Contexte
Le CP est la session la plus coûteuse car son contexte grossit tout au long de la roadmap. L'état du projet est déjà sur GitHub (labels, milestones, commentaires de PR) et dans `docs/roadmap.md`, mais le SKILL ne dit pas au CP de s'y référer plutôt que de garder brouillons, roadmap et rapports dans sa mémoire de conversation.

## Objectif
Le CP traite `docs/roadmap.md` et GitHub comme sa mémoire externe : il y lit à la demande, par section, et n'y garde que des numéros et des verdicts. Livre la 0.6.0 du plugin.

## Critères d'acceptance
- [ ] `skills/gepet-squad/SKILL.md` : la section « Économie de contexte » (créée par F-17) reçoit le volet « État externe » : après la publication (phase 3.5), la roadmap vit dans `docs/roadmap.md` (table `F-xx → #n` incluse) ; le CP ne la relit jamais en entier — il lit seulement la section de la feature concernée (`grep -n "^### F-" docs/roadmap.md` puis lecture ciblée) ou l'issue GitHub ; l'état courant se reconstruit avec `gh issue list --milestone … --json` (jamais depuis la mémoire de la conversation) ; entre deux features, le CP ne conserve que : n° d'issue, n° de PR, verdict, compteur de retries.
- [ ] Phase 3 : `REVUE_ROADMAP` reçoit le **chemin** du brouillon écrit sur disque (champ `ROADMAP`) et non son contenu collé ; `agents/architecte.md` et `report-formats.md` sont ajustés en conséquence.
- [ ] `skills/gepet-squad-resume/SKILL.md` : s'aligne sur le même principe (reconstruction par GitHub + sections ciblées de `docs/roadmap.md`) sans régression de comportement ; aucune nouvelle donnée d'état hors GitHub / `.gepet-squad.json` / `docs/roadmap.md`.
- [ ] Versionnage (dernière feature de M4) : `.claude-plugin/plugin.json` passe en `0.6.0` et `CHANGELOG.md` reçoit une entrée `0.6.0` qui décrit F-16, F-17 et F-18 (rapports Flash, missions épurées/cache, état externe).
- [ ] `docs/roadmap.md` : la vue d'ensemble liste M4 et la version 0.6.0.
- [ ] Tests unitaires : sans objet (prompts Markdown).
- [ ] Tests d'intégration : `claude plugin validate .`, `bash -n scripts/bootstrap.sh`, test du hook `guard.cjs` de `CLAUDE.md`, `npm run lint` et `npm test` au vert.

## Notes techniques
- Sous-projet : `skills`
- Fichiers / modules concernés : `skills/gepet-squad/SKILL.md`, `skills/gepet-squad-resume/SKILL.md`, `agents/architecte.md`, `skills/gepet-squad/references/report-formats.md`, `.claude-plugin/plugin.json`, `CHANGELOG.md`, `docs/roadmap.md`
- Contraintes : tout en français ; seule feature de M4 qui touche `plugin.json` et `CHANGELOG.md` ; ne pas toucher aux lignes `tools:` des agents.

## Skills / outils recommandés
- `plugin-authoring`.

## Dépendances
- F-17

## Taille
S

---

## M5 — Bureau 3D : décor et kanban
**Objectif** : `/gepet-squad-viz` montre un bureau 3D low-poly meublé (assets Kenney CC0) avec un kanban mural de post-its à la place du pipeline abstrait ; les agents restent provisoirement les sphères lumineuses actuelles, placées dans la zone du bureau qui correspond à leur station.
**Définition de fin** : F-19 à F-25 mergées ; les assets Kenney sont vendorés et contrôlés (sha256, clips, aucune image embarquée) ; le serveur sert les `.glb` ; la scène affiche le bureau et le kanban sans erreur CSP ; `npm test` et `npm run lint` au vert ; plugin en 0.8.0.
**Prérequis utilisateur** : avant de lancer F-19, le CP vérifie la présence de `D:/DevClaude/kenney-zips/kenney_mini-characters.zip` et `D:/DevClaude/kenney-zips/kenney_furniture-kit.zip`. S'ils manquent, il les demande à l'utilisateur et ne lance que F-20 et F-21 en attendant.

### F-19 · [repo] Vendorer les assets Kenney (personnages et mobilier) avec leur contrôle d'intégrité
## Contexte
Le bureau de l'ADR 0009 a besoin de bonhommes riggés et animés et de mobilier de bureau. L'ADR 0010 retient Kenney Mini Characters 2.0 et Kenney Furniture Kit 2.0 (CC0), vendorés dans le plugin pour rester sans build ni réseau. Le téléchargement Kenney n'est pas automatisable : un script extrait les fichiers retenus des zips téléchargés à la main et épingle leurs sha256. Sans `*.glb binary`, la règle `* text=auto eol=lf` corromprait les GLB au checkout Windows : c'est à régler avant tout commit d'asset.

## Objectif
`scripts/vendor-assets.sh <zip-mini-characters> <zip-furniture-kit>` remplit `viz/public/vendor/kenney/` (personnages, texture, mobilier, licences, `SOURCE.md`), et un test d'intégration garantit l'intégrité et la compatibilité CSP des fichiers commités.

## Critères d'acceptance
- [ ] `.gitattributes` contient `*.glb binary` et `*.png binary`, avant la règle `viz/public/vendor/** linguist-vendored` ; `git check-attr text -- viz/public/vendor/kenney/characters/<x>.glb` renvoie `unset`.
- [ ] `bash scripts/vendor-assets.sh <zip-chars> <zip-furniture>` extrait uniquement la liste de fichiers déclarée en tête du script : exactement 7 personnages dans `viz/public/vendor/kenney/characters/` (un pour le chef de projet, l'architecte, le vérificateur, le testeur, et 3 pour les développeurs ; aucun modèle de type arme ou fantaisie), `characters/Textures/colormap.png`, une quinzaine de meubles dans `furniture/` (au moins `desk`, `chairDesk`, `computerScreen`, `computerKeyboard`, `laptop`, `doorway`, `wall`, `wallWindow`, `floorFull`, `table`, `bookcaseOpen`, `pottedPlant`, `kitchenCoffeeMachine`), `LICENSE-mini-characters.txt` et `LICENSE-furniture-kit.txt` (copies des `License.txt`).
- [ ] Le script réécrit `viz/public/vendor/kenney/SOURCE.md` : URL des pages des packs, version, date, puis une ligne par fichier retenu avec son chemin relatif et son sha256.
- [ ] Sans argument, avec un zip absent ou avec un zip auquel il manque un fichier listé, le script s'arrête avec un code non nul et un message qui nomme le fichier en cause, sans avoir modifié `viz/public/vendor/kenney/`. Il ne télécharge jamais rien (aucun `curl`/`wget`).
- [ ] Tests unitaires : la fonction Node de lecture d'un GLB (en-tête binaire, chunk JSON) — placée dans `tests/helpers/` — est testée sur un GLB minimal construit en mémoire : clips lus, image embarquée détectée (`bufferView`), image externe détectée (`uri`), fichier tronqué rejeté.
- [ ] Tests d'intégration (`tests/viz-web/kenney-assets.test.mjs`) : chaque fichier listé dans `SOURCE.md` existe et son sha256 correspond ; chaque GLB de `characters/` contient les clips `idle`, `walk`, `sit`, `interact-right`, `emote-yes`, `emote-no` et `holding-both` ; aucun GLB n'embarque d'image ; toute image référencée par `uri` existe sur disque ; les deux licences sont présentes et mentionnent CC0.
- [ ] Lint, build et suite de tests complète au vert : `npm run lint`, `npm test`, `bash -n scripts/vendor-assets.sh`, et `bash -n scripts/vendor-assets.sh` ajouté à l'étape `bash -n` du workflow CI.

## Notes techniques
- Sous-projet : `repo`
- ADR de référence : `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`
- Fichiers / modules concernés : `scripts/vendor-assets.sh` (nouveau), `.gitattributes`, `viz/public/vendor/kenney/**` (nouveau), `tests/helpers/` (lecteur GLB), `tests/viz-web/kenney-assets.test.mjs` (nouveau), `.github/workflows/*`
- **Zips** : l'utilisateur les dépose dans `D:/DevClaude/kenney-zips/` (`kenney_mini-characters.zip`, `kenney_furniture-kit.zip`). S'ils sont absents, se déclarer `BLOQUÉ` (ne pas chercher d'autre source).
- Contraintes : F-19 est la seule feature de M5 à créer un fichier dans `tests/helpers/` ; ne jamais modifier un asset à la main ; garder l'arborescence `characters/Textures/colormap.png` attendue par les GLB ; ne pas toucher `.claude-plugin/plugin.json` ni `CHANGELOG.md` (F-25).

## Skills / outils recommandés
- `npx @gltf-transform/cli inspect <fichier.glb>` (en dev uniquement, jamais en dépendance) pour vérifier clips et images.
- glTF Viewer de Don McCurdy (https://gltf-viewer.donmccurdy.com/) pour choisir les personnages.

## Dépendances
- aucune

## Taille
M

### F-20 · [viz-server] Servir les modèles `.glb` en `model/gltf-binary`
## Contexte
Le navigateur charge les bonhommes et le mobilier au format GLB depuis `/vendor/kenney/`. La liste blanche MIME de `viz/lib/http.cjs` (ADR 0005) ne connaît pas `.glb` : ces fichiers renvoient aujourd'hui 404. L'ADR 0010 ajoute ce seul type, sans rien changer d'autre à la sécurité du serveur.

## Objectif
`GET /vendor/<chemin>.glb` renvoie 200 avec `Content-Type: model/gltf-binary` et les mêmes en-têtes de sécurité que les autres fichiers statiques.

## Critères d'acceptance
- [ ] `mimeFor('x.glb')` et `mimeFor('X.GLB')` renvoient `model/gltf-binary` ; `mimeFor('x.gltf')` et `mimeFor('x.bin')` renvoient toujours `null` (liste blanche inchangée par ailleurs).
- [ ] Le contenu d'un `.glb` est renvoyé octet pour octet (aucune conversion de texte ni d'encodage).
- [ ] Un chemin `.glb` hors de `viz/public` (`/vendor/../../x.glb`, encodé ou non) reste refusé comme aujourd'hui.
- [ ] Tests unitaires : `mimeFor` sur `.glb`, `.GLB`, `.gltf`, `.bin`.
- [ ] Tests d'intégration (`tests/viz-server/http.test.cjs` ou `server.test.cjs`) : serveur démarré sur un dossier public temporaire (`fs.mkdtemp`) dans lequel le test écrit un petit fichier `.glb` binaire au moment du test (rien d'ajouté à `tests/fixtures/public/`) → 200, `Content-Type: model/gltf-binary`, corps identique au fichier, en-tête CSP présent et inchangé ; traversée de chemin → refus.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-server`
- ADR de référence : `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`, `docs/architecture/adr/0005-*`
- Fichiers / modules concernés : `viz/lib/http.cjs` (`MIME_TYPES`), `tests/viz-server/http.test.cjs`, `tests/viz-server/server.test.cjs`
- Contraintes : la CSP ne change pas ; ne pas dépendre des fichiers de F-19 (fixture de test autonome).

## Skills / outils recommandés
- aucun en particulier

## Dépendances
- aucune

## Taille
S

### F-21 · [viz-web] Vendorer les addons Three.js de chargement glTF
## Contexte
Pour charger et animer les GLB Kenney, le front a besoin de `GLTFLoader` et de `SkeletonUtils.clone` (plusieurs développeurs sur un même modèle). Dans Three.js 0.187.0, `GLTFLoader` importe aussi `BufferGeometryUtils`. L'ADR 0010 amende l'ADR 0002 : ces trois addons entrent dans le vendoring. Les addons `postprocessing/*` restent pour l'instant, car `agents.js` les utilise encore (retrait en F-29).

## Objectif
`scripts/vendor-three.sh` vendore `loaders/GLTFLoader.js`, `utils/SkeletonUtils.js` et `utils/BufferGeometryUtils.js` de Three.js 0.187.0, et la page peut les importer via l'importmap existant.

## Critères d'acceptance
- [ ] `scripts/vendor-three.sh` liste les trois addons ; relancé, il produit `viz/public/vendor/three/addons/loaders/GLTFLoader.js`, `addons/utils/SkeletonUtils.js` et `addons/utils/BufferGeometryUtils.js`, identiques aux fichiers du paquet `three@0.187.0`.
- [ ] Three.js reste en 0.187.0 et les addons `postprocessing/*` et `controls/OrbitControls.js` déjà vendorés sont toujours présents.
- [ ] `import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js"` et `import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js"` se résolvent avec l'importmap de `viz/public/index.html` (aucun nouvel import hors de `vendor/three`).
- [ ] Tests unitaires : `tests/viz-web/vendor.test.mjs` vérifie la présence des trois nouveaux fichiers, que chacun de leurs imports relatifs pointe vers un fichier vendoré, et que leur en-tête de licence MIT est conservé.
- [ ] Tests d'intégration : sous Node avec `tests/viz-web/three-register.mjs`, `GLTFLoader` et `SkeletonUtils` s'importent sans erreur, et `new GLTFLoader().parse()` d'un GLB minimal construit en mémoire (un mesh, sans image) produit une scène contenant ce mesh.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`, `bash -n scripts/vendor-three.sh`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`, `docs/architecture/adr/0002-stack-sans-build-three-vendore-sse.md`
- Fichiers / modules concernés : `scripts/vendor-three.sh`, `viz/public/vendor/three/addons/**`, `tests/viz-web/vendor.test.mjs`
- Contraintes : ne retirer aucun addon ici ; ne pas toucher `viz/public/js/*` ; le GLB minimal est construit dans le fichier de test de cette feature, sans toucher `tests/helpers/` (créé par F-19 en parallèle).

## Skills / outils recommandés
- aucun en particulier

## Dépendances
- aucune

## Taille
S

### F-22 · [viz-web] Manifeste pur des assets 3D (`assets.js`) et contrôle de pureté partagé
## Contexte
Les modules de décision (`crew.js`) et de rendu (`scene.js`, `characters.js`) doivent savoir quel modèle utiliser pour quel rôle, à quelle échelle, et quels clips sont requis. L'ADR 0010 place cette liste dans un module pur, `assets.js`, qui fait foi. Pour qu'aucun module pur suivant n'ait à modifier `tests/viz-web/purity.test.mjs`, le contrôle de pureté devient un helper réutilisable.

## Objectif
`viz/public/js/assets.js` exporte le manifeste figé des assets (personnages par rôle, mobilier, texture, clips requis, échelles), et `support.mjs` exporte un helper de contrôle de pureté que chaque module pur appelle depuis son propre fichier de test.

## Critères d'acceptance
- [ ] `assets.js` exporte un manifeste gelé (`Object.freeze` profond) : pour chaque personnage, son chemin sous `vendor/kenney/`, son rôle (`chef-de-projet`, `architecte`, `developpeur`, `verificateur`, `testeur`), son échelle et ses clips requis ; pour chaque meuble, son identifiant, son chemin et son échelle.
- [ ] Un modèle distinct par rôle (chef de projet, architecte, vérificateur, testeur) et exactement 3 modèles de développeur ; `characterFor(role, index)` renvoie le modèle du rôle, et pour `developpeur` le modèle `index % 3` ; un rôle inconnu renvoie `null`.
- [ ] `assets.js` n'importe ni `three`, ni le DOM, ni l'horloge, ni le hasard.
- [ ] `tests/viz-web/support.mjs` exporte `assertPure(file)` (analyse du source et exécution avec pièges sur les globales du navigateur, logique reprise de `purity.test.mjs`) ; `purity.test.mjs` l'utilise pour ses modules actuels et son comportement est inchangé.
- [ ] Tests unitaires (`tests/viz-web/assets.test.mjs`) : forme du manifeste, unicité des chemins et des identifiants, `characterFor` (rôles, indices 0 à 5, rôle inconnu), immutabilité, et `assertPure("assets.js")`.
- [ ] Tests d'intégration (`tests/viz-web/assets.test.mjs`) : chaque chemin du manifeste existe dans `viz/public/vendor/kenney/SOURCE.md` et sur disque ; les clips requis du manifeste sont un sous-ensemble des clips réellement présents dans chaque GLB (lecteur GLB de F-19).
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`, `docs/architecture/adr/0006-strategie-de-tests.md`
- Fichiers / modules concernés : `viz/public/js/assets.js` (nouveau), `tests/viz-web/assets.test.mjs` (nouveau), `tests/viz-web/support.mjs`, `tests/viz-web/purity.test.mjs`
- Contraintes : F-23, F-26, F-27 et F-31 ne modifient pas `purity.test.mjs` (chacune appelle `assertPure` dans son propre fichier de test) ; seules F-24 et F-29 l'adaptent (dépendances de `layout.js`, puis sa suppression).

## Skills / outils recommandés
- `engineering:testing-strategy` : factorisation du contrôle de pureté.

## Dépendances
- F-19

## Taille
S

### F-23 · [viz-web] Plan pur du bureau (`office-layout.js`) : zones, postes, porte, kanban
## Contexte
L'ADR 0009 traduit chaque station de `/state` en zone du bureau (salle de réunion, open space, bureau du vérificateur, labo, kanban…). Ce plan doit être pur et testable sans WebGL, car il alimente à la fois le décor (`scene.js`), les post-its du kanban et, plus tard, les trajets des bonhommes (`paths.js`, `crew.js`). Il remplace à terme `layout.js`.

## Objectif
`viz/public/js/office-layout.js` décrit le bureau (zones, postes, porte, points de passage, mobilier placé) et calcule les positions des post-its du kanban à partir du modèle client.

## Critères d'acceptance
- [ ] `OFFICE` (gelé) décrit : la porte, une zone par station (`cadrage`, `roadmap`, `dev`, `verification`, `test`, `escalade`) selon le tableau de l'ADR 0009, le bureau permanent du chef de projet, 3 postes de développeur par défaut, et la liste du mobilier placé (identifiant du manifeste `assets.js`, position, rotation).
- [ ] `devSeat(i)` renvoie le poste `i` **et ses meubles** (bureau, chaise, écran, clavier) pour `0 ≤ i < MAX_DEV_SEATS` (constante nommée, 8) ; les postes 3 et suivants sont supplémentaires ; tous restent dans l'emprise des murs et leurs boîtes englobantes sont disjointes de celles de tous les autres meubles ; `i ≥ MAX_DEV_SEATS` renvoie `null`.
- [ ] Chaque poste a un **point d'accès** situé devant sa chaise (hors des boîtes de la chaise et du bureau) et un point assis.
- [ ] `seatFor(station, role, rank)` gère les occupants simultanés : pour `cadrage`, `roadmap`, `verification`, `test` et `escalade`, `MAX_ZONE_SEATS = 3` (constante nommée) ; le rang 0 est le poste principal (position debout devant le kanban pour `roadmap`), les rangs 1 et 2 sont des places debout dans la zone, dans les murs et hors de toute boîte de meuble ; un rang ≥ 3 renvoie la dernière place ; `seatFor(null, "architecte", r)` renvoie les places de `cadrage` ; `merge` et `release` renvoient `null` (pas d'occupant).
- [ ] `waypoints()` renvoie, pour **chaque** position renvoyée par `devSeat` et `seatFor` (tous les rangs, place debout devant le kanban comprise), une polyligne de points de passage de la porte jusqu'à son point d'accès, dont aucun segment ne traverse une boîte englobante de meuble.
- [ ] `kanbanLayout(model)` renvoie une position de post-it par feature visible : une colonne par station plus `escalade` ; dans chaque colonne, les features du milestone `open` de plus petit `number` d'abord, puis les autres par numéro de feature ; au-delà de `KANBAN_MAX_PER_COLUMN`, un compteur `{ column, extra: N }` remplace les post-its en trop.
- [ ] Les mêmes entrées donnent toujours les mêmes sorties ; aucun import de `three`, du DOM, de l'horloge ou du hasard.
- [ ] Tests unitaires (`tests/viz-web/office-layout.test.mjs`) : zones de chaque station, postes 0 à `MAX_DEV_SEATS - 1` disjoints et dans les murs, `null` au-delà, points d'accès hors des meubles, `seatFor` pour chaque station et chaque rang (places disjointes, rang ≥ 3, station `null`), segments de `waypoints` sans collision, tri et plafond du kanban (0, 1, plafond, plafond + 7 features), déterminisme, `assertPure("office-layout.js")`.
- [ ] Tests d'intégration : chaque meuble placé (y compris ceux de `devSeat`) référence un identifiant existant du manifeste `assets.js` ; `kanbanLayout` appliqué à un état construit avec `support.mjs` (`stateOf`, `feature`, `milestone` : au moins 2 milestones, dont un fermé, et des features dans chaque colonne, escalade comprise) donne une position ou un compteur pour chaque feature, dans l'ordre attendu.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0009-metaphore-bureau-3d.md`, `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`
- Fichiers / modules concernés : `viz/public/js/office-layout.js` (nouveau), `tests/viz-web/office-layout.test.mjs` (nouveau)
- Contraintes : ne pas modifier `layout.js` ni `purity.test.mjs` ; les échelles Kenney (2018 et 2026) sont des constantes d'`assets.js` et de ce module.

## Skills / outils recommandés
- `design-taste-frontend` ou `high-end-visual-design` : composition du bureau et lisibilité du kanban vu de la caméra par défaut.

## Dépendances
- F-22

## Taille
M

### F-24 · [viz-web] Scène bureau : décor GLB et kanban de post-its à la place du pipeline
## Contexte
C'est l'incrément visible du milestone : la page 3D montre le bureau meublé et le kanban au lieu des 7 stations abstraites (ADR 0009). Les agents restent provisoirement les sphères lumineuses d'`agents.js`, qu'on place dans la zone du bureau de leur station ; les bonhommes arrivent en M6. Le chargement des GLB peut échouer : la vue doit rester utilisable.

## Objectif
`scene.js` charge le mobilier GLB via `GLTFLoader` aux positions d'`office-layout.js`, dessine murs, sol et kanban de post-its, et les sphères d'agents apparaissent dans la zone de leur station.

## Critères d'acceptance
- [ ] `scene.js` charge chaque meuble d'`OFFICE` (chemins et échelles d'`assets.js`) par `GLTFLoader`, chaque fichier une seule fois puis cloné ; murs et sol sont posés ; les stations abstraites et les files de features de `layout.js` ne sont plus dessinées ; la caméra par défaut cadre tout le bureau et le kanban (`fitCamera` sur l'emprise d'`OFFICE`) ; le titre et l'`aria-label` « Pipeline » d'`index.html` deviennent « Bureau ».
- [ ] Le kanban est un plan mural avec une colonne par station plus `escalade` (en rouge) ; les post-its forment un seul `InstancedMesh`, colorés par statut via `view-model.js` ; un `feature-move` fait glisser le post-it vers sa nouvelle colonne par les courbes de `motion.js` (déplacement immédiat avec `prefers-reduced-motion`) ; le compteur « +N » et le badge retry passent par `CSS2DRenderer` en `textContent`.
- [ ] Le survol d'un post-it affiche `#N` et le titre de la feature (via `featureForInstance`) ; `labels.js` affiche les noms de zones fournis par `view-model.js`.
- [ ] Les sphères d'`agents.js` sont positionnées dans la zone d'`office-layout.js` de leur station, et non plus au-dessus de leur feature (`layout.js` dérive ses positions d'agents de `office-layout.js`) ; les badges de retry quittent `agents.js` (`syncBadges`) pour le kanban ; `agents.test.mjs` est adapté (plus de badges, positions par zone).
- [ ] Si un meuble ne se charge pas, il est omis, la scène continue de s'afficher, et `ui.js` affiche un avertissement unique qui nomme le nombre de fichiers en échec.
- [ ] Aucune nouvelle source dans la CSP ; aucun `blob:` ; tout texte passe par `textContent`.
- [ ] Tests unitaires : nouvelles fonctions pures éventuelles de `view-model.js` (noms de zones, couleurs de post-it) et adaptation de `layout.test.mjs`.
- [ ] Tests d'intégration (`tests/viz-web/scene.test.mjs`) : sous Node avec `three-register.mjs` et un faux chargeur GLTF, la scène ajoute un objet par meuble d'`OFFICE`, un `InstancedMesh` dont le nombre d'instances visibles égale le nombre de post-its de `kanbanLayout`, met à jour l'instance après un `feature-move`, et un chargeur en échec produit l'avertissement sans exception.
- [ ] Smoke manuel documenté dans la PR (capture et console) : le bureau et le kanban s'affichent avec `node viz/server.cjs --project <dir>` ; aucune erreur console ni CSP ; le repli `?mode=texte` fonctionne.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0009-metaphore-bureau-3d.md`, `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`, `docs/architecture/adr/0006-strategie-de-tests.md`
- Fichiers / modules concernés : `viz/public/js/scene.js`, `viz/public/js/layout.js`, `viz/public/js/agents.js`, `viz/public/js/labels.js`, `viz/public/js/view-model.js`, `viz/public/js/ui.js`, `viz/public/index.html`, et les tests `scene`, `layout`, `agents`, `labels`, `view-model`, `integration`, `purity` (`layout.js` dépend désormais d'`office-layout.js`)
- Contraintes : ne pas supprimer `agents.js`, `layout.js` ni les addons `postprocessing` (F-29) ; aucune logique de décision dans `scene.js` ; ne pas toucher `state.js` ni le contrat `/state`.

## Skills / outils recommandés
- `design-taste-frontend` / `high-end-visual-design` : palette, lumière, cadrage caméra du bureau.
- `impeccable` : critique de l'interface une fois rendue.
- `web-design-guidelines` : contraste des post-its, `prefers-reduced-motion`.
- `run` (navigateur intégré) : smoke manuel.

## Dépendances
- F-20, F-21, F-23

## Taille
M

### F-25 · [skills] Documenter le bureau 3D et publier la 0.8.0
## Contexte
Chaque changement de comportement du plugin s'accompagne d'un bump de version et d'une entrée de CHANGELOG (`CLAUDE.md`). La vue `/gepet-squad-viz` change de nature en M5 (bureau et kanban à la place du pipeline), et le plugin embarque désormais des assets tiers CC0 qu'il est recommandé de créditer.

## Objectif
README, skill `gepet-squad-viz`, CHANGELOG et `plugin.json` décrivent le bureau 3D, créditent Kenney, et le plugin passe en 0.8.0.

## Critères d'acceptance
- [ ] `.claude-plugin/plugin.json` : `version` passe à `0.8.0`.
- [ ] `CHANGELOG.md` : entrée 0.8.0 qui décrit le bureau, le kanban, les assets vendorés et leur poids **mesuré** (`du -sh viz/public/vendor/kenney`, valeur reportée), et le nouveau script `vendor-assets.sh`.
- [ ] `README.md` : la section de la visualisation décrit le bureau et le kanban, avec les agents présentés comme des « repères lumineux provisoires, remplacés par des bonhommes en 0.9.0 », et crédite Kenney (www.kenney.nl, CC0) ; la procédure de mise à jour des assets (`bash scripts/vendor-assets.sh <zip> <zip>`) est documentée côté contributeurs (README ou `CONTRIBUTING.md`).
- [ ] `skills/gepet-squad-viz/SKILL.md` : au plus une phrase ajoutée au message affiché après l'URL (par exemple « la page montre le bureau de la squad et son kanban ») ; aucune description détaillée, qui reste dans le README ; `tests/skills/viz-skill.test.cjs` au vert.
- [ ] `grep -rnE "7 stations du pipeline|pipeline à 7 stations" README.md skills/` ne renvoie plus rien.
- [ ] Tests unitaires : sans objet (documentation, aucun code).
- [ ] Tests d'intégration : `claude plugin validate .` au vert, et les tests existants de `tests/skills/` au vert.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `skills`
- ADR de référence : `docs/architecture/adr/0009-metaphore-bureau-3d.md`, `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`
- Fichiers / modules concernés : `.claude-plugin/plugin.json`, `CHANGELOG.md`, `README.md`, `CONTRIBUTING.md`, `skills/gepet-squad-viz/SKILL.md`
- Contraintes : seule feature de M5 qui touche `plugin.json` et `CHANGELOG.md` ; tout en français.

## Skills / outils recommandés
- `plugin-authoring` : conventions du plugin.

## Dépendances
- F-24

## Taille
S

---

## M6 — Bonshommes vivants
**Objectif** : les agents deviennent de petits bonhommes Kenney animés : ils entrent par la porte, marchent jusqu'à leur poste, tapent au clavier, montrent leur verdict dans une bulle et repartent ; le chef de projet travaille en permanence à son bureau ; les sphères lumineuses et le bloom disparaissent.
**Définition de fin** : F-26 à F-32 mergées ; le cycle complet d'un agent (entrée, travail, verdict, sortie, reprise) est visible et couvert par des tests ; aucune marche avec `prefers-reduced-motion` ; `agents.js`, `layout.js` et les addons `postprocessing` sont supprimés ; plugin en 0.9.0.

### F-26 · [viz-web] Trajets purs des bonhommes (`paths.js`)
## Contexte
Les bonhommes marchent de la porte à leur poste et inversement, sur des chemins prédéfinis (ADR 0011 : pas de navmesh, les postes sont fixes). Le calcul des trajets doit être pur pour que la machine d'états (`crew.js`) soit testable sans WebGL, et pour gérer les interruptions : un agent peut faire demi-tour au milieu d'une marche.

## Objectif
`viz/public/js/paths.js` construit une polyligne entre deux points du graphe de points de passage d'`office-layout.js` et l'échantillonne (position et cap) avec une durée plafonnée à 3 s.

## Critères d'acceptance
- [ ] `pathTo(from, to, waypoints)` renvoie une polyligne qui commence à `from`, finit à `to` et passe par les points de passage du poste concerné ; un `from` en pleine marche est raccordé **sur la polyligne en cours** (projection sur cette polyligne, passée en argument), jamais au point de passage le plus proche au sens euclidien.
- [ ] `sample(path, t)` renvoie `{ x, z, heading }` pour `t ∈ [0, 1]` ; `t ≤ 0` donne le départ, `t ≥ 1` l'arrivée ; le cap suit la direction du segment courant ; un chemin d'un seul point renvoie ce point sans erreur.
- [ ] `durationOf(path)` est proportionnelle à la longueur, à vitesse constante (`WALK_SPEED`), et plafonnée à `MAX_WALK_MS = 3000`.
- [ ] Aucun import de `three`, du DOM, de l'horloge ou du hasard ; mêmes entrées, mêmes sorties.
- [ ] Tests unitaires (`tests/viz-web/paths.test.mjs`) : extrémités, raccordement depuis une position intermédiaire, `sample` aux bornes et au milieu, cap sur un segment horizontal et vertical, chemin dégénéré, plafond de 3 s sur un long trajet, `assertPure("paths.js")`.
- [ ] Tests d'intégration : pour chaque poste d'`office-layout.js` (postes 0 à `MAX_DEV_SEATS - 1` et toutes les places de `seatFor`, rangs 0 à `MAX_ZONE_SEATS - 1` de chaque zone), `pathTo(porte, accès)`, `pathTo(accès, porte)`, puis depuis le milieu de chaque trajet porte → accès, `pathTo(milieu, porte)` et `pathTo(milieu, accès)` produisent des chemins dont aucun segment ne traverse une boîte englobante de meuble (le point d'accès est hors de la chaise et du bureau du poste).
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`
- Fichiers / modules concernés : `viz/public/js/paths.js` (nouveau), `tests/viz-web/paths.test.mjs` (nouveau)
- Contraintes : ne pas modifier `office-layout.js` sauf correction de points de passage justifiée dans la PR ; pas de bibliothèque de pathfinding.

## Skills / outils recommandés
- `animate` / `apple-design` : vitesse de marche et courbe d'arrivée crédibles.

## Dépendances
- F-23

## Taille
S

### F-27 · [viz-web] Machine d'états pure des bonhommes (`crew.js`) : postes, états et clips
## Contexte
Le comportement des bonhommes encode le workflow gepet-squad (ADR 0011) : entrer, travailler, rendre un verdict, repartir. Toute cette logique doit vivre dans un module pur, pour que le rendu (`characters.js`) ne décide rien et que chaque cas soit testé sans WebGL. Cette première feature pose la forme de `stepCrew` et le cycle nominal ; les interruptions, la reprise, le geste du chef de projet et le mode réduit arrivent en F-31.

## Objectif
`viz/public/js/crew.js` calcule, à partir du modèle client, des transitions et de l'instant courant, l'état de chaque bonhomme (poste, modèle, état, clip, position, bulle, dossier) pour le cycle nominal du tableau de l'ADR 0011.

## Critères d'acceptance
- [ ] `stepCrew(crew, model, transitions, now, reduced)` renvoie un nouvel état sans muter ses entrées ; chaque bonhomme porte `id`, `role`, `seat`, `model` (via `characterFor`), `state` (`entering`, `working`, `reporting`, `leaving`, `gone`, `stale`), `clip`, `position`, `heading`, `bubble` et `folder`.
- [ ] Attribution des places stable par `agent.id` : dans chaque zone, première place libre (rang de `seatFor`, ou `devSeat` pour les développeurs, avec poste supplémentaire au-delà de 3) ; une station `null` va en salle de réunion ; la place est fixée à l'entrée (un `agent-move` pendant la présence ne déplace pas le bonhomme), conservée tant que l'agent est dans le modèle, libérée quand il en sort ; une place debout (rang ≥ 1) travaille en `interact-right` debout, sans `sit`.
- [ ] Cycle nominal conforme au tableau de l'ADR 0011 : `entering`/`walk` à l'ajout (trajet `paths.js` de la porte au point d'accès), `working` à l'arrivée en phase `requested`/`running` (`sit` puis `interact-right`, ou `idle` debout pour l'architecte au kanban), `leaving`/`walk` à `finished`, `gone` à la porte, `stale`/`idle` avec bulle « ? » en phase `unknown`.
- [ ] Phase `reported` : état `reporting` avec `emote-yes` (`PASS`, `LIVRÉ`, `APPROUVÉ`), `emote-no` (`FAIL`, `BLOQUÉ`, `À REVOIR`) ou `holding-both` sinon ; bulle du verdict pendant 4 s, puis retour assis tant que la phase reste `reported`.
- [ ] Dossier visible sur le poste avec `#N` quand l'agent porte une `issue`, retiré à sa sortie.
- [ ] Aucun import de `three`, du DOM, de l'horloge ou du hasard : le temps est un argument.
- [ ] Tests unitaires (`tests/viz-web/crew.test.mjs`) : chaque ligne du cycle nominal, chaque verdict → clip, durée de la bulle, 4 développeurs simultanés (poste supplémentaire), 2 vérificateurs simultanés sur 2 places distinctes, 4 testeurs (le 4e prend la dernière place), architecte à station `null`, `agent-move` sans déplacement, libération et réattribution d'une place, dossier, non-mutation des entrées, `assertPure("crew.js")`.
- [ ] Tests d'intégration : une fixture `tests/fixtures/journal/cycle-complet.jsonl` (événements v1 valides selon `hooks/lib/schema.cjs` : les 4 types d'agents, des `feature.status` et un `pr.merged`) est créée ; rejouée par `state.js`, elle produit pour chaque agent, via `stepCrew`, la suite d'états attendue, sans état impossible (aucun `working` hors de son poste).
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`, `docs/architecture/adr/0008-*`
- Fichiers / modules concernés : `viz/public/js/crew.js` (nouveau), `tests/viz-web/crew.test.mjs` (nouveau), `tests/fixtures/journal/cycle-complet.jsonl` (nouveau)
- Contraintes : un agent `finished` reste 10 min dans le modèle (`AGENT_FINISHED_TTL_MS`) : la sortie se déclenche sur `phase → finished`, pas sur `agent-remove` ; pas de XState ni de bibliothèque de tween ; ne pas toucher `state.js` ni `purity.test.mjs`.

## Skills / outils recommandés
- `engineering:testing-strategy` : couverture des transitions.
- `animate` / `emil-design-eng` : enchaînement des clips et durée des bulles.

## Dépendances
- F-26

## Taille
M

### F-31 · [viz-web] Interruptions, reprise, geste du chef de projet et mode réduit dans `crew.js`
## Contexte
Le cycle de vie des agents n'est pas monotone (ADR 0008) : un agent peut finir avant d'atteindre son poste, ou être repris après sa sortie. Le chef de projet doit aussi montrer qu'il agit, sans inventer de comportement : son geste suit des transitions réellement émises par `state.js`. Enfin, `prefers-reduced-motion` supprime toute marche. Cette logique, la plus risquée du milestone, complète `crew.js` (F-27) dans une feature à part.

## Objectif
`stepCrew` gère les interruptions et la reprise depuis la position courante, le geste du chef de projet et le mode réduit, conformément à l'ADR 0011.

## Critères d'acceptance
- [ ] Un `finished` reçu pendant `entering` fait demi-tour vers la porte depuis la position courante (raccordement `paths.js` sur la polyligne en cours).
- [ ] Une reprise (`finished` → `running` ou `reported`) pendant `leaving` ou après `gone` relance `entering` vers le **même** poste s'il est libre, sinon vers la première place libre.
- [ ] Pendant une marche, au plus une transition en attente par bonhomme : la **dernière** reçue est gardée ; un `reported` ou un `unknown` reçu pendant `entering` est appliqué à l'arrivée, et la bulle dure 4 s à partir de l'arrivée.
- [ ] Chef de projet : toujours présent à son bureau, assis sans taper (`sit`) au repos ; chaque transition `feature-move`, `feature-status`, ou `release` passant à `merged` lui fait jouer un cycle d'`interact-right` puis revenir à `sit` ; au-delà d'un geste par seconde, les transitions sont ignorées, sans file.
- [ ] `reduced = true` : aucune marche (passage direct à `working` au poste, ou à `gone`), clips figés sur leur première image ; bulles et dossiers inchangés.
- [ ] Tests unitaires (`tests/viz-web/crew.test.mjs`) : `finished` pendant `entering`, reprise pendant `leaving` et après `gone`, poste repris puis occupé par un autre, `reported` pendant `entering` (bulle de 4 s depuis l'arrivée), deux changements pendant une marche (seul le dernier compte), chef de projet en `sit` au repos, geste du chef de projet sur chacune des trois transitions et limité à un par seconde (excédent ignoré), mode réduit sur chaque état, `assertPure("crew.js")` toujours vert.
- [ ] Tests d'intégration : la fixture `cycle-complet.jsonl` complétée d'une reprise d'agent (`finished` puis `running`) produit la suite d'états attendue ; rejouée en mode réduit, aucune position intermédiaire de marche n'apparaît.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`, `docs/architecture/adr/0008-*`
- Fichiers / modules concernés : `viz/public/js/crew.js`, `tests/viz-web/crew.test.mjs`, `tests/fixtures/journal/cycle-complet.jsonl`
- Contraintes : le déclencheur du geste du chef de projet ne s'appuie que sur les transitions existantes de `state.js` (aucune modification de `state.js`) ; ne pas toucher `purity.test.mjs`.

## Skills / outils recommandés
- `engineering:testing-strategy` : cas limites du cycle non monotone.
- `apple-design` : interruptions crédibles d'une marche.

## Dépendances
- F-27

## Taille
M

### F-28 · [viz-web] Rendu des bonhommes (`characters.js`) branché dans la page
## Contexte
C'est l'incrément visible de M6 : les états calculés par `crew.js` deviennent de petits bonhommes Kenney animés dans le bureau. `characters.js` ne décide rien (ADR 0011) : il clone les modèles, joue les clips et place bulles et dossiers. Les sphères d'`agents.js` cessent d'être affichées ; leur code est supprimé ensuite (F-29).

## Objectif
`characters.js` affiche et anime un bonhomme par entrée de `crew.js` (modèle, position, cap, clip, bulle, dossier), et `main.js` l'utilise à la place d'`agents.js`.

## Critères d'acceptance
- [ ] Chaque modèle de personnage est chargé une seule fois par `GLTFLoader` puis cloné par `SkeletonUtils.clone` ; chaque bonhomme a son `AnimationMixer` ; un changement de clip fait un fondu croisé de 0,2 s (`crossFadeTo`) ; en mode réduit, le clip est figé sur sa première image.
- [ ] Position et cap suivent exactement les valeurs de `crew.js` à chaque image ; un bonhomme `gone` est retiré de la scène et son mixer libéré.
- [ ] Bulles de verdict en `CSS2DObject` ; dossier = primitive Three.js (boîte) posée sur le poste, avec une étiquette CSS2D `#N` ; tout texte écrit par `textContent` ; leurs styles vivent dans `viz/public/css/characters.css`, lié dans `index.html`.
- [ ] Si un modèle ne se charge pas, le bonhomme est remplacé par une capsule colorée selon le type d'agent (`agentColor` de `motion.js`), et `ui.js` affiche un avertissement unique.
- [ ] Quand un poste supplémentaire (`devSeat(i ≥ 3)`) est occupé, ses meubles sont ajoutés à la scène, puis retirés quand il se libère.
- [ ] `main.js` importe `characters.js` au lieu d'`agents.js` ; le bloom n'est plus appliqué ; le repli texte et `?mode=texte` sont inchangés.
- [ ] Tests unitaires : fonctions pures éventuelles (correspondance type → couleur de capsule, choix de l'action à jouer) testées hors WebGL.
- [ ] Tests d'intégration (`tests/viz-web/characters.test.mjs`) : sous Node avec `three-register.mjs` et un faux chargeur, une suite d'états `crew.js` provoque l'ajout du bonhomme, le jeu des clips attendus dans l'ordre, la création puis le retrait de la bulle et du dossier, et son retrait à `gone` ; un poste supplémentaire occupé ajoute ses meubles ; un chargeur en échec produit une capsule et l'avertissement ; `main.test.mjs` vérifie le nouvel import ; `page.test.mjs` inclut `characters.js` dans la liste des modules qui importent `three`, et sa règle « chaque module qui importe `three` importe `./view-model.js` ou `./layout.js` » est élargie aux modules purs (`view-model`, `office-layout`, `crew`, `assets`, `motion`).
- [ ] Smoke manuel documenté dans la PR (captures et console) : un agent entre, travaille, rend son verdict et sort ; avec `prefers-reduced-motion`, aucune marche ; aucune erreur console ni CSP ; `?mode=texte` fonctionne.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`, `docs/architecture/adr/0009-metaphore-bureau-3d.md`
- Fichiers / modules concernés : `viz/public/js/characters.js` (nouveau), `viz/public/css/characters.css` (nouveau), `viz/public/index.html`, `viz/public/js/main.js`, `viz/public/js/ui.js`, `tests/viz-web/characters.test.mjs` (nouveau), `tests/viz-web/main.test.mjs`, `tests/viz-web/page.test.mjs`
- Contraintes : aucune logique de décision dans `characters.js` ; utiliser les points d'extension de `scene.js` (`addLayer`, `onFrame`, `onUpdate`) ; ne pas supprimer `agents.js` ici (F-29).

## Skills / outils recommandés
- `animate`, `apple-design`, `emil-design-eng` : fondus entre clips, apparition des bulles.
- `web-design-guidelines` : `prefers-reduced-motion`, lisibilité des bulles.
- `run` (navigateur intégré) : smoke manuel.

## Dépendances
- F-24, F-31

## Taille
M

### F-29 · [viz-web] Retirer le pipeline lumineux : `agents.js`, `layout.js` et le bloom
## Contexte
Après F-28, les sphères lumineuses, le bloom et l'ancien plan du pipeline ne servent plus (ADR 0009). Les garder ferait vivre du code mort, des tests obsolètes et des addons vendorés inutiles dans le plugin. Le retrait a lieu une fois le remplaçant en place, pour que la suite reste verte à chaque étape.

## Objectif
`agents.js`, `layout.js`, leurs tests et les addons `postprocessing` ne font plus partie du plugin, et plus aucun module n'y fait référence.

## Critères d'acceptance
- [ ] `viz/public/js/agents.js` et `viz/public/js/layout.js` sont supprimés, ainsi que `tests/viz-web/agents.test.mjs` et `tests/viz-web/layout.test.mjs` ; ce qui reste utile de `layout.js` (s'il en reste) a migré dans `office-layout.js` avec ses tests.
- [ ] `scripts/vendor-three.sh` ne liste plus `postprocessing/*` ni les shaders du bloom (`CopyShader`, `LuminosityHighPassShader`, `OutputShader`) ; ces fichiers sont retirés de `viz/public/vendor/three/addons/` ; `vendor.test.mjs` vérifie leur absence.
- [ ] `motion.js` n'exporte plus `BLOOM`, `GLOW_LUMINANCE`, `glowScale`, `luminance`, `AGENT_LOOKS`, `agentLook`, `PULSE_PERIOD_SECONDS`, `pulseOffset`, `pulseScale`, `FADE_SECONDS`, `fadeStep`, `initialOpacity`, `agentVisible`, `INVISIBLE`, `AGENT_FOLLOW_RATE` ni `followPoint`, sauf ceux que `characters.js` importe (listés dans la PR) ; un test vérifie leur absence ; les autres exports restent, avec leurs tests ; `purity.test.mjs` et la règle de `page.test.mjs` ne citent plus `layout.js`.
- [ ] `setRender` de `scene.js` est retiré s'il n'a plus d'appelant (test `scene` adapté), et plus aucun commentaire de `scene.js` ou `main.js` ne cite `EffectComposer`.
- [ ] `viz/public/css/agents.css` et son `<link>` dans `index.html` sont supprimés s'ils ne servent plus.
- [ ] `grep -rnE "(^|[^-])\b(agents|layout)\.js|UnrealBloomPass|EffectComposer" viz/public/js viz/public/index.html viz/public/css tests scripts` ne renvoie rien.
- [ ] Tests unitaires : suites existantes adaptées (`motion`, `purity`, `vendor`) et vertes.
- [ ] Tests d'intégration : `tests/viz-web/integration.test.mjs` et `page.test.mjs` au vert ; l'importmap de `index.html` ne référence aucun fichier supprimé.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`, `bash -n scripts/vendor-three.sh`).

## Notes techniques
- Sous-projet : `viz-web`
- ADR de référence : `docs/architecture/adr/0009-metaphore-bureau-3d.md`, `docs/architecture/adr/0010-assets-3d-cc0-vendores-gltf.md`
- Fichiers / modules concernés : `viz/public/js/agents.js`, `viz/public/js/layout.js`, `viz/public/js/motion.js`, `viz/public/js/scene.js`, `viz/public/js/main.js`, `viz/public/css/agents.css`, `viz/public/index.html`, `tests/viz-web/page.test.mjs`, `scripts/vendor-three.sh`, `viz/public/vendor/three/addons/postprocessing/**`, `tests/viz-web/*`
- Contraintes : aucune modification de comportement visible ; `stations-parity` et `state` inchangés.

## Skills / outils recommandés
- `graphify` (graphe du projet) : retrouver tous les appelants avant suppression.

## Dépendances
- F-28

## Taille
S

### F-32 · [skills] Mode « CI locale » : la squad remplace GitHub Actions par l'exécution locale des contrôles
## Contexte
Sur ce projet, l'utilisateur a épuisé ses quotas GitHub Actions (artefacts et minutes de calcul) ; le workflow `CI` a été désactivé et `.gepet-squad.json` porte désormais `"ci": { "mode": "local", "commands": [...] }`. Aujourd'hui, le plugin suppose une CI GitHub Actions : l'architecte la propose d'office, le socle de chaque roadmap la crée, et rien ne garantit qu'un merge sur `develop` ou une PR de release a passé les mêmes contrôles. L'utilisateur veut que ce mode de fonctionnement devienne une option du plugin, livrée dans la prochaine version : en mode local, le **testeur** est la barrière qui remplace la CI, et le Chef de projet rejoue les contrôles avant la PR de release.

## Objectif
Le plugin gère une clé `ci` de `.gepet-squad.json` (`mode: "github" | "local"`, `commands`) : en mode `local`, le testeur exécute toutes les `ci.commands` sur la PR fusionnée avec `develop` avant tout PASS, le CP les rejoue sur `develop` avant d'ouvrir une PR de release, et aucun agent ne crée, n'attend ni ne réactive de workflow GitHub Actions.

## Critères d'acceptance
- [ ] `skills/gepet-squad/references/github-conventions.md` documente la clé optionnelle `"ci": { "mode": "github" | "local", "commands": ["…"] }` : absente ou `mode: "github"` = comportement actuel ; `mode: "local"` = aucune exécution GitHub Actions, `commands` = liste ordonnée des contrôles (install, lint, build, tests, vérifications de scripts) lancés à la racine du repo ; un exemple complet est donné.
- [ ] `agents/testeur.md` : en mode `local` (lu dans `.gepet-squad.json` de son worktree), le testeur exécute **chaque** commande de `ci.commands`, dans l'ordre, sur la branche de la PR fusionnée localement avec le dernier `develop` ; une commande en échec donne `Verdict: FAIL` ; le commentaire « 🧪 Tests de non-régression » contient une section `### CI locale` avec une ligne par commande (`<commande> → OK | ÉCHEC`). Le bloc `RAPPORT_TESTS` reste inchangé (5 lignes).
- [ ] `agents/developpeur.md` : en mode `local`, le développeur exécute les `ci.commands` avant d'ouvrir la PR (ou de pousser un correctif) et n'attend ni ne consulte `gh pr checks`.
- [ ] `skills/gepet-squad/SKILL.md` : en mode `local`, (a) phase 5 : avant de créer la branche `release/*`, le CP exécute les `ci.commands` sur `develop` à jour et n'ouvre la PR de release que si toutes passent (sinon il signale l'échec à l'utilisateur en une ligne) ; le corps « PR de release » de `github-conventions.md` gagne la ligne `CI locale sur develop : <N>/<N> commandes OK` ; (b) aucune étape ne crée, ne réactive ni n'attend un workflow GitHub Actions.
- [ ] Cadrage : `agents/architecte.md`, `references/architecture-template.md` (§ Hébergement & CI), `references/feature-template.md` (règle 6) et `references/roadmap-template.md` ou la phase 3 du SKILL prévoient le cas local : quand `ci.mode` vaut `local`, le socle d'une nouvelle roadmap ne crée pas de workflow GitHub Actions et définit à la place `ci.commands` dans `.gepet-squad.json`.
- [ ] `skills/gepet-squad-resume/SKILL.md` : à la reprise, si `ci.mode` vaut `local`, le CP le signale dans son annonce (une ligne) ; aucun autre changement de logique de reprise.
- [ ] Mode `github` (ou clé absente) : aucun changement de comportement ; `grep` confirme que chaque nouvelle instruction est conditionnée par `ci.mode` = `local`.
- [ ] Tests unitaires : nouveau `tests/skills/ci-local.test.cjs` qui vérifie que `github-conventions.md` documente `ci.mode` et `ci.commands`, que `agents/testeur.md`, `agents/developpeur.md` et `skills/gepet-squad/SKILL.md` mentionnent le mode local et `ci.commands`, et que `.gepet-squad.json` de ce repo est un JSON valide dont `ci.commands` est un tableau non vide de chaînes.
- [ ] Tests d'intégration : `claude plugin validate .` au vert ; chaque commande de `ci.commands` de ce repo s'exécute avec succès depuis la racine (preuve dans le commentaire de PR) ; le test du hook `guard.cjs` de `CLAUDE.md` au vert.
- [ ] Lint, build et suite de tests complète au vert : les `ci.commands` de `.gepet-squad.json` (`npm ci`, `npm run lint`, `npm test`, `bash -n` des trois scripts).

## Notes techniques
- Sous-projet : `skills`
- ADR de référence : aucun (changement du processus du plugin, documenté dans `github-conventions.md`)
- Fichiers / modules concernés : `skills/gepet-squad/SKILL.md`, `skills/gepet-squad-resume/SKILL.md`, `skills/gepet-squad/references/github-conventions.md`, `skills/gepet-squad/references/architecture-template.md`, `skills/gepet-squad/references/feature-template.md`, `skills/gepet-squad/references/roadmap-template.md`, `agents/testeur.md`, `agents/developpeur.md`, `agents/architecte.md`, `tests/skills/ci-local.test.cjs` (nouveau)
- Contraintes : tout en français ; ne pas toucher `.claude-plugin/plugin.json`, `CHANGELOG.md` ni `README.md` (version 0.9.0 et documentation portées par F-30, qui décrit aussi ce mode) ; le testeur et le vérificateur gardent leurs outils actuels (ni `Edit` ni `Write`) ; ne pas modifier `.github/workflows/ci.yml` ni réactiver le workflow ; ne pas toucher aux lignes `tools:` des agents.

## Skills / outils recommandés
- `plugin-authoring` : conventions de prompts de plugin.

## Dépendances
- aucune

## Taille
M

### F-30 · [skills] Documenter les bonshommes et publier la 0.9.0
## Contexte
Avec M6, la vue montre enfin de petits bonhommes qui travaillent : c'est le besoin initial de l'utilisateur. Ce changement de comportement doit être documenté et versionné (`CLAUDE.md`), et le CHANGELOG doit signaler la disparition du bloom et des sphères.

## Objectif
README, skill `gepet-squad-viz` et CHANGELOG décrivent les bonhommes et leur cycle, et le plugin passe en 0.9.0.

## Critères d'acceptance
- [ ] `.claude-plugin/plugin.json` : `version` passe à `0.9.0`.
- [ ] `CHANGELOG.md` : entrée 0.9.0 qui décrit les bonhommes (entrée, travail, verdict, sortie, reprise), le chef de projet permanent, le comportement avec `prefers-reduced-motion`, la capsule de remplacement, et le retrait du bloom et des addons `postprocessing`.
- [ ] `grep -rniE "sphères? lumineuses?|agents? lumineux|repères? lumineux" README.md skills/` ne renvoie plus rien.
- [ ] `skills/gepet-squad-viz/SKILL.md` : au plus une phrase dans le message affiché après l'URL ; `tests/skills/viz-skill.test.cjs` au vert.
- [ ] `README.md` et `CHANGELOG.md` (entrée 0.9.0) décrivent aussi le mode « CI locale » de F-32 : clé `ci` de `.gepet-squad.json`, rôle du testeur et du CP.
- [ ] `README.md` décrit ce que fait chaque bonhomme selon le rôle et la phase de l'agent (tableau rôle → zone, et état → geste).
- [ ] Tests unitaires : sans objet (documentation, aucun code).
- [ ] Tests d'intégration : `claude plugin validate .` au vert, et les tests de `tests/skills/` au vert.
- [ ] Lint, build et suite de tests complète au vert (`npm run lint`, `npm test`).

## Notes techniques
- Sous-projet : `skills`
- ADR de référence : `docs/architecture/adr/0011-animation-scriptee-des-bonhommes.md`
- Fichiers / modules concernés : `.claude-plugin/plugin.json`, `CHANGELOG.md`, `README.md`, `skills/gepet-squad-viz/SKILL.md`
- Contraintes : seule feature de M6 qui touche `plugin.json` et `CHANGELOG.md` ; tout en français.

## Skills / outils recommandés
- `plugin-authoring` : conventions du plugin.

## Dépendances
- F-29, F-32

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
| F-16 | #44 |
| F-17 | #45 |
| F-18 | #46 |
| F-19 | #52 |
| F-20 | #53 |
| F-21 | #54 |
| F-22 | #55 |
| F-23 | #56 |
| F-24 | #57 |
| F-25 | #58 |
| F-26 | #59 |
| F-27 | #60 |
| F-28 | #62 |
| F-29 | #63 |
| F-30 | #64 |
| F-31 | #61 |
| F-32 | #76 |
