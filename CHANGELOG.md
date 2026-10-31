# Changelog

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
