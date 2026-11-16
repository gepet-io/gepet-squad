# 0012 — Sous-projet `conso` : CLI locale de consommation, sans dépendance
Statut : Acceptée — Date : 2026-11-16

## Contexte

L'utilisateur veut voir ce que consomme un projet squad, en **tokens bruts détaillés** : entrée, sortie, lecture de cache et écriture de cache. Il veut ce détail par agent (avec sa tentative), par feature et par milestone, plus la session du Chef de projet (CP). L'affichage se fait en texte, dans `/gepet-squad-status` et dans le bilan de fin de chaque milestone, en mode normal comme en mode économe. Il n'y a ni alerte, ni estimation en dollars, ni affichage dans la vue 3D.

La M4 (0.6.0) a réduit la consommation du CP par des consignes de prompt, mais son gain n'a jamais été mesuré (CHANGELOG, « Limite connue »).

Contraintes du plugin :
- aucune dépendance npm à l'exécution, aucun build ([ADR 0002](0002-stack-sans-build-three-vendore-sse.md)) ;
- Node ≥ 22, déjà requis par les hooks ;
- aucune écriture sur GitHub ni aucun appel GitHub en mode économe ([mode-econome.md](../../../skills/gepet-squad/references/mode-econome.md)).

Les chiffres d'usage n'existent que dans les transcripts locaux de Claude Code. Leur lecture fait l'objet de l'[ADR 0013](0013-contrat-lecture-transcripts-et-attribution.md).

## Décision

1. **Nouveau scope `conso`**, dans le dossier `conso/`, déclaré dans `.gepet-squad.json` (`"conso": { "path": "conso" }`). Il a un cycle de vie distinct de `viz-server` (CLI ponctuelle, sans serveur) et n'en dépend pas. Comme `viz-server`, il réutilise `hooks/lib/journal.cjs` (`findSquadRoot`, chemins du journal) par un chemin relatif, sans le modifier.
2. **Modules purs séparés des I/O** (même règle que l'ADR 0006) :
   | Fichier | Rôle | I/O |
   |---|---|---|
   | `conso/lib/transcripts.cjs` | Une ligne JSONL donne `{ messageId, model, ts, usage }` ou `null` ; déduplication par `message.id` | aucune (pur) |
   | `conso/lib/attribution.cjs` | Événements du journal, `.meta.json` et en-tête de mission donnent `{ role, mode, issue, pr, attempt }` pour un agent ; rattachement des messages du CP à un milestone | aucune (pur) |
   | `conso/lib/aggregate.cjs` | Messages attribués donnent un rapport (contrat JSON ci-dessous) | aucune (pur) |
   | `conso/lib/format.cjs` | Rapport en tableaux texte | aucune (pur) |
   | `conso/lib/sources.cjs` | Localisation et lecture en flux des transcripts (`node:readline`) et du journal | fichiers, en lecture seule |
   | `conso/cli.cjs` | Arguments (`node:util.parseArgs`), assemblage, sortie stdout, codes de sortie | stdout, stderr |
3. **Interface de la CLI** :
   ```
   node conso/cli.cjs [--project <dir>] [--milestone "<titre>=<id>,<id>…"]… [--focus "<titre>"] [--format texte|json]
   ```
   - `<id>` : un numéro d'issue (`12`) ou, en mode économe local, un identifiant `F-<n>` (`F-07`) ([ADR 0013](0013-contrat-lecture-transcripts-et-attribution.md), point 10).
   - `--project` : par défaut le dossier courant. La racine squad est trouvée par `findSquadRoot`.
   - `--milestone` (répétable) : le groupement des features en milestones. La CLI ne lit ni GitHub ni `etat.md` : c'est l'appelant (le skill) qui fournit ce groupement. Sans `--milestone`, le CP n'apparaît qu'en total, et les features ont `milestone: null`.
   - `--focus` : restreint la sortie (`milestones`, `features`, `agents`, `cp.parMilestone`) au milestone nommé, qui doit figurer parmi les `--milestone`. L'attribution reste calculée sur tout le projet, si bien que la part du CP est la même avec ou sans `--focus`. `totals` devient alors le total de ce milestone.
   - `--format` : `texte` par défaut.
   - Codes de sortie :
     - `0` : succès, y compris sans aucun transcript (avertissement dans le rapport) ;
     - `1` : pas de projet squad (pas de `.gepet-squad.json`) ;
     - `2` : arguments invalides.
4. **Contrat de sortie JSON, version 1.** Il est posé par la feature qui livre l'agrégat et ne change ensuite que par un ADR.
   ```
   Usage   = { input, output, cacheRead, cacheWrite, total, messages }     // entiers ; total = somme des 4 compteurs
   Rapport = { v: 1, generatedAt, project,
               totals: Usage,
               cp:        { sessions, usage: Usage, parMilestone: [{ milestone, usage }] },
               milestones:[{ titre, issues: [id], usage: Usage }],          // agents des features + part du CP ; id = entier ou "F-<n>"
               features:  [{ issue, milestone, agents, usage: Usage }],
               horsFeature: { agents, usage: Usage },                       // architecte en cadrage, revue de roadmap
               agents:    [{ agentId, role, mode, issue, pr, attempt, model, debut, fin, usage: Usage }],
               nonAttribue: { usage: Usage, fichiers },
               warnings:  [{ code, message }] }
   ```
   - `role` : le nom court de l'agent, comme `type` dans `/state`.
   - `issue` (dans `features` et `agents`) : un entier, ou une chaîne `F-<n>` en mode économe local ; `null` pour un agent hors feature.
   - `attempt` : un entier, ou `null` s'il est inconnu.
   - `model` : le modèle majoritaire de l'agent.
   - `warnings` peut contenir :
     - `TRANSCRIPTS_ABSENTS` : aucun transcript trouvé (purge, autre machine) ;
     - `JOURNAL_ABSENT` ;
     - `LIGNES_ILLISIBLES` : nombre de lignes ignorées ;
     - `AGENTS_NON_ATTRIBUES` ;
     - `FORMAT_ANCIEN` : lignes `isSidechain` dans un transcript principal ([ADR 0013](0013-contrat-lecture-transcripts-et-attribution.md), point 7).
5. **Format texte.** Les nombres sont des entiers exacts, groupés par une espace (`1 234 567`). Le rendu enchaîne trois tableaux :
   - un tableau par milestone (`Milestone | Agents | CP | Entrée | Sortie | Cache lu | Cache écrit | Total`) ;
   - un tableau par feature (`# | Agents | Tentatives | Entrée | Sortie | Cache lu | Cache écrit | Total`) ;
   - une ligne CP, une ligne hors feature et une ligne non attribué.

   Avec `--focus`, le rendu se limite au milestone nommé et à ses features. Le texte ne contient que des numéros, des rôles, des modèles et des nombres.
6. **Affichage**, côté scope `skills` :
   - `/gepet-squad-status` ajoute une section « Consommation » : il appelle la CLI avec un `--milestone` par milestone. Le groupement vient de `gh issue list` en mode normal et hybride, ou de `docs/squad/etat.md` en mode économe local.
   - En phase 5, le CP appelle la CLI avec tous les `--milestone` connus et `--focus` égal au milestone livré. Il recopie le texte dans une section « Consommation » du corps de release, qui est le corps de PR `release/*` (`github-conventions.md`) ou la note `docs/squad/releases/m<k>-<slug>.md` en mode économe. Ce bilan **persiste** ainsi au-delà de la purge des transcripts.
   - Le bilan final (fin du dernier milestone) reprend le total du projet.
7. **Stack** : Node.js ≥ 22, CommonJS, modules `node:*` uniquement (`fs`, `path`, `os`, `readline`, `util`). Aucune dépendance, aucun build, ESLint 10 existant.
8. **Tests**, uniquement des tests **essentiels** ([`tests-et-ci.md`](../../../skills/gepet-squad/references/tests-et-ci.md)), dans `tests/conso/`, avec les fixtures dans `tests/fixtures/transcripts/` (extraits réels anonymisés : session CP, `agent-*.jsonl`, `.meta.json`, journal) :
   - **unitaires** : déduplication par `message.id`, ligne illisible ou sans `usage` ignorée, attribution par `toolUseId` puis par en-tête de mission, rattachement du CP à un milestone, agrégats et rendu texte ;
   - **intégration** : `conso/cli.cjs` lancé en sous-processus, avec un `CLAUDE_CONFIG_DIR` temporaire et un repo git temporaire qui contient `.gepet-squad.json` et un journal. On vérifie la sortie JSON et la sortie texte, les codes 1 et 2, et l'avertissement `TRANSCRIPTS_ABSENTS` ;
   - **aucun test complexe** : la suite `conso` doit tenir en quelques secondes.
9. **CI** : inchangée. `npm test` découvre `tests/conso/` et `npm run lint` couvre `conso/`. `ci.commands` et `.github/workflows/ci.yml` ne bougent pas.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| **ccusage** (npm, 20.0.x, maintenu) | Outil mûr, rapports par jour et par session, coûts | Ne connaît ni les features, ni les tentatives, ni les milestones de la squad ; exécution par `npx` (réseau, dépendance au runtime) ; ventilation par subagent non confirmée |
| Logique dans `viz-server` (route `/conso`) | Réutilise le serveur | Impose un serveur pour un affichage texte ; ni `/gepet-squad-status` ni le bilan n'en ont besoin ; couple deux cycles de vie |
| Logique dans `hooks/` (calcul à chaque `SubagentStop`) | Chiffres prêts à l'avance | Alourdit un collecteur qui doit rester trivial et ne jamais échouer ; ne voit pas le CP ; double stockage |
| CLI qui lit elle-même GitHub ou `etat.md` pour les milestones | Appel plus simple | Duplique la lecture d'état des skills ; ajoute `gh` et donc une branche par mode dans la CLI |
| Télémétrie OpenTelemetry de Claude Code | Officielle, riche | Il faut un collecteur et un backend ; disproportionné pour un affichage texte local |

## Conséquences

- Nouveau scope `conso`, à déclarer dans `.gepet-squad.json`. Le scope `skills` s'élargit de `skills/gepet-squad-viz` à `skills/`, puisque `gepet-squad-status`, `gepet-squad` et ses références changent aussi.
- `hooks/lib/journal.cjs` devient un contrat lu par deux scopes (`viz-server`, `conso`) : on ne le modifie pas sans vérifier les deux.
- Le schéma d'événement v1 ne change pas (ADR 0013).
- `/gepet-squad-status` exige Node ≥ 22, déjà requis par les hooks.
- Le bilan de release gagne une section « Consommation » : `github-conventions.md` (corps de PR de release) et `mode-econome.md` (note de release) sont mis à jour avec le SKILL.
- Version du plugin : **0.11.0**, portée par la dernière feature du milestone, avec une entrée CHANGELOG et une section README « Consommation » complétée (où lire les chiffres, purge des transcripts).
