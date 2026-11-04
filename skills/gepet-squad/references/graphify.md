# Graphify : graphe de connaissances du projet

[Graphify](https://pypi.org/project/graphifyy/) (paquet PyPI `graphifyy`, commande `graphify`, Python ≥ 3.10) construit un graphe du code du projet piloté (`graphify-out/graph.json` et `graphify-out/GRAPH_REPORT.md`). Les agents le consultent pour se repérer sans relire tous les fichiers. La fonction est **optionnelle** : la squad fonctionne sans.

## Configuration

Dans `.gepet-squad.json` :

```json
"graphify": { "enabled": true }
```

Absent ou `enabled: false` : aucune étape Graphify n'est exécutée. Le dossier `graphify-out/` n'est **jamais versionné** (ajouté à `.gitignore` par le Chef de projet). Il vit uniquement dans le clone principal, sur `develop`.

## Rôles

| Qui | Quoi |
|---|---|
| Chef de projet | installe (avec accord), construit, **met à jour** le graphe, transmet son chemin aux agents |
| Architecte, développeur, vérificateur, testeur | **lisent seulement** (`GRAPHE` dans la mission) ; ne lancent jamais la construction ni la mise à jour |

## Chef de projet

1. **Disponibilité** : `graphify --help` (ou `python -m graphify --help`). Absent : demande à l'utilisateur (AskUserQuestion) s'il veut l'installer (`pip install graphifyy`, ou `pipx install graphifyy` si pip refuse). Refus ou échec : écris `"enabled": false`, dis-le en une ligne et continue sans graphe. Ne bloque jamais le projet pour ça.
2. **Construction initiale** (après l'architecture, ou à la reprise si le graphe manque) : à la racine du clone principal, sur `develop`, construis le graphe (`graphify update .` pour le code, qui s'exécute localement ; consulte `graphify --help` si la commande diffère dans la version installée). Ajoute `graphify-out/` à `.gitignore` et commit si le fichier a changé.
3. **Mise à jour** : après **chaque merge d'une PR sur `develop`** (phase 4.4) et avant de relancer les développements (4.1), puis avant la release (phase 5) : `git pull` sur `develop`, puis mise à jour **incrémentale** du graphe. **Seulement si du code a changé** : `git diff --name-only <ancien-HEAD> HEAD` ne contient que des docs ou des fichiers de configuration → saute la mise à jour.
4. **Échec ou graphe périmé** : une mise à jour qui échoue n'arrête rien. Signale-le en une ligne, retire `GRAPHE` des missions suivantes tant que le graphe n'est pas reconstruit, et retente à la prochaine mise à jour.
5. **Mission des agents** : ajoute `GRAPHE: <chemin absolu de graphify-out>` quand le graphe est à jour sur le dernier `develop`.

## Agents (lecture seule)

Le champ `GRAPHE`, s'il est présent, désigne un dossier hors de ton worktree. Lis d'abord `GRAPH_REPORT.md` (vue d'ensemble, modules centraux), puis interroge le graphe (`graphify query "<question>"`) pour trouver les fichiers, dépendances et appelants concernés **avant** de grepper. Le graphe est un **index** et peut être en retard sur ta branche : le code fait foi, lis toujours les fichiers que tu modifies ou que tu critiques. Sans `GRAPHE`, ou si `graphify` est introuvable, travaille comme d'habitude.
