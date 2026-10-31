# 0008 — Reprise d'un agent : cycle de vie non monotone
Statut : Acceptée — Date : 2026-10-31 — Complète l'ADR 0004

## Contexte

La capture réelle de fin de M1 a été faite le 2026-10-30 : `claude --plugin-dir` sur le plugin de `develop`, dans un projet jetable, avec deux architectes lancés en `CADRAGE_QUESTIONS`. Le journal produit compte 14 événements, et aucun `collector.log` n'a été créé.

Elle confirme les hypothèses de l'ADR 0004 (voir sa section « Constats de la capture réelle »). Elle révèle aussi un cas que l'ADR 0004 ne prévoyait pas : **la reprise d'un agent par `SendMessage`**. Le Chef de projet l'utilise en permanence : il relance l'architecte avec les réponses de l'utilisateur, ou transmet un message pendant qu'un agent travaille.

Séquence observée pour un même `agentId` (`a152ecd0174a7c035`), sans aucun nouvel `agent.requested` ni `agent.launched` (`SendMessage` n'est pas un appel de l'outil `Agent`) :

| Heure | Événement | Lecture |
|---|---|---|
| 14:13:03 | `agent.requested` (`CADRAGE_QUESTIONS`) | lancement |
| 14:13:04 | `agent.started` | — |
| 14:13:04 | `agent.launched` (`async_launched`) | arrive **après** `started` |
| 14:13:33 | `agent.reported` `QUESTIONS` | — |
| 14:13:36 | `agent.finished` (`stop`) | fin du 1er cycle |
| 14:14:22 | `agent.started` | **reprise** par `SendMessage` |
| 14:15:36 | `agent.finished` (`stop`) | fin d'un tour **sans** rapport |
| 14:16:05 | `agent.reported` `PROPOSITION` | **sans** nouveau `started` |
| 14:16:08 | `agent.finished` (`stop`) | fin du 2e cycle |

Trois constats :
- un même `agentId` peut avoir **plusieurs cycles** (début → fin) ;
- `SubagentStop` marque la fin d'un **tour** du subagent, pas la fin définitive de l'agent ;
- un tour peut reprendre sans `SubagentStart`. Il s'agit probablement d'un message transmis pendant le travail de l'agent, qui relance un tour : l'événement `reported` de 14:16:05 arrive sans `started` préalable.

Avec la règle de l'ADR 0004 (« `agent.finished` est idempotent, le premier signal de fin gagne »), le réducteur de `develop` (09472a5) laisse l'agent `finished` avec `block: QUESTIONS` dès 14:13:36. La reprise et le rapport `PROPOSITION` sont ignorés : **la vue ne montrerait jamais un agent repris.**

## Décision

Le cycle de vie d'un agent devient **non monotone**. On le modélise comme une suite de cycles, propre à chaque `agentId`, et on applique les événements `agent.*` **dans l'ordre de leur `ts`**. À `ts` égal, on garde l'ordre du journal. Les hooks étant `async`, l'ordre d'écriture n'est pas garanti.

1. **Réactivation.** Un `agent.started`, `agent.launched` ou `agent.reported` dont le `ts` est **strictement postérieur** au `finishedAt` d'un agent `finished` du même `agentId` ouvre un nouveau cycle :
   - `finishedAt` est effacé (`null`) ;
   - après un `started` ou un `launched`, `phase` passe à `running`, et `block` et `verdict` sont remis à `null` pour ne pas afficher le verdict du cycle précédent ;
   - après un `reported`, `phase` passe à `reported`, avec le `block` et le `verdict` du rapport.
2. **Clôture.** Un `agent.finished` reçu alors que l'agent n'est pas `finished` clôt le cycle en cours : `phase` passe à `finished` et `finishedAt` prend son `ts`. Le signal 6 de l'ADR 0004, c'est-à-dire un `feature.status` qui fait sortir l'issue de la station de l'agent, clôt aussi le cycle en cours.
3. **Idempotence limitée au cycle.** Un `agent.finished` reçu alors que l'agent est déjà `finished`, sans réactivation entre les deux, ne change ni `phase` ni `finishedAt` : il complète seulement `block` ou `verdict` s'ils manquent. Un `agent.reported` dont le `ts` est antérieur ou égal à `finishedAt` (écriture tardive du cycle clos) ne réactive rien : il ne fait lui aussi que compléter `block` ou `verdict` s'ils manquent.
4. **Mode et station d'un architecte repris.** `SendMessage` ne transporte pas de `MODE` lisible par les hooks. On déduit donc le mode du `block` du rapport, ce qui donne aussi sa station :

   | `block` | `mode` | station |
   |---|---|---|
   | `QUESTIONS` | `CADRAGE_QUESTIONS` | `cadrage` |
   | `PROPOSITION` | `CADRAGE_PROPOSITION` | `cadrage` |
   | `PITCH` | `CADRAGE_FINALISATION` | `cadrage` |
   | `VERDICT_ROADMAP` | `REVUE_ROADMAP` | `roadmap` |
   | `ESCALADE` | `ESCALADE` | `escalade` |

   Les blocs `RAPPORT_*` ne changent ni le mode ni la station des autres agents.
5. **Champs inchangés.**
   - `id` et `since` restent ceux du **premier** cycle, et `id` reste la clé de rendu stable ;
   - `updatedAt` est le dernier signal, tous cycles confondus ;
   - la règle `unknown` (45 min sans signal) et la purge (agents `finished` depuis moins de 10 min) s'appliquent au **dernier** cycle.
6. **Contrat `/state` inchangé.** Il n'y a aucun nouveau champ. `viz-web` détecte une reprise par la transition `finished` → `running` ou `reported` d'un même `id`, renvoyée par `state.js` comme toute autre transition.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Garder la règle de l'ADR 0004 (le premier signal de fin gagne) | Aucun changement | Les agents repris sont invisibles, alors que c'est le mode de travail courant du CP |
| Un nouvel agent visuel par cycle (`id` = `agentId#n`) | Chaque cycle est isolé | L'entité lumineuse disparaît et réapparaît pour un même agent, `id` n'est plus stable, et `agents[]` gonfle |
| Ignorer `SubagentStop` et ne clore que par le rapport (`agent.reported`) ou le signal 6 | Plus de fin fictive au milieu d'une reprise | Un agent sans rapport (erreur d'API, interruption) ne finit jamais avant 45 min, et on perd la source de fin principale validée par la capture |
| Retarder l'effet de `SubagentStop` (délai de grâce de 60 s) | Masque les fins de tour intermédiaires | Introduit une horloge dans un réducteur rejoué, et la règle 1 corrige déjà l'état dès le signal suivant |
| Ajouter des hooks côté CP (`PreToolUse` sur `SendMessage`) | Signal explicite de reprise, avec le `MODE` | Il faut capturer et valider un payload de plus. À reconsidérer si la déduction par `block` (règle 4) se révèle insuffisante. |

## Conséquences

- **Réducteur** (`viz/lib/reducer.cjs`, scope `viz-server`) : à corriger dans une feature dédiée, avec les règles 1 à 5. Ses tests rejouent la séquence capturée ci-dessus, en fixture réelle, et doivent finir sur `phase: finished`, `block: PROPOSITION`, `mode: CADRAGE_PROPOSITION`, une réactivation à 14:14:22 et une autre à 14:16:05. On ajoute un cas de désordre d'écriture (`launched` avant ou après `started`, même `ts` ou presque) et un cas de `reported` tardif antérieur à `finishedAt`.
- **Fixture** : le journal de la capture (14 lignes) est versionné dans `tests/fixtures/journal/capture-reprise.jsonl`. Il ne contient ni prompt ni rapport (minimisation, ADR 0003).
- **Limite acceptée** : entre une fin de tour intermédiaire et le signal suivant (environ 30 s dans la capture, de 14:15:36 à 14:16:05), l'agent est affiché `finished` alors qu'il travaille encore. L'état se corrige au signal suivant, et la purge à 10 min laisse l'entité visible pendant ce temps.
- **`viz-web`** (#9) : aucun changement de contrat. `state.js` doit seulement accepter qu'un agent `finished` redevienne `running` ou `reported`, et renvoyer cette transition comme les autres.
