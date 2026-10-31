# 0001 — Découpage de la visualisation dans le plugin
Statut : Acceptée — Date : 2026-10-30

## Contexte

La visualisation 3D temps réel est une nouvelle brique du plugin `gepet-squad`. Elle a trois responsabilités, qui ont des cycles de vie différents :
- **collecter** des événements pendant la session Claude Code : c'est un hook, lancé à chaque appel d'outil concerné ;
- **servir** un état à jour : c'est un processus long, démarré à la demande ;
- **afficher** la scène 3D : ce sont des fichiers statiques chargés par le navigateur.

Une commande utilisateur doit aussi démarrer et arrêter le serveur.

Claude Code impose déjà la structure du plugin : `hooks/hooks.json`, `skills/<nom>/SKILL.md`, `agents/`, `scripts/`. Le plugin s'installe tel quel depuis la marketplace : il n'y a ni `npm install` ni build chez l'utilisateur.

## Décision

On garde **un seul repo** (le plugin) et on découpe en **5 scopes** placés dans les dossiers que le plugin impose :

| Scope | Dossier | Responsabilité |
|---|---|---|
| `hooks` | `hooks/events.cjs`, `hooks/lib/`, nouvelles entrées dans `hooks/hooks.json` | Collecteur d'événements, distinct de `guard.cjs` |
| `viz-server` | `viz/server.cjs`, `viz/lib/` | Serveur HTTP local, SSE, instantané GitHub |
| `viz-web` | `viz/public/`, `scripts/vendor-three.sh` | Front 3D (modules ES, Three.js vendoré et son script de mise à jour) |
| `skills` | `skills/gepet-squad-viz/` | Commande `/gepet-squad-viz [stop]` et documentation (README) |
| `repo` | racine : `package.json`, `eslint.config.mjs`, `.github/workflows/`, `.gitattributes`, `tests/helpers/` | Outillage transverse : lint, tests, CI |

- Il n'y a pas de layout `apps/` ni `packages/`. Le seul code partagé est le schéma d'événement v1, dans `hooks/lib/schema.cjs` : il est produit par `hooks`, et `viz/` le lit par un chemin relatif à `__dirname`, ce qui marche puisque tout est livré dans le même plugin.
- Les scopes sont à déclarer dans `.gepet-squad.json` (`scopes`), avec `path` pointant vers le dossier principal de chaque scope.
- `guard.cjs` n'est **pas modifié**. Le collecteur est un hook séparé, `async`, qui ne prend aucune décision.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Un seul dossier `viz/` qui contient aussi le collecteur | Tout est au même endroit | Les hooks d'un plugin vivent dans `hooks/`, et le collecteur a un cycle de vie (appelé par Claude Code) différent du serveur |
| Monorepo `apps/viz-server`, `apps/viz-web`, `packages/schema` | Convention habituelle de la squad | Contredit la structure imposée par Claude Code et ajoute des niveaux sans valeur |
| Repo séparé `gepet-squad-viz` (second plugin) | Cycle de version indépendant | Deux installations, le contrat d'événements reste couplé aux hooks du premier plugin, et la marketplace se complique |
| Fusionner le collecteur dans `guard.cjs` | Un seul hook `Bash` | Mélange un hook bloquant et synchrone avec un collecteur non bloquant : un bug du collecteur pourrait casser le garde-fou |

## Conséquences

- Chaque feature de la roadmap touche **un seul scope**. Les contrats (`hooks/lib/schema.cjs`, forme de `/state`) sont posés par leur première feature et ne changent ensuite que par un ADR.
- La distribution reste celle du plugin, par la marketplace. Chaque milestone change le comportement du plugin, et donc chaque release `main` porte sa version (convention de `CLAUDE.md`). Le bump mineur et l'entrée de CHANGELOG sont faits par la **dernière feature du milestone**, qu'aucune autre feature ne modifie en parallèle : 0.2.0 pour M1 (collecte), 0.3.0 pour M2 (serveur), 0.4.0 pour M3 (vue 3D et commande).
- `hooks/hooks.json` reçoit de nouvelles entrées (`PreToolUse` et `PostToolUse` sur `Agent`, `SubagentHandback` et `Bash`, ainsi que `SubagentStart` et `SubagentStop`) à côté de l'entrée existante du garde-fou. Les features qui modifient ce fichier ne doivent pas tourner en parallèle.
