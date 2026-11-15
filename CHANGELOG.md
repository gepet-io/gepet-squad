# Changelog

## 0.10.0 — 2026-11-15

Version économe : un projet peut tourner sans rien consommer sur GitHub, et les tests sont allégés dans les deux modes.

- **Choix du mode au démarrage.** Avant tout démarrage, le Chef de projet demande « Rester en mode économe ? » (oui par défaut). Le choix est écrit dans `.gepet-squad.json` (`"mode": "econome" | "normal"`) ; un projet existant sans la clé reste en mode normal.
- **Mode économe** (nouvelle référence `mode-econome.md`). Ni repo créé, ni labels, milestones, issues, PR, commentaires, workflow ou package, ni push. Roadmap dans `docs/roadmap.md`, une fiche par feature dans `docs/squad/features/`, statuts dans `docs/squad/etat.md`, rapports dans `docs/squad/rapports/F-xx/*.md`, note de release dans `docs/squad/releases/`. Les missions reçoivent le nouveau champ `SUIVI` (chemin absolu de `docs/squad`), `ISSUE: F-xx`, pas de `PR`, et `RAPPORT` devient un chemin ; dans les blocs Flash, `PR: local` et `Détail:` donne le chemin du fichier. Branches locales, merge squash local par le CP, release mergée sur `main` par l'utilisateur. Toujours un monorepo, CI locale toujours active.
- **`bootstrap.sh --local <nom>`** : branches `main` et `develop` locales et `.gepet-squad.json` économe, sans `gh` ni push. Le bootstrap normal écrit désormais `"mode": "normal"` et `"packages": { "enabled": false }`.
- **Garde-fou.** Bloque tout `git merge` sur `main` (dans les deux modes) ; en mode économe, bloque aussi tout `git push` et les commandes `gh` qui écrivent sur GitHub. Nouveau `tests/hooks/guard.test.cjs`.
- **Tests sobres** (nouvelle référence `tests-et-ci.md`). Deux niveaux : tests **essentiels** (1 à 3 tests par critère, sans réseau, environ 3 min pour tout le repo) lancés par le développeur, le testeur et la CI ; tests **complexes** (e2e, vrais services, longs) hors CI, lancés de façon ciblée par le **vérificateur**, dont le bloc gagne `Tests complexes: <passés>/<lancés> | aucun`. Nouvelle règle 7 de `feature-template.md`, colonnes « tests essentiels » et « tests complexes » dans les commandes de l'architecture et du PITCH.
- **Testeur : candidat d'abord.** La baseline de `develop` n'est lancée que si le candidat a des échecs (`baseline non lancée` sinon).
- **Économe hybride.** Seconde question de la phase 0 (`"suivi": "local" | "hybride"`, local par défaut). En hybride : repo, labels, issues et PR sur GitHub comme en mode normal, mais rapports en fichiers `docs/squad/rapports/<n°>/`, ni CI ni package ; `bootstrap.sh <owner/repo> --hybride` ; le garde-fou y bloque `gh pr comment`, `gh issue comment` et `gh pr review`.
- **CI à la release (mode normal).** Nouveau `ci.mode` = `release`, écrit par défaut par le bootstrap normal : les features sont validées en local par `ci.commands` (développeur, puis testeur comme barrière) et GitHub Actions ne tourne que sur la PR `release/*` → `main`, une fois par milestone. Le workflow minimal : un job ubuntu sans matrice, `concurrency` avec annulation, `paths-ignore` sur la doc, `timeout-minutes: 10`, et seulement install, lint, build, tests essentiels. Plus aucun `upload-artifact` : les rapports sont ceux du vérificateur et du testeur. `ci.mode` = `github` garde l'ancien comportement.
- **Audit des dépendances à la release, sans Dependabot.** La squad ne crée jamais de `dependabot.yml` ni de PR de mise à jour automatique. L'architecture donne une commande « audit » par sous-projet ; le CP la lance sur `develop` avant chaque release, dans tous les modes. Faille haute ou critique : nouvelle feature `type:tech` du milestone, que la release attend ; les autres sont listées dans le corps de release.
- **Labels groupés.** Une transition = une seule commande `gh issue edit` (statut et `retry:*` ensemble), sans relire l'issue ; `gh issue list` seulement au début d'un milestone et après un merge.
- **Vue 3D plus sobre.** Recalage GitHub toutes les 3 minutes (au lieu de 60 s), sauté tant qu'aucune page n'est connectée et rattrapé dès la reconnexion ; la page ferme son flux après une minute en arrière-plan et se reconnecte à son retour.
- **CI de ce repo.** `.github/workflows/ci.yml` ne tourne plus que sur les PR vers `main` (matrice ubuntu × windows gardée, une fois par release), avec `concurrency`, `paths-ignore` et `timeout-minutes` ; `.gepet-squad.json` passe en `ci.mode` = `release`.
- **Packages (mode normal).** Aucun par défaut. Question au cadrage (non par défaut) ; en cas d'accord, `release.yml` ne se déclenche qu'à la publication d'une release GitHub par l'utilisateur, après son merge sur `main`.
- `/gepet-squad-resume` et `/gepet-squad-status` lisent `docs/squad/etat.md` en mode économe.

**Limites connues :** ces changements sont des consignes de prompt, pas encore exécutées sur un cycle squad complet en mode économe. La vue `/gepet-squad-viz` ne montre pas les statuts des features d'un projet économe (elle les lit sur GitHub).

## 0.9.1 — 2026-11-15

Le repo devient public sous le nom `gepet-io/gepet-squad`, sous licence MIT. Aucun changement de comportement des agents.

- **Licence MIT** : nouveau fichier `LICENSE`, `"license": "MIT"` dans `plugin.json` (au lieu de `UNLICENSED`), avec `homepage` et `repository`.
- **Repo et marketplace renommés.** Le repo passe de `gepets/claude-gepet-squad` à `gepet-io/gepet-squad`, et la marketplace s'appelle désormais `gepet-squad`. Le préfixe `claude-gepet-squad:` reste accepté pour relire les anciens journaux.
- `.claude/worktrees/` (worktrees des agents) est ignoré par git.

**Migration** (sur chaque machine où le plugin est installé) :

1. `/plugin uninstall gepet-squad@claude-gepet-squad` ;
2. `/plugin marketplace remove claude-gepet-squad` ;
3. `/plugin marketplace add gepet-io/gepet-squad`, puis `/plugin install gepet-squad@gepet-squad`, et redémarrer la session.

## 0.9.0 — 2026-11-14

Milestone M6, « Bonshommes vivants » : les agents de la vue `/gepet-squad-viz` deviennent de petits bonhommes qui travaillent.

- **Bonhommes scriptés.** Chaque agent entre par la porte et marche jusqu'à son poste, tape au clavier pendant son travail, montre une bulle de verdict à son rapport, repart par la porte à sa fin et revient s'asseoir s'il est repris. Le tableau rôle → zone et état → geste est dans le README.
- **Chef de projet permanent.** Il reste assis à son bureau, sans taper, et fait un geste à chaque changement de statut d'une feature, merge ou release (au plus un par seconde).
- **`prefers-reduced-motion`.** Pas de marche : l'agent apparaît directement à son poste ou disparaît, les animations sont figées, seules les bulles et les dossiers changent.
- **Capsule de remplacement.** Un modèle 3D qui ne se charge pas est remplacé par une capsule colorée selon le rôle.
- **Retrait du bloom et des addons `postprocessing`.** Les repères lumineux, `agents.js`, `layout.js`, le bloom et les addons `postprocessing` de Three.js sont supprimés : le rendu est direct.
- **Mode « CI locale ».** Clé optionnelle `ci` de `.gepet-squad.json` (`mode` `local` et liste `commands`) : sans GitHub Actions, le développeur lance les contrôles avant sa PR, le testeur les rejoue sur la PR fusionnée avec `develop` et sert de barrière, le chef de projet les rejoue sur `develop` avant la release.
- Voir l'ADR 0011 pour la machine d'états.

## 0.8.0 — 2026-11-13

Milestone M5, « Bureau 3D : décor et kanban » : la vue `/gepet-squad-viz` change de métaphore.

- **Bureau 3D.** La scène des stations du pipeline est remplacée par le bureau de la squad : décor en modèles glTF (zones, postes, porte).
- **Kanban.** Les features sont des post-its rangés dans les colonnes de leur statut.
- **Agents provisoires.** Les agents restent des repères lumineux, remplacés par des bonhommes en 0.9.0.
- **Assets vendorés.** Packs CC0 de Kenney (Mini Characters et Furniture Kit, v2.0) dans `viz/public/vendor/kenney/`, poids mesuré avec `du -sh viz/public/vendor/kenney` : **1,9 Mo**. Licences et sha256 dans `SOURCE.md`. Crédit : www.kenney.nl.
- **Nouveau script `scripts/vendor-assets.sh`.** `bash scripts/vendor-assets.sh <zip-mini-characters> <zip-furniture-kit>` reconstruit le dossier vendorisé (procédure dans `CONTRIBUTING.md`).

## 0.7.0 — 2026-11-05

Réglages des agents et Graphify allégé.

- **Modèles et efforts.** Le vérificateur passe de `opus`/`high` à `sonnet`/`medium` ; le développeur passe à l'effort `medium`. README aligné (tableau des rôles).
- **Outils Godot.** Le développeur et le testeur peuvent utiliser les outils MCP `godot` (vérifier, lancer, capturer et piloter un projet Godot).
- **Graphify à la release.** Le Chef de projet met à jour le graphe de connaissances une fois par milestone (phase 5), plus après chaque merge de feature (§4.4), pour économiser des tokens.

## 0.6.0 — 2026-11-05

Milestone M4, « Économie de tokens » : réduire la consommation de la session principale (Chef de projet) sans perdre de traçabilité. Aucun changement de comportement visible pour l'utilisateur, aucune migration.

- **Rapports Flash (F-16).** Développeur, vérificateur et testeur répondent au Chef de projet par un bloc de 5 lignes maximum (verdict, références, chiffres clés, difficultés, URL). Le détail vit uniquement dans le commentaire de PR ; en échec, la mission `CORRECTIF` reçoit `RAPPORT: <URL du commentaire>` et le développeur relit lui-même le rapport. Les blocs de l'architecte ne changent pas.
- **Missions épurées et préfixe stable (F-17).** Une mission ne contient que des instructions et des références, jamais le corps d'une issue, un diff, un rapport ou un fichier ; les agents lisent eux-mêmes ce dont ils ont besoin. L'isolation des sous-agents est documentée (contexte vierge, `SendMessage` réservé à l'architecte pendant le cadrage). Les champs des missions vont du plus stable au plus variable (ordre fixé par `report-formats.md`) pour profiter du cache de prompt. Paragraphe « Consommation » dans le README.
- **État externe du Chef de projet (F-18).** Le volet « État externe » de la section « Économie de contexte » fait de GitHub et de `docs/roadmap.md` la mémoire du Chef de projet : l'état courant se reconstruit par `gh issue list --milestone … --json`, la roadmap ne se relit jamais en entier (`grep -n "^### F-"` puis lecture ciblée), et entre deux features il ne conserve que n° d'issue, n° de PR, verdict et compteur de retries. `/gepet-squad-resume` suit le même principe, sans nouvelle donnée d'état.
- **Revue de roadmap par chemin (F-18).** La table de correspondance publiée porte un titre fixe (`## Correspondance F-xx → issues GitHub`) que `/gepet-squad-resume` retrouve par ses lignes `| F-xx | #n |` ; la reprise ne repart jamais en phase 3 si des issues existent déjà. Le brouillon est écrit directement dans `docs/roadmap.md` et la mission `REVUE_ROADMAP` reçoit son chemin dans le nouveau champ `ROADMAP` au lieu de son contenu collé (`architecte.md`, `report-formats.md` et `roadmap-template.md` mis à jour).

**Limite connue :** ces changements sont des consignes de prompt ; le gain de tokens n'a pas été mesuré sur un cycle squad réel.

## 0.5.0 — 2026-11-04

Intégration optionnelle de [Graphify](https://pypi.org/project/graphifyy/) (paquet `graphifyy`) : un graphe de connaissances du code du projet piloté, tenu à jour par le Chef de projet.

- nouvelle référence `skills/gepet-squad/references/graphify.md` (installation, construction, mise à jour, consultation) ;
- le Chef de projet vérifie la présence de `graphify` au cadrage (ou en phase 0 sur un repo existant), propose `pip install graphifyy` sans jamais bloquer en cas de refus, construit le graphe et active `"graphify": { "enabled": true }` dans `.gepet-squad.json` ;
- **mise à jour incrémentale après chaque merge sur `develop`** (seulement si du code a changé) et avant la release de chaque milestone ; un échec n'arrête pas la squad ;
- les missions reçoivent `GRAPHE: <chemin de graphify-out>` quand le graphe est à jour ; architecte, développeur, vérificateur et testeur le consultent en lecture seule (le code reste la référence) ;
- `graphify-out/` n'est jamais versionné ; `/gepet-squad-resume` le reconstruit si besoin.

**Limite connue :** les commandes Graphify (`graphify update .`, `graphify query`) n'ont pas été exécutées de bout en bout ; la référence demande de vérifier `graphify --help` selon la version installée.

## 0.4.0 — 2026-11-01

Vue 3D temps réel du projet et commande `/gepet-squad:gepet-squad-viz` : dernière brique de la visualisation (jalons M1 à M3).

**Vue 3D** (page servie par `viz/server.cjs`, lecture seule) :

- une scène Three.js avec les 7 stations du pipeline, les features (colorées par statut) en file devant leur station, et les agents sous forme de sphères lumineuses (bloom) dont la couleur dépend du type d'agent, plus un badge de tentative sur les features renvoyées en correctif ;
- des transitions animées : une feature glisse d'une station à l'autre quand son statut change, les agents apparaissent et s'estompent avec fondu et pulsation ; avec `prefers-reduced-motion: reduce`, les déplacements sont immédiats ;
- une mise à jour en continu par le flux SSE, recalée sur l'instantané GitHub (qui fait foi) toutes les 60 s ;
- un **repli texte** (pour chaque station, ses features et ses agents actifs) quand l'URL porte `?mode=texte` ou quand WebGL n'est pas disponible ;
- **Three.js 0.187.0 vendorisé** dans `viz/public/vendor/three/` (licence MIT incluse) : aucune dépendance npm ni accès réseau à l'exécution.

**Commande `/gepet-squad:gepet-squad-viz [stop]`** (skill `gepet-squad-viz`, invocation manuelle uniquement) :

- sans argument : vérifie la présence de `.gepet-squad.json` (dans le dossier courant ou un parent) et Node ≥ 22, réaffiche l'URL d'un serveur déjà lancé, sinon démarre `viz/server.cjs` en arrière-plan puis attend l'URL par `status --wait 20` ;
- `stop` : arrête le serveur du projet par `viz/server.cjs stop` et rapporte le résultat ;
- le skill ne manipule aucun pid et n'envoie aucun signal : il appelle uniquement la CLI du serveur.

**Correction (#33).** « Serveur vivant » a désormais une seule définition, partagée par `status`, le démarrage et `stop` : le pid du verrou existe **et** `GET /health` sur le port du verrou annonce ce même pid. Un pid réattribué à un autre processus après un arrêt brutal n'est donc plus pris pour le serveur, et `stop` ne lui envoie aucun signal.

**Limites connues :**

- les couleurs et le seuil du bloom ont été réglés sur un rendu logiciel (sans GPU) : à ajuster sur un vrai GPU si le rendu paraît trop clair ou trop sombre ;
- le respect de `prefers-reduced-motion` n'a pas été vérifié dans un vrai navigateur ;
- le repli sans WebGL réel n'est couvert que par des tests unitaires et par Edge sans GPU.

## 0.3.0 — 2026-10-31

Serveur local temps réel et modèle client : deuxième brique de la vue du projet (la page 3D et la commande `/gepet-squad-viz` arrivent en 0.4.0).

**Renommage du plugin en `gepet-squad`.** Les noms de plugin commençant par `claude-` sont réservés par Claude Code, et `claude plugin validate .` refusait l'ancien nom. Le repo GitHub et la marketplace gardent le nom `claude-gepet-squad`. Les agents se lancent désormais avec `subagent_type: gepet-squad:<agent>`.

**Migration** (obligatoire pour une installation existante) :

1. désinstaller l'ancien plugin : `/plugin uninstall claude-gepet-squad@claude-gepet-squad` ;
2. mettre à jour la marketplace : `/plugin marketplace update claude-gepet-squad` ;
3. installer le nouveau : `/plugin install gepet-squad@claude-gepet-squad`, puis redémarrer la session.

Les journaux existants restent lisibles : le collecteur et le serveur acceptent les deux préfixes (`gepet-squad:` et `claude-gepet-squad:`). Attention : `gepet-squad` n'est plus un nom réservé. Un autre plugin du même nom, installé depuis une autre marketplace, verrait ses agents collectés, car `agent_type` ne porte pas la marketplace.

**Serveur local (`node viz/server.cjs --project <dir>`)**, sans dépendance à l'exécution (modules `node:*` uniquement) :

- `GET /state` : l'état du projet (features, milestones, releases, agents, avertissements), fusion de l'instantané GitHub (`gh`, qui fait foi) et du journal d'événements. Le réducteur est pur ; un agent repris par `SendMessage` enchaîne plusieurs cycles début → fin sous le même `agentId` (ADR 0008).
- `GET /events` : flux SSE. Trois événements, `evt` (une ligne du journal), `snapshot` (état complet, recalage GitHub toutes les 60 s ou reprise impossible) et `warning` (échec de `gh`, le dernier instantané est conservé), plus un battement toutes les 15 s. Reprise par `Last-Event-ID` ; hors de la génération courante du journal, le serveur renvoie un `snapshot`.
- `GET /health` et fichiers statiques de `viz/public`.
- Sécurité (ADR 0005) : écoute sur `127.0.0.1` uniquement, `Host` étranger refusé (421), seules GET et HEAD acceptées (405), traversée de chemin refusée (403), types MIME en liste blanche, CSP sans `unsafe-inline` (empreinte de l'importmap), `nosniff`, `no-referrer`, aucun en-tête CORS, `Cache-Control: no-store` sur `/state` et `/events`. Le stderr brut de `gh` n'est jamais renvoyé au navigateur.
- Cycle de vie, par `viz.lock` (`<git-common-dir>/gepet-squad/viz.lock`, `{port, pid}`) :
  - `node viz/server.cjs status --project <dir> [--wait <s>]` affiche l'URL et sort avec 0 si le serveur est vivant ; sinon il sort avec 1 et supprime un verrou périmé. Le serveur n'écoute qu'après son premier instantané GitHub (jusqu'à 15 s) : juste après un démarrage, utiliser `status --wait 20`.
  - `node viz/server.cjs stop --project <dir>` arrête le serveur par `process.kill`, attend sa fin et supprime le verrou (sous Windows, `process.kill` ne laisse pas le serveur nettoyer : c'est `stop` qui le fait). Sans serveur vivant, il sort avec 1. Il refuse de signaler un processus dont le port ne répond pas comme le serveur (pid réattribué après un arrêt brutal).
  - un second démarrage pour le même projet affiche l'URL existante et sort avec 0, sans lancer de second serveur.
  - le verrou est une entrée non fiable : seuls un pid et un port entiers valides sont lus, un verrou invalide est traité comme périmé.

**Modèle client** (`viz/public/js/state.js`, `layout.js`) : modules purs, sans DOM, qui appliquent un événement SSE à l'état (reprise d'agent comprise, format SSE strict) et calculent les positions des stations, des files et des agents. Ils sont testés sans navigateur ; le rendu 3D arrive en 0.4.0.

## 0.2.0 — 2026-10-30

Collecteur d'événements : première brique de la vue du projet.

- Nouveaux hooks asynchrones (`async: true`, `hooks/events.cjs`) sur `PreToolUse` (`Agent|Task`, `SubagentHandback`), `PostToolUse` (`Agent|Task`, `Bash`), `SubagentStart` et `SubagentStop` (agents `claude-gepet-squad:*`). Le garde-fou `guard.cjs` est inchangé.
- Journal local `<git-common-dir>/gepet-squad/events.jsonl`, une ligne JSON (schéma v1) par événement, partagé entre le repo principal et ses worktrees. Rotation à 5 Mo (`events.1.jsonl`, un seul ancien fichier). Jamais commité.
- Actif uniquement dans un repo contenant `.gepet-squad.json` ; ailleurs, rien n'est écrit.
- Données minimisées : ni prompt ni rapport complet, seulement `MODE`, `ISSUE`, `PR`, `TENTATIVE`, l'en-tête du bloc de rapport et le verdict, plus les transitions des commandes `gh` du Chef de projet.
- Le collecteur ne bloque ni ne fait échouer la session : code de sortie 0, rien sur stdout, erreurs tracées dans `collector.log` (borné à 256 Ko).

## 0.1.0 — 2026-10-30

Première version.

- Chef de projet (skill `/gepet-squad`) : workflow complet en phases 0 à 6, avec deux validations utilisateur (architecture, roadmap).
- Agents `architecte`, `developpeur`, `verificateur`, `testeur`.
- Suivi sur GitHub via `gh` : milestones, issues au format feature (Contexte + Critères d'acceptance avec tests), labels `status:*` et `retry:*`, PR `feature/*` → `develop`, PR `release/mX` → `main` par milestone.
- Développement en parallèle dans des worktrees isolés (3 par défaut), escalade après 3 échecs.
- `/gepet-squad-resume` (reprise depuis GitHub) et `/gepet-squad-status` (avancement).
- `scripts/bootstrap.sh` (labels, branches, `.gepet-squad.json`), plus un hook garde-fou sur `main`.
