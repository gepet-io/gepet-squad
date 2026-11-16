# 0013 — Contrat de lecture des transcripts Claude Code et attribution de la consommation
Statut : Acceptée — Date : 2026-11-16 — Précise le § 8 de l'ARCHITECTURE : la ligne « Collecte d'événements » y écarte les transcripts **pour les événements** ; cet ADR les retient **pour l'usage seulement**.

## Contexte

Le sous-projet `conso` ([ADR 0012](0012-sous-projet-conso-cli-sans-dependance.md)) a besoin du détail des tokens pour chaque appel au modèle, côté CP comme côté agents. Claude Code n'expose ce détail que dans ses transcripts JSONL locaux. Les hooks n'en donnent qu'un total partiel : `tool_response.totalTokens` du `PostToolUse` `Agent`, sans le cache, absent pour un agent d'arrière-plan tant qu'il n'a pas fini, et muet sur le CP.

Les transcripts ne sont **pas un format documenté**. L'[ADR 0004](0004-capture-cycle-de-vie-des-agents.md) les avait écartés pour capter le cycle de vie des agents, parce que les hooks sont le point d'extension officiel. Ici, ils sont la seule source. Il faut donc un contrat de lecture minimal, tolérant et testé sur des extraits réels.

Ce contrat repose sur des constats faits le 2026-11-16, sur des sessions squad réelles (Claude Code récent, avec des agents en arrière-plan et en worktree) :
- session principale : `<config>/projects/<slug>/<sessionId>.jsonl`, avec une ligne JSON par entrée ;
- agents : `<config>/projects/<slug>/<sessionId>/subagents/agent-<agentId>.jsonl`, plus `agent-<agentId>.meta.json` (`agentType`, `toolUseId`, `description`…). C'est le cas **même quand l'agent travaille dans un worktree** : son transcript est rangé sous la session parente ;
- chaque réponse du modèle est une ligne `type: "assistant"`, avec `timestamp`, `sessionId`, `message.id`, `message.model` et `message.usage` (`input_tokens`, `output_tokens`, `cache_read_input_tokens`, `cache_creation_input_tokens`). **Une même réponse s'étale sur plusieurs lignes** (une par bloc de contenu), qui portent le même `message.id` et répètent `usage` ;
- la première ligne d'un `agent-*.jsonl` est la mission (`type: "user"`), qui commence par l'en-tête `MODE: …`, `ISSUE: …`, `PR: …`, `TENTATIVE: …` ;
- le journal `events.jsonl` porte le `sessionId` de la session **parente** (y compris pour les événements émis dans un agent), l'`agentId` (nom du fichier `agent-<agentId>.jsonl`), et un `toolUseId` identique à celui de `.meta.json`.

## Décision

1. **Localisation.**
   - Le dossier de configuration est `CLAUDE_CONFIG_DIR` s'il est défini, sinon `~/.claude`.
   - Les sessions du projet sont les `sessionId` distincts du journal (`events.jsonl` et `events.1.jsonl`). Pour chacune, on cherche `<config>/projects/*/<sessionId>.jsonl` : on parcourt les dossiers de `projects/` sans recalculer le slug, ce qui résiste aux worktrees et aux caractères spéciaux.
   - Les transcripts d'agents sont les `<sessionId>/subagents/agent-*.jsonl` de ces sessions.
   - **Repli sans journal** : on prend les sessions du dossier `projects/<slug>` du projet, slug = chemin absolu de la racine dont chaque caractère non alphanumérique devient `-`. On ne garde que les sessions dont au moins un `.meta.json` a un `agentType` en `gepet-squad:` ou `claude-gepet-squad:`.
2. **Champs lus, et rien d'autre.**
   - **Lignes d'usage** : on ne parse que les lignes qui contiennent `"usage"`. On en garde `type`, `timestamp`, `message.id`, `message.model` et `message.usage.{input_tokens, output_tokens, cache_read_input_tokens, cache_creation_input_tokens}`.
   - **`.meta.json`** : `agentType` et `toolUseId`.
   - **Première ligne d'un agent** : uniquement l'en-tête de mission (`MODE`, `ISSUE`, `PR`, `TENTATIVE`), avec les mêmes règles que `hooks/lib/normalize.cjs` (champ en début de ligne, première occurrence, arrêt aux notes libres), à une différence près : `ISSUE` accepte aussi l'identifiant `F-<n>` du mode économe local (point 10). Ces expressions vivent dans `conso/lib/attribution.cjs` : `normalize.cjs` n'est pas modifié.
   - Aucun autre contenu (texte, outils, code, prompts) n'est conservé ni affiché.
3. **Comptage.**
   - On déduplique par `message.id`, au sein d'un fichier, en gardant la **dernière** occurrence.
   - Une ligne sans `message.id`, au modèle `<synthetic>`, ou dont tous les compteurs valent 0, est ignorée.
   - Un compteur absent vaut 0.
   - `total` = entrée + sortie + cache lu + cache écrit, et `messages` = nombre de réponses distinctes.
4. **Attribution d'un agent**, par ordre de priorité :
   1. `toolUseId` de `.meta.json` → `agent.requested` du journal, qui donne `mode`, `issue`, `pr` et `attempt` ;
   2. sinon `agentId` → événements `agent.*` du journal, qui donnent `agentType` et `mode` ;
   3. sinon l'en-tête de la mission (première ligne du transcript).

   `role` est l'`agentType` sans préfixe. Un agent sans `issue` (architecte en cadrage ou en revue de roadmap) va en `horsFeature`. Un fichier sans `agentType` de la squad n'est **pas compté** : c'est un agent d'un autre plugin ou un agent intégré. Un fichier de la squad sans aucune attribution va en `nonAttribue`.
5. **Attribution du CP.** Les lignes de la session principale (hors `subagents/`) sont rattachées au milestone de la **dernière feature dont un agent a été demandé** avant leur `timestamp`. La feature d'un `agent.requested` est son `issue`, ou à défaut celle de l'agent rattaché par `toolUseId` (point 4), ce qui couvre le mode économe local (point 10). Avant le premier de ces événements, elles vont dans le groupe « Cadrage ». Ce découpage est déterministe et sans recouvrement. Le CP n'est **pas** ventilé par feature : son travail entre deux lancements concerne souvent plusieurs features.
6. **Schéma du journal v1 inchangé.** `sessionId`, `toolUseId`, `agentId`, `mode`, `issue`, `pr` et `attempt` suffisent à l'attribution. On n'ajoute aucun champ d'usage ni de chemin de transcript, et ni le collecteur ni `viz-server` ne changent.
7. **Tolérance.**
   - Une ligne illisible, un fichier absent ou un champ d'un type inattendu ne fait jamais échouer la CLI : on l'ignore et on le compte dans `warnings` (`LIGNES_ILLISIBLES`, `AGENTS_NON_ATTRIBUES`, `TRANSCRIPTS_ABSENTS`).
   - La lecture se fait en flux (`node:readline`), fichier par fichier : la mémoire reste bornée même avec une session CP de plusieurs dizaines de Mo.
   - Les anciennes versions de Claude Code, qui rangeaient les agents dans le fichier principal (`isSidechain: true`), ne sont pas prises en charge. Ces lignes sont ignorées (ni CP, ni agent) et signalées par l'avertissement `FORMAT_ANCIEN`.
8. **Sécurité et confidentialité.**
   - Lecture seule, sans réseau, sans `gh` et sans écriture.
   - La sortie ne contient que des numéros d'issue et de PR, des rôles, des modes, des modèles, des dates et des nombres.
   - Les fixtures de test sont des extraits réels **anonymisés** : contenu remplacé, identifiants réécrits, chemins neutralisés.
9. **Purge.** Claude Code supprime les transcripts plus vieux que `cleanupPeriodDays` (30 jours par défaut). La CLI ne voit donc que les sessions encore présentes. C'est le bilan recopié dans le corps de release (ADR 0012, point 6) qui fait foi pour un milestone ancien. Le README le dit.
10. **Identifiant de feature en mode économe local** (complément du 2026-11-16, revue de la roadmap M7). En économe local, une mission porte `ISSUE: F-xx` ([mode-econome.md](../../../skills/gepet-squad/references/mode-econome.md)). `normalize.cjs` n'en extrait pas d'entier : le journal n'a donc **aucun `issue`** pour ces agents. Sans règle, tous iraient en `horsFeature` et tout le CP en « Cadrage ».
    - L'identifiant d'une feature est un entier (numéro d'issue, modes normal et hybride) **ou** une chaîne `F-<n>` (économe local), recopiée telle quelle (`F-07`).
    - Quand l'événement du journal attribué à un agent n'a pas d'`issue`, on la prend dans l'en-tête de mission de son transcript (point 2), même si l'agent est attribué par `toolUseId`. Les autres champs (`mode`, `pr`, `attempt`) suivent la même règle de complément.
    - Le schéma v1 du journal reste inchangé, ainsi que `normalize.cjs` et `viz-server`.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Usage capté par les hooks (`tool_response.totalTokens`) | Point d'extension officiel | Total seul, sans détail du cache ; absent en arrière-plan avant la fin ; CP invisible |
| Schéma de journal v2 avec des champs d'usage ou le chemin du transcript | Attribution sans parcourir `projects/` | Double stockage ; collecteur plus lourd ; changement de contrat pour `viz-server` ; limite de 4 Ko par ligne ; et l'usage resterait lu dans les transcripts |
| Recalculer le slug du projet seulement | Simple | Fragile : worktrees, caractères spéciaux, sessions lancées depuis un sous-dossier |
| Attribuer le CP à chaque feature au prorata | Ligne par feature plus complète | Répartition arbitraire, donc des chiffres trompeurs |
| Statusline ou `/usage` intégré | Officiels | Ni accès programmatique par feature, ni historique par milestone |

## Conséquences

- Le format des transcripts peut changer avec Claude Code. Les fixtures réelles de `tests/fixtures/transcripts/` documentent le format supporté. En cas de casse, les chiffres tombent en `nonAttribue` ou en `warnings` au lieu de planter, et un correctif ne touche que `conso/lib/transcripts.cjs` et `sources.cjs`.
- Les contrats existants (schéma v1, `/state`, journal) restent inchangés.
- Les chiffres d'un projet ne sont visibles que sur la machine qui a fait tourner la squad.
- Le CP n'a pas de ligne par feature : seulement un total et une répartition par milestone.
