# gepet-squad

Plugin Claude Code : une **squad IT d'agents** qui transforme un simple prompt en projet livré.

```
/gepet-squad "Créer une boutique e-commerce avec gestion des stocks et des livraisons"
```

## La squad

| Rôle                    | Où il vit                                         | Ce qu'il fait                                                                                                                                                                              |
| ------------------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Chef de projet** | la session principale (skill `gepet-squad`)      | Orchestre tout le monde, rédige la roadmap et les features, tient les statuts, merge sur `develop`, ouvre les releases. Seul interlocuteur de l'utilisateur.                            |
| **Architecte**     | agent `architecte` (opus)                        | Recueille le besoin, choisit l'architecture, la stack et le découpage en sous-projets, en réutilisant l'existant. Rédige ARCHITECTURE.md + ADR, valide la roadmap, gère les escalades. |
| **Développeur**   | agent `developpeur` (sonnet), en worktree isolé | Implémente une feature et ses tests unitaires et d'intégration, puis ouvre la PR vers `develop`. Applique ensuite les correctifs.                                                      |
| **Vérificateur**  | agent `verificateur` (sonnet), lecture seule     | Code review : architecture, anti-patterns, sécurité, réinvention de l'existant, qualité des tests, critères d'acceptance.                                                             |
| **Testeur**        | agent `testeur` (sonnet), lecture seule          | Non-régression : suite complète sur la PR fusionnée localement avec `develop`, comparée à la baseline.                                                                              |

> Pourquoi le Chef de projet est-il la session principale ? Dans Claude Code, un subagent ne peut ni lancer d'autres subagents ni parler à l'utilisateur. L'orchestrateur doit donc être la session.

## Le workflow

```
0. Bootstrap     mode ? (économe par défaut) · normal : gh auth · repo (créé après accord) · labels · develop · .gepet-squad.json
1. Cadrage       Architecte ⇄ vous (questions) → proposition → ✅ VOTRE VALIDATION → ADR sur develop
2. Pitch         Architecte → Chef de projet
3. Roadmap       CP rédige → Architecte relit → ✅ VOTRE VALIDATION → milestones + issues GitHub
4. Livraison     Dev ×3 en parallèle → PR → Vérificateur → Testeur → merge squash sur develop
                 FAIL → correctif (retry:1..3) → 3 échecs → escalade à l'architecte, ou à vous
5. Release       milestone complet → PR release/mX → main (c'est vous qui mergez)
6. Bilan
```

Après vos deux validations, tout est autonome. En mode normal, GitHub est la source de vérité : labels `status:*`, milestones, rapports en commentaires de PR. En mode économe, c'est `docs/squad/` (voir ci-dessous).

## Mode économe (par défaut)

Avant tout démarrage, le Chef de projet demande : « Rester en mode économe ? » (oui par défaut). En mode économe, le projet ne consomme **rien** sur GitHub :

- pas de repo créé, ni labels, milestones, issues, PR ou commentaires ; pas de workflow GitHub Actions, pas de package, pas de push ;
- la roadmap reste `docs/roadmap.md` ; chaque feature devient une fiche `docs/squad/features/F-xx-<slug>.md`, les statuts vivent dans `docs/squad/etat.md`, et chaque rapport (livraison, vérification, tests, correctifs) est un fichier `docs/squad/rapports/F-xx/*.md` dont les agents se passent le chemin ;
- les branches `feature/*` et `release/*` sont locales ; le Chef de projet merge en squash sur `develop`, et vous mergez la branche `release/*` sur `main` vous-même ;
- les contrôles tournent en local (`ci.commands`, comme le mode « CI locale ») ;
- toujours un monorepo ; la vue 3D montre les agents mais pas les statuts des features.

Le garde-fou bloque, dans un projet économe, tout `git push` et toute commande `gh` qui écrit sur GitHub. Détail : `skills/gepet-squad/references/mode-econome.md`.

**Variante hybride.** Au démarrage, une seconde question propose le suivi **local** (ci-dessus, recommandé) ou **hybride** : repo, issues, labels et PR sur GitHub comme en mode normal, mais les rapports des agents restent des fichiers `docs/squad/rapports/<n°>/*.md` (aucun commentaire de PR ou d'issue, que le garde-fou bloque), sans CI GitHub Actions ni package. Le Chef de projet commite et pousse ces rapports après chaque merge.

## Tests et CI : juste assez

Dans les deux modes (`skills/gepet-squad/references/tests-et-ci.md`) :

- **Tests essentiels** : unitaires et intégration légère, 1 à 3 tests par critère, sans réseau ; toute la suite du repo tient en 3 minutes environ. Ce sont eux que lancent le développeur, le testeur et la CI.
- **Tests complexes** (e2e, vrais services, longs) : hors CI. Le **vérificateur** lance ceux qui concernent la feature et en rend compte dans son rapport.
- Le testeur lance d'abord la PR fusionnée avec `develop` ; il ne rejoue la baseline de `develop` que si quelque chose échoue.
- **CI à la release (mode normal, `ci.mode` = `release`)** : les features sont validées en local (`ci.commands` chez le développeur, puis chez le testeur, qui sert de barrière). GitHub Actions ne tourne qu'**une fois par milestone**, sur la PR `release/*` → `main` : un job ubuntu (install, lint, build, tests essentiels), annulation des runs dépassés, `timeout-minutes: 10`, aucun artefact de rapport. L'ancien comportement (CI sur chaque PR vers `develop`) reste disponible avec `ci.mode` = `github`.
- **Dépendances** : jamais de Dependabot ni de PR de mise à jour automatique. À chaque release, le Chef de projet lance l'audit des dépendances en local (`npm audit`, `pip-audit`…) : une faille haute ou critique devient une feature du milestone, à merger avant la release ; les autres sont listées dans le corps de release. Les alertes Dependabot (gratuites, sans PR) restent un réglage de votre repo.
- **Labels groupés** : une transition de statut est une seule commande `gh issue edit` (statut et `retry:*` ensemble), et la liste des issues n'est relue qu'au début d'un milestone et après un merge.
- **Packages (mode normal)** : aucun par défaut. Si vous les acceptez au cadrage, un workflow `release.yml` ne se déclenche qu'à la publication d'une release GitHub, après votre merge sur `main`.

## Consommation

La squad limite les tokens consommés sans réduire le contrôle :

- **Isolation** : chaque agent est lancé avec un contexte vierge, sans l'historique du Chef de projet, et un agent n'est jamais réutilisé d'un ticket à l'autre.
- **Input épuré** : une mission ne contient que des instructions et des références (n° d'issue ou de PR, branche, chemins). L'agent lit lui-même l'issue, le diff, les rapports et l'architecture au lieu de les recevoir collés.
- **Rapports Flash** : développeur, vérificateur et testeur répondent par un bloc de 5 lignes ; le détail reste dans un commentaire de PR (voir `report-formats.md`).
- **Cache de prompt** : les champs d'une mission vont du plus stable au plus variable, pour que le début du prompt soit identique d'un appel à l'autre et profite du cache de prompt d'Anthropic.
- **État externe** : le Chef de projet ne garde que des numéros et des verdicts. Il relit l'état sur GitHub et la feature concernée dans `docs/roadmap.md` (section ciblée, jamais le fichier entier), et la revue de roadmap par l'architecte se fait sur le chemin du fichier, pas sur son contenu collé.

### Voir ce que consomme la squad

La squad lit les transcripts de session de Claude Code et affiche les tokens bruts consommés : entrée, sortie, lecture de cache et écriture de cache, sans estimation en dollars. La commande, en lecture seule (ni réseau ni `gh`), se lance depuis le dossier du plugin :

```
node conso/cli.cjs [--project <dir>] [--milestone "<titre>=<id>,<id>…"]… [--focus "<titre>"] [--format texte|json]
```

`/gepet-squad-status` l'appelle pour vous (section « Consommation »), et le Chef de projet recopie le bilan du milestone livré dans le corps de release (ou la note de release en mode économe).

**Lire le tableau.** La sortie texte contient trois tableaux :

- **Milestone** : nombre d'agents, part du Chef de projet (CP) et les cinq compteurs (Entrée, Sortie, Cache lu, Cache écrit, Total).
- **Feature** (`#`) : nombre d'agents, tentatives (la plus haute connue, `-` si aucune) et les compteurs.
- **Poste** : le CP, les agents **hors feature**, la consommation **non attribuée** (transcripts qu'aucun événement du journal ne rattache) et le **Total**.

Un `Cache lu` élevé est bon signe : ces tokens sont relus à bas coût grâce au cache de prompt. `--format json` donne le même rapport pour un traitement automatique.

**Purge des transcripts.** Claude Code supprime les anciens transcripts selon le réglage `cleanupPeriodDays` de `settings.json` (30 jours par défaut). Passé ce délai, les chiffres d'un milestone ne sont plus recalculables : c'est pourquoi le bilan est recopié dans le corps de release, qui le conserve. Augmentez `cleanupPeriodDays` si vous voulez relire plus tard la consommation détaillée.

**Des chiffres propres à la machine.** Les transcripts vivent dans le dossier de configuration de Claude Code de la machine qui a lancé la squad. Un projet repris sur un autre poste, ou dont les transcripts ont été purgés, donne des chiffres partiels ou l'avertissement `TRANSCRIPTS_ABSENTS` : ils ne sont ni partagés ni synchronisés entre machines.

**Pour aller plus loin.** [`ccusage`](https://github.com/ryoppippi/ccusage) complète cet outil : il lit les mêmes transcripts pour une vue globale par jour, mois ou session, avec estimation des coûts, mais ne connaît ni les features ni les milestones de la squad.

## Commandes

| Commande                           | Rôle                                                                                                           |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `/gepet-squad "<besoin>"`        | Lance un nouveau projet depuis le dossier du projet (vide ou repo existant).                                    |
| `/gepet-squad-resume [consigne]` | Reprend un projet dans une nouvelle session, en reconstruisant l'état depuis GitHub.                           |
| `/gepet-squad-status`            | Affiche l'avancement (lecture seule).                                                                           |
| `/gepet-squad-viz [stop]`        | Ouvre la vue 3D temps réel du projet (démarre un serveur local et affiche l'URL), ou l'arrête avec `stop`. |

Si un autre plugin utilise le même nom, la forme préfixée `/gepet-squad:gepet-squad` fonctionne toujours (de même `/gepet-squad:gepet-squad-viz`).

## La vue 3D : `/gepet-squad-viz`

Une vue en lecture seule du workflow d'un projet squad, sous forme de **bureau 3D** : les zones de travail de la squad (décor en modèles glTF), un **kanban de post-its** où chaque feature apparaît dans la colonne de son statut, et de petits **bonhommes** qui travaillent. Le chef de projet est toujours à son bureau ; les autres agents entrent par la porte quand ils sont lancés et repartent quand ils ont fini.

```
/gepet-squad-viz          démarre le serveur local (ou réaffiche l'URL s'il tourne déjà) et affiche l'URL à ouvrir
/gepet-squad-viz stop     arrête le serveur du projet
```

- **Où la lancer** : dans le dossier d'un projet squad, ou dans un de ses sous-dossiers (la commande remonte jusqu'à `.gepet-squad.json`). Hors d'un projet squad, elle répond par un message et ne démarre rien.
- **Prérequis** : Node ≥ 22 (`node --version`), plus la CLI `gh` authentifiée, car l'état de référence vient de GitHub. Aucun `npm install` : le serveur n'utilise que les modules de Node, et Three.js est vendorisé (`viz/public/vendor/three/`, version 0.187.0).
- **Démarrage** : le serveur écoute après son premier instantané GitHub, ce qui peut prendre jusqu'à 15 s ; la commande attend donc l'URL (20 s au plus). Un second appel affiche la même URL sans lancer un second serveur.
- **Les bonhommes** : chaque agent suit un cycle scripté, calculé à partir des événements du journal et de l'état GitHub (rien n'est inventé).
  - Il **entre** par la porte et marche jusqu'à son poste (3 s au plus), **travaille** en tapant au clavier, montre une **bulle de verdict** de 4 s quand il rend son rapport, puis **repart** par la porte quand il a fini. S'il est repris (correctif, nouvelle tentative), il revient s'asseoir au même poste.
  - Le **chef de projet** reste assis à son bureau en permanence, sans taper ; il fait un geste à chaque changement de statut d'une feature, à chaque merge et à chaque release (au plus un par seconde).
  - Un agent sans signal depuis 45 min reste en place avec une bulle « ? ».
  - Avec `prefers-reduced-motion`, il n'y a pas de marche : l'agent apparaît directement à son poste (ou disparaît), les animations sont figées sur leur première image, seules les bulles et les dossiers `#N` changent.
  - Si un modèle 3D ne se charge pas, le bonhomme est remplacé par une **capsule** colorée selon son rôle.

  | Rôle | Zone et poste | Quand il est là |
  |---|---|---|
  | Chef de projet | Bureau du chef de projet, permanent | toujours |
  | Architecte | Salle de réunion (cadrage, debout) ou kanban (roadmap) | cadrage, revue de roadmap |
  | Développeur | Open space, un poste par développeur | implémentation ou correctif d'une feature |
  | Vérificateur | Bureau du vérificateur | revue de PR |
  | Testeur | Labo | tests de non-régression |
  | Tout agent d'une feature escaladée | Salle d'escalade | après épuisement des tentatives |

  Une zone à occupant unique offre 3 places (la squad lance des features en parallèle) : la première est assise, les deux autres debout.

  | État de l'agent | Geste du bonhomme |
  |---|---|
  | Lancé (`requested`, `running`) | marche jusqu'au poste, puis tape au clavier (debout, l'architecte au kanban reste immobile) |
  | Rapport rendu (`reported`) | bulle de verdict 4 s : pouce levé pour `PASS`, `LIVRÉ`, `APPROUVÉ`, geste de refus pour `FAIL`, `BLOQUÉ`, `À REVOIR`, mains jointes sinon, puis se rassied |
  | Terminé (`finished`) | retourne à la porte et disparaît |
  | Sans signal (`unknown`) | immobile avec une bulle « ? » |
  | Repris après la fin | revient s'asseoir au même poste |

- **Sans WebGL** (ou en ajoutant `?mode=texte` à l'URL), la page affiche une vue texte : les features par statut et les agents actifs.
- **Ce qui est capté** : le collecteur (voir « Garde-fou ») note dans un journal local le lancement et la fin des agents de la squad, l'issue et la PR concernées, le mode et le numéro de tentative, le verdict de leur rapport, et les changements de statut passés par `gh`. La page fusionne ce journal et l'état GitHub, qui fait foi.
- **Confidentialité du journal** : `<dossier-git-commun>/gepet-squad/events.jsonl`, une ligne JSON par événement, jamais commité, avec rotation à 5 Mo. Il ne contient ni prompt ni rapport complet : seulement des champs extraits (voir `CHANGELOG.md`, 0.2.0). Rien n'est écrit hors d'un projet squad.
- **Réseau** : le serveur n'écoute que sur `127.0.0.1` (port choisi automatiquement), n'accepte que des requêtes de lecture et n'envoie aucun en-tête CORS. La page ne charge rien depuis Internet.

- **Crédits** : le décor et les personnages vendorisés (`viz/public/vendor/kenney/`) viennent des packs « Furniture Kit » et « Mini Characters » de [Kenney](https://www.kenney.nl) (www.kenney.nl), sous licence CC0. Les licences sont conservées à côté des fichiers.

Le serveur interroge GitHub toutes les **3 minutes**, et seulement tant qu'une page est connectée. Un onglet resté plus d'une minute en arrière-plan ferme son flux ; à son retour, la page se reconnecte et le recalage manqué part aussitôt.

Limites connues : voir l'entrée 0.4.0 de `CHANGELOG.md`.

## Mode « CI locale »

Quand GitHub Actions n'est pas utilisable (quotas épuisés, CI désactivée), `.gepet-squad.json` peut porter la clé optionnelle `ci` :

```json
"ci": { "mode": "local", "commands": ["npm ci", "npm run lint", "npm test"] }
```

- `commands` est la liste ordonnée des contrôles, lancés à la racine du repo. Aucun agent ne crée, n'attend ni ne réactive de workflow GitHub Actions.
- Le **développeur** les exécute avant d'ouvrir sa PR ; le **testeur** les rejoue sur la PR fusionnée avec `develop` et sert de barrière à la place de la CI (une commande en échec donne `FAIL`, détail dans une section « CI locale » de son commentaire) ; le **chef de projet** les rejoue sur `develop` avant la PR de release.
- `"mode": "release"` (défaut du mode normal) : même validation locale des features, mais GitHub Actions tourne sur la PR de release vers `main`.
- Sans la clé, ou avec `"mode": "github"`, la CI GitHub Actions tourne sur chaque PR vers `develop`.

## Prérequis

- Claude Code récent
- [GitHub CLI](https://cli.github.com/) authentifiée (`gh auth login`), en mode normal seulement
- `git`, `bash` (Git Bash sous Windows) et `node` (pour les hooks ; **Node ≥ 22** pour `/gepet-squad-viz`)

## Installation (une fois, au niveau utilisateur : disponible dans toutes les sessions)

Dans Claude Code :

```
/plugin marketplace add gepet-io/gepet-squad
/plugin install gepet-squad@gepet-squad
```

Pour travailler sur le plugin lui-même, ajoutez plutôt la marketplace depuis votre clone : `/plugin marketplace add <chemin du clone>`.

## Mettre à jour après une modification

1. Augmentez `version` dans `.claude-plugin/plugin.json` et complétez `CHANGELOG.md`.
2. Commitez (et poussez si le repo est sur GitHub).
3. Dans Claude Code : `/plugin marketplace update gepet-squad`, puis redémarrez la session.

Pour tester une modification sans toucher la version installée :

```bash
claude --plugin-dir <chemin du clone>
```

## Personnalisation

| Quoi                                                          | Où                                                                   |
| ------------------------------------------------------------- | --------------------------------------------------------------------- |
| Nombre de devs en parallèle, nombre d'échecs avant escalade | `.gepet-squad.json` du projet (`maxParallelDevs`, `maxRetries`) |
| Modèle et effort d'un rôle                                  | frontmatter `model:` / `effort:` dans `agents/<role>.md`        |
| Format des features, des rapports et de la roadmap            | `skills/gepet-squad/references/`                                    |
| Règles du garde-fou                                          | `hooks/guard.cjs`                                                   |

## Garde-fou et collecteur

Deux hooks agissent dans un repo qui contient `.gepet-squad.json` ; ailleurs, ils n'ont aucun effet.

- **Garde-fou** (`hooks/guard.cjs`, bloquant) : il refuse pour Claude le push direct sur `main`, le force-push sur `develop`, le merge d'une PR vers `main` et tout `git merge` sur `main`. En mode économe, il refuse aussi tout `git push` et les commandes `gh` qui écrivent sur GitHub. Le merge des releases reste votre décision.
- **Collecteur d'événements** (`hooks/events.cjs`, asynchrone) : il alimente le journal local de la vue 3D. Étant déclaré en `async`, il ne ralentit pas la session, ne bloque aucune action, ne produit rien sur la sortie standard et trace ses éventuelles erreurs dans `collector.log` au lieu de les remonter. Ce qu'il écrit est décrit dans « La vue 3D ».

## Structure

```
.claude-plugin/   plugin.json, marketplace.json
agents/           architecte, developpeur, verificateur, testeur
skills/           gepet-squad (Chef de projet + references/), gepet-squad-resume, gepet-squad-status, gepet-squad-viz
scripts/          bootstrap.sh, vendor-three.sh, vendor-assets.sh
hooks/            hooks.json, guard.cjs (garde-fou), events.cjs (collecteur) et lib/
viz/              server.cjs (serveur local, CLI start / status / stop), lib/, public/ (page 3D, Three.js et assets Kenney vendorisés)
docs/             architecture (ARCHITECTURE.md, ADR) et roadmap
tests/            tests node:test (hooks, viz-server, viz-web, skills)
```

## Licence

[MIT](LICENSE). Les assets Kenney vendorisés sont sous CC0 et Three.js sous MIT : leurs licences sont à côté des fichiers, dans `viz/public/vendor/`.
