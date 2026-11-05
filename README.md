# gepet-squad

Plugin Claude Code : une **squad IT d'agents** qui transforme un simple prompt en projet livré.

```
/gepet-squad "Créer une boutique e-commerce avec gestion des stocks et des livraisons"
```

## La squad

| Rôle | Où il vit | Ce qu'il fait |
|---|---|---|
| **Chef de projet** | la session principale (skill `gepet-squad`) | Orchestre tout le monde, rédige la roadmap et les features, tient les statuts, merge sur `develop`, ouvre les releases. Seul interlocuteur de l'utilisateur. |
| **Architecte** | agent `architecte` (opus) | Recueille le besoin, choisit l'architecture, la stack et le découpage en sous-projets, en réutilisant l'existant. Rédige ARCHITECTURE.md + ADR, valide la roadmap, gère les escalades. |
| **Développeur** | agent `developpeur` (sonnet), en worktree isolé | Implémente une feature et ses tests unitaires et d'intégration, puis ouvre la PR vers `develop`. Applique ensuite les correctifs. |
| **Vérificateur** | agent `verificateur` (opus), lecture seule | Code review : architecture, anti-patterns, sécurité, réinvention de l'existant, qualité des tests, critères d'acceptance. |
| **Testeur** | agent `testeur` (sonnet), lecture seule | Non-régression : suite complète sur la PR fusionnée localement avec `develop`, comparée à la baseline. |

> Pourquoi le Chef de projet est-il la session principale ? Dans Claude Code, un subagent ne peut ni lancer d'autres subagents ni parler à l'utilisateur. L'orchestrateur doit donc être la session.

## Le workflow

```
0. Bootstrap     gh auth · repo (créé après accord) · labels · develop · .gepet-squad.json
1. Cadrage       Architecte ⇄ vous (questions) → proposition → ✅ VOTRE VALIDATION → ADR sur develop
2. Pitch         Architecte → Chef de projet
3. Roadmap       CP rédige → Architecte relit → ✅ VOTRE VALIDATION → milestones + issues GitHub
4. Livraison     Dev ×3 en parallèle → PR → Vérificateur → Testeur → merge squash sur develop
                 FAIL → correctif (retry:1..3) → 3 échecs → escalade à l'architecte, ou à vous
5. Release       milestone complet → PR release/mX → main (c'est vous qui mergez)
6. Bilan
```

Après vos deux validations, tout est autonome. GitHub est la source de vérité : labels `status:*`, milestones, rapports en commentaires de PR.

## Consommation

La squad limite les tokens consommés sans réduire le contrôle :

- **Isolation** : chaque agent est lancé avec un contexte vierge, sans l'historique du Chef de projet, et un agent n'est jamais réutilisé d'un ticket à l'autre.
- **Input épuré** : une mission ne contient que des instructions et des références (n° d'issue ou de PR, branche, chemins). L'agent lit lui-même l'issue, le diff, les rapports et l'architecture au lieu de les recevoir collés.
- **Rapports Flash** : développeur, vérificateur et testeur répondent par un bloc de 5 lignes ; le détail reste dans un commentaire de PR (voir `report-formats.md`).
- **Cache de prompt** : les champs d'une mission vont du plus stable au plus variable, pour que le début du prompt soit identique d'un appel à l'autre et profite du cache de prompt d'Anthropic.
- **État externe** : le Chef de projet ne garde que des numéros et des verdicts. Il relit l'état sur GitHub et la feature concernée dans `docs/roadmap.md` (section ciblée, jamais le fichier entier), et la revue de roadmap par l'architecte se fait sur le chemin du fichier, pas sur son contenu collé.

## Commandes

| Commande | Rôle |
|---|---|
| `/gepet-squad "<besoin>"` | Lance un nouveau projet depuis le dossier du projet (vide ou repo existant). |
| `/gepet-squad-resume [consigne]` | Reprend un projet dans une nouvelle session, en reconstruisant l'état depuis GitHub. |
| `/gepet-squad-status` | Affiche l'avancement (lecture seule). |
| `/gepet-squad-viz [stop]` | Ouvre la vue 3D temps réel du projet (démarre un serveur local et affiche l'URL), ou l'arrête avec `stop`. |

Si un autre plugin utilise le même nom, la forme préfixée `/gepet-squad:gepet-squad` fonctionne toujours (de même `/gepet-squad:gepet-squad-viz`).

## La vue 3D : `/gepet-squad-viz`

Une vue en lecture seule du workflow d'un projet squad : les 7 stations du pipeline, les features qui avancent de l'une à l'autre selon leur statut, et les agents qui travaillent, sous forme de sphères lumineuses.

```
/gepet-squad-viz          démarre le serveur local (ou réaffiche l'URL s'il tourne déjà) et affiche l'URL à ouvrir
/gepet-squad-viz stop     arrête le serveur du projet
```

- **Où la lancer** : dans le dossier d'un projet squad, ou dans un de ses sous-dossiers (la commande remonte jusqu'à `.gepet-squad.json`). Hors d'un projet squad, elle répond par un message et ne démarre rien.
- **Prérequis** : Node ≥ 22 (`node --version`), plus la CLI `gh` authentifiée, car l'état de référence vient de GitHub. Aucun `npm install` : le serveur n'utilise que les modules de Node, et Three.js est vendorisé (`viz/public/vendor/three/`, version 0.187.0).
- **Démarrage** : le serveur écoute après son premier instantané GitHub, ce qui peut prendre jusqu'à 15 s ; la commande attend donc l'URL (20 s au plus). Un second appel affiche la même URL sans lancer un second serveur.
- **Sans WebGL** (ou en ajoutant `?mode=texte` à l'URL), la page affiche une vue texte : pour chaque station, ses features et ses agents actifs.
- **Ce qui est capté** : le collecteur (voir « Garde-fou ») note dans un journal local le lancement et la fin des agents de la squad, l'issue et la PR concernées, le mode et le numéro de tentative, le verdict de leur rapport, et les changements de statut passés par `gh`. La page fusionne ce journal et l'état GitHub, qui fait foi.
- **Confidentialité du journal** : `<dossier-git-commun>/gepet-squad/events.jsonl`, une ligne JSON par événement, jamais commité, avec rotation à 5 Mo. Il ne contient ni prompt ni rapport complet : seulement des champs extraits (voir `CHANGELOG.md`, 0.2.0). Rien n'est écrit hors d'un projet squad.
- **Réseau** : le serveur n'écoute que sur `127.0.0.1` (port choisi automatiquement), n'accepte que des requêtes de lecture et n'envoie aucun en-tête CORS. La page ne charge rien depuis Internet.

Limites connues : voir l'entrée 0.4.0 de `CHANGELOG.md`.

## Prérequis

- Claude Code récent
- [GitHub CLI](https://cli.github.com/) authentifiée : `gh auth login`
- `git`, `bash` (Git Bash sous Windows) et `node` (pour les hooks ; **Node ≥ 22** pour `/gepet-squad-viz`)

## Installation (une fois, au niveau utilisateur : disponible dans toutes les sessions)

Dans Claude Code :

```
/plugin marketplace add D:\DevClaude\claude-gepet-squad
/plugin install gepet-squad@claude-gepet-squad
```

Le plugin s'appelle `gepet-squad` ; le repo GitHub et la marketplace gardent le nom `claude-gepet-squad`.

Sur une autre machine, utilisez le repo GitHub : `/plugin marketplace add gepets/claude-gepet-squad`.

## Mettre à jour après une modification

1. Augmentez `version` dans `.claude-plugin/plugin.json` et complétez `CHANGELOG.md`.
2. Commitez (et poussez si le repo est sur GitHub).
3. Dans Claude Code : `/plugin marketplace update claude-gepet-squad`, puis redémarrez la session.

Pour tester une modification sans toucher la version installée :

```bash
claude --plugin-dir D:\DevClaude\claude-gepet-squad
```

## Personnalisation

| Quoi | Où |
|---|---|
| Nombre de devs en parallèle, nombre d'échecs avant escalade | `.gepet-squad.json` du projet (`maxParallelDevs`, `maxRetries`) |
| Modèle et effort d'un rôle | frontmatter `model:` / `effort:` dans `agents/<role>.md` |
| Format des features, des rapports et de la roadmap | `skills/gepet-squad/references/` |
| Règles du garde-fou | `hooks/guard.cjs` |

## Garde-fou et collecteur

Deux hooks agissent dans un repo qui contient `.gepet-squad.json` ; ailleurs, ils n'ont aucun effet.

- **Garde-fou** (`hooks/guard.cjs`, bloquant) : il refuse pour Claude le push direct sur `main`, le force-push sur `develop` et le merge d'une PR vers `main`. Le merge des releases reste votre décision.
- **Collecteur d'événements** (`hooks/events.cjs`, asynchrone) : il alimente le journal local de la vue 3D. Étant déclaré en `async`, il ne ralentit pas la session, ne bloque aucune action, ne produit rien sur la sortie standard et trace ses éventuelles erreurs dans `collector.log` au lieu de les remonter. Ce qu'il écrit est décrit dans « La vue 3D ».

## Structure

```
.claude-plugin/   plugin.json, marketplace.json
agents/           architecte, developpeur, verificateur, testeur
skills/           gepet-squad (Chef de projet + references/), gepet-squad-resume, gepet-squad-status, gepet-squad-viz
scripts/          bootstrap.sh, vendor-three.sh
hooks/            hooks.json, guard.cjs (garde-fou), events.cjs (collecteur) et lib/
viz/              server.cjs (serveur local, CLI start / status / stop), lib/, public/ (page 3D, Three.js vendorisé)
docs/             architecture (ARCHITECTURE.md, ADR) et roadmap
tests/            tests node:test (hooks, viz-server, viz-web, skills)
```
