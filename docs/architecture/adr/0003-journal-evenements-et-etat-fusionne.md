# 0003 — Journal d'événements local et état fusionné avec GitHub
Statut : Acceptée — Date : 2026-10-30

## Contexte

L'état de référence d'un projet squad vit sur GitHub : labels `status:*` et `retry:*`, milestones, PR et commentaires de rapports. Il est rafraîchi trop lentement pour du temps réel, et il ne dit pas quel agent travaille en ce moment. Les hooks voient tout, instantanément, mais seulement pendant la session courante.

Les agents tournent dans des worktrees (`isolation: "worktree"`), et donc dans des `cwd` différents de celui de la session principale.

## Décision

**Journal** :
- Emplacement : `<git-common-dir>/gepet-squad/events.jsonl`, résolu par `git rev-parse --git-common-dir` depuis le `cwd` du hook. Il est commun au repo principal et à tous ses worktrees. Il n'est jamais commité et n'oblige pas à modifier le `.gitignore`.
- Le collecteur n'écrit **que** si un `.gepet-squad.json` est trouvé en remontant depuis le `cwd`, avec la même logique que `findConfig` dans `guard.cjs`.
- Format JSONL, une ligne par événement. On ajoute avec `fs.appendFileSync`, en une seule écriture de moins de 4 Ko.
- Rotation à 5 Mo vers `events.1.jsonl`, un seul fichier conservé. Le serveur relit `events.1.jsonl` puis `events.jsonl` au démarrage.

**Schéma d'événement v1** (`hooks/lib/schema.cjs`, lu par `viz-server`) :
`{ v: 1, ts, src: "hook", type, sessionId?, toolUseId?, agentId?, agentType?, mode?, issue?, pr?, attempt?, retry?, status?, verdict?, block?, source?, label?, ref? }`.

La liste des champs obligatoires et optionnels de chaque type est donnée dans `ARCHITECTURE.md`, § 6 (« Champs par type »).

`validate()` contrôle seulement la version, le type, les champs connus et la taille. Les champs obligatoires par type sont garantis par les producteurs et vérifiés par leurs tests. Le réducteur ignore, sans exception, un événement auquel il manque un champ obligatoire.

Valeurs possibles de `verdict` :
- `PASS` et `FAIL` (vérification, tests) ;
- `LIVRÉ` et `BLOQUÉ` (développeur) ;
- `APPROUVÉ` et `À REVOIR` (revue de roadmap).

`block` est optionnel sur `agent.reported` : il est absent si le rapport ne commence pas par un en-tête de bloc connu.

- `attempt` : la valeur de `TENTATIVE:` extraite du prompt (`agent.requested`). Ne pas confondre avec `retry`.
- `retry` : un entier ≥ 1, le K du label `retry:K` de l'issue. Porté uniquement par `feature.retry`. Ajouté pendant la PR de `gh-command.cjs` : c'est un champ optionnel et rétrocompatible, donc sans changement de version de schéma.
- `ref` : toujours une chaîne, dont le sens dépend du type :
  - pour `pr.opened` et `release.opened`, la branche de tête ;
  - pour `issue.created`, le titre du milestone ;
  - pour `milestone.changed`, le numéro du milestone (`"3"`).

  Le numéro d'une PR ou d'une issue créée n'est connu qu'en sortie de commande, alors que le hook ne voit que la commande : `ref` porte donc l'identifiant disponible à ce moment-là. Le réducteur l'interprète selon le type, et le recalage GitHub fournit ensuite le numéro réel.
- `label` : réservé, aucun type ne le produit en v1.
- `block` : l'en-tête du bloc de rapport (`RAPPORT_DEV`, `RAPPORT_VERIFICATION`…), sur `agent.reported`, ou sur `agent.finished` en repli.
- `source` : uniquement sur `agent.finished`. Vaut `tool` (`PostToolUse` sur `Agent`, `completed`) ou `stop` (`SubagentStop`).
- `toolUseId` désigne uniquement l'appel de l'outil `Agent`. `agent.reported` n'en porte pas : il provient de l'appel `SubagentHandback` dans le subagent, et il est corrélé par `agentId`.

Les types possibles :
- `agent.requested`, `agent.launched`, `agent.started`, `agent.reported`, `agent.finished` (voir l'ADR 0004) ;
- `feature.status`, `feature.retry`, `issue.created`, `issue.closed` ;
- `pr.opened`, `pr.merged` ;
- `milestone.changed`, `release.opened`.

Un type inconnu est ignoré par le serveur, ce qui permet d'ajouter des types sans casser les versions précédentes.

**Minimisation** : ni prompt ni rapport complet. On ne garde que des champs extraits :
- dans le prompt, `MODE:`, `ISSUE:`, `PR:` et `TENTATIVE:` ;
- dans le rapport, la première ligne du bloc et la ligne `Verdict:` ou `Statut:`.

**Instantané GitHub** (`viz/lib/github.cjs`), pris au démarrage puis **toutes les 60 s**, par `execFile('gh', [...])`. On reprend les commandes de `gepet-squad-status` :
- `gh api repos/<REPO>/milestones?state=all` ;
- `gh issue list --state all --limit 500 --json number,title,state,labels,milestone` ;
- `gh pr list --state all --limit 200 --json number,headRefName,baseRefName,state,title`.

`<REPO>` est lu dans `.gepet-squad.json`.

Implémentation (`viz/lib/github.cjs`, dont l'en-tête fait foi) :
- le module lit aussi `isDraft` et `mergedAt` des PR ;
- il renvoie `{repo, fetchedAt, issues[], milestones[], pulls[]}`, avec des états en minuscules ;
- dans `issues[]`, `status` et `retry` sont déduits des labels ;
- les PR fermées sans merge sont écartées ;
- en cas d'erreur, il renvoie une `GhError` de code `GH_REPO`, `GH_CONFIG`, `GH_MISSING`, `GH_AUTH`, `GH_TIMEOUT` ou `GH_PARSE`, avec un `message` affichable et un `detail` réservé au stderr du serveur.

La forme complète est décrite dans `ARCHITECTURE.md`, § 6. Il reste une limite assumée au MVP : en layout `multirepo`, seules les PR du repo hub sont lues, et les features sont placées d'après les labels des issues du hub.

**État fusionné**, calculé par un réducteur pur (`viz/lib/reducer.cjs`) :
- `features` est initialisé par l'instantané, et les événements `feature.*`, `pr.*` et `issue.*` postérieurs à l'instantané le mettent à jour ;
- à chaque nouvel instantané, **GitHub fait foi** pour le statut, le retry et l'état ouvert ou fermé ;
- `agents` provient uniquement du journal (cycle décrit dans l'ADR 0004). On ne garde que les agents de la session la plus récente et ceux terminés depuis moins de 10 minutes ;
- la station de chaque feature découle de son statut (table de correspondance dans `ARCHITECTURE.md`, § 6).

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| GitHub seul, en polling | Une seule source | On ne voit pas les agents au travail, il y a 15 à 60 s de retard, et cela consomme du quota d'API |
| Journal seul | Instantané | Vide après une reprise (`/gepet-squad-resume`), pas d'état de fond |
| Journal dans `<projet>/.gepet-squad/` | Facile à trouver | Il faut un `.gitignore`, et chaque worktree a sa propre copie |
| Journal dans `${CLAUDE_PLUGIN_DATA}` | Survit aux mises à jour | Pas garanti côté skill et serveur, il faut l'indexer par projet, et ce dossier est partagé entre tous les projets |
| SQLite (`node:sqlite`) | Requêtes | Inutile pour un flux qu'on ne fait qu'ajouter et lire, et le module est encore marqué expérimental selon les versions de Node |

## Conséquences

- La vue se reconstruit entièrement depuis GitHub, ce qui est cohérent avec `gepet-squad-resume`. Le journal n'est qu'un accélérateur.
- Le collecteur appelle `git` une fois par événement. C'est acceptable parce qu'il est `async` et ne bloque pas la session.
- Toute évolution du schéma se fait par incrément de `v` et un nouvel ADR. Le serveur doit accepter les versions `v ≤` la sienne.
