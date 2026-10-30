# 0004 — Capture du cycle de vie des agents, y compris en arrière-plan
Statut : Acceptée — Date : 2026-10-30

## Contexte

La vue doit montrer quel agent est actif, sur quelle feature et dans quel mode, puis sa fin et son verdict. En phase 4, le Chef de projet lance les agents **en arrière-plan** : depuis la session principale, un subagent démarre par défaut en arrière-plan. Dans ce cas :

- `PostToolUse` sur l'outil `Agent` se déclenche **au lancement**, avec `tool_response.status = "async_launched"`. Ce `tool_response` contient `agentId`, `description`, `prompt` et `outputFile`, mais **pas** le rapport ;
- le rapport final arrive dans la session principale par une **notification de fin**, qui n'est pas un appel d'outil ;
- pour un agent **synchrone**, `PostToolUse` sur `Agent` arrive à la fin, avec `status = "completed"`, `agentId` et `content`.

Ce que dit la documentation des hooks Claude Code (vérifiée le 2026-10-30) :
- `SubagentStart` reçoit `agent_id` et `agent_type`, plus les champs communs `session_id`, `cwd`, `transcript_path` et `hook_event_name`. Son matcher porte sur le type d'agent, avec un préfixe pour les plugins : `^claude-gepet-squad:…$` ;
- `SubagentStop` reçoit `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message` et `stop_hook_active`, plus les champs communs ;
- `agent_id` et `agent_type` font partie des champs communs : ils sont présents sur les hooks d'outils déclenchés **à l'intérieur** d'un subagent ;
- un subagent qui rend son rapport par **`SubagentHandback`** (c'est le cas des 4 agents de la squad) le place dans `tool_input.message` de cet outil. Dans ce cas, le `content` d'Agent ne contient plus qu'une courte note ;
- `PreToolUse` et `PostToolUse` sur `Agent` reçoivent `tool_use_id`. `tool_input` contient `prompt`, `description`, `subagent_type` et `model`.

Ce que la documentation ne précise pas :
- elle ne dit pas explicitement que `SubagentStart` et `SubagentStop` se déclenchent aussi pour les agents en arrière-plan. Elle les décrit sans exception (« when a subagent begins execution / completes ») ;
- elle ne garantit pas que `tool_response.agentId` (exemple `a4d2c8f1e0b3a297`) et `agent_id` (exemple `agent-abc123`) ont exactement le même format.

## Décision

Le collecteur combine **plusieurs signaux redondants**, chacun avec une priorité définie. Aucun ne suffit seul.

| # | Hook (matcher) | Événement | Rôle |
|---|---|---|---|
| 1 | `PreToolUse` (`Agent`), uniquement si `subagent_type` commence par `claude-gepet-squad:` | `agent.requested` `{toolUseId, agentType, mode, issue, pr}` | L'intention : le seul endroit où l'on voit le prompt, donc le `MODE`, l'`ISSUE` et la `PR` |
| 2 | `PostToolUse` (`Agent`) | `agent.launched` `{toolUseId, agentId}` si `async_launched` ; `agent.finished` `{toolUseId, agentId, source:"tool"}` si `completed` | Fait le lien entre `tool_use_id` et `agentId`. **C'est le repli de fin pour les agents synchrones.** |
| 3 | `SubagentStart` (`^claude-gepet-squad:`) | `agent.started` `{agentId, agentType}` | Confirme le démarrage effectif |
| 4 | `PreToolUse` (`SubagentHandback`), émis dans le subagent (`agent_id` présent) | `agent.reported` `{agentId, agentType, block, verdict}` | Verdict précis, tiré de l'en-tête du bloc et de la ligne `Verdict:` ou `Statut:` de `tool_input.message` |
| 5 | `SubagentStop` (`^claude-gepet-squad:`) | `agent.finished` `{agentId, agentType, source:"stop"}`, avec le verdict extrait de `last_assistant_message` en repli de 4 | **C'est la source principale de fin d'agent, en arrière-plan comme en synchrone.** |
| 6 | `PostToolUse` (`Bash`) : `gh issue edit … status:*`, `gh pr merge`, `gh issue close`, `gh pr create` | `feature.status`, `pr.merged`, `issue.closed`, `pr.opened` | Ce sont les transitions que le CP fait **après chaque rapport** : elles font foi pour l'état des features et clôturent implicitement l'agent rattaché à l'issue |
| 7 | Recalage GitHub toutes les 60 s (serveur) | `snapshot` | Corrige toute dérive (événement manqué, syntaxe `gh` imprévue) |

**Corrélation** (dans le réducteur, ADR 0003) :
- l'agent visuel a pour clé `toolUseId` tant qu'on n'a pas l'`agentId`, puis `agentId` à partir de `agent.launched` ou `agent.finished` (signal 2) ;
- les identifiants sont normalisés en retirant le préfixe `agent-` éventuel. Si aucune correspondance n'est trouvée, on associe au plus ancien agent `requested` ou `launched` du même `agentType` qui n'a pas encore d'`agentId` (file FIFO) ;
- on attache au plus un agent actif `developpeur`, `verificateur` ou `testeur` par issue. Un `feature.status` qui fait sortir l'issue de la station de l'agent marque cet agent `finished` (signal 6), s'il ne l'est pas déjà ;
- `agent.finished` est idempotent : le premier signal de fin reçu gagne, les suivants ne font qu'ajouter un verdict s'il manquait ;
- **pas de fin inventée** : un agent sans aucun signal depuis 45 min passe en phase `unknown` (rendu atténué), sans être déclaré terminé. Le prochain instantané GitHub tranche.

**Configuration des hooks** : toutes les entrées du collecteur sont `"async": true` et appellent `node "${CLAUDE_PLUGIN_ROOT}/hooks/events.cjs"`. Le nom de l'événement est lu dans `hook_event_name`. Le matcher `Agent` accepte aussi `Task`, l'ancien nom de l'outil, par précaution : `"Agent|Task"`.

**Validation préalable obligatoire** (feature socle du scope `hooks`) :
1. capturer les payloads réels avec `claude --debug-file` pendant un cycle complet, dans un projet jetable : un agent synchrone, puis un agent en arrière-plan ;
2. confirmer que `SubagentStart`, `SubagentStop` et `SubagentHandback` sont bien émis pour les agents en arrière-plan ;
3. confirmer le format de `agentId` et de `agent_id` ;
4. anonymiser les payloads et les commiter dans `tests/fixtures/hooks/`.

Si `SubagentStop` ne se déclenche pas en arrière-plan, la fin est captée par les signaux 4 et 6, et le collecteur reste valide. Le constat est consigné dans un ADR complémentaire.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| `PostToolUse` sur `Agent` seul | Simple | Faux en arrière-plan : il marque la fin dès le lancement |
| `SubagentStop` seul | Couvre l'arrière-plan | Pas de `MODE`, d'`ISSUE` ni de `PR` (le prompt n'est pas dans son payload), et son déclenchement en arrière-plan n'est pas explicitement documenté |
| Commandes `gh` du CP seules | Font foi | On ne voit pas l'agent pendant son travail, et elles dépendent de la syntaxe utilisée par le CP |
| Faire écrire le CP dans le journal (instruction dans `SKILL.md`) | Contrôle total | Couple l'orchestrateur à la visualisation, consomme des tokens et n'est pas fiable (oubli possible du modèle) |
| Lire `outputFile` ou les transcripts des agents | Contenu complet | Format interne non contractuel, lecture lourde, et cela va contre la minimisation (ADR 0003) |
| Notification `agent_completed` | Signal de fin explicite | Documentée comme émise seulement quand la vue des agents est ouverte dans un terminal : pas fiable |

## Conséquences

- La vue montre un agent en arrière-plan de son lancement à sa fin. Au pire, si un signal manque, sa fin est corrigée au prochain recalage GitHub (60 s au plus).
- Le collecteur s'appuie sur 5 événements de hooks. Chaque type de payload doit avoir une fixture **réelle** et des tests unitaires, et les tests d'intégration rejouent un cycle complet (synchrone et arrière-plan) sur le réducteur.
- Le parsing des commandes `gh` reprend la logique de découpage de `guard.cjs` (`&&`, `||`, `;`, retours à la ligne) et couvre les formes documentées dans `github-conventions.md`. Toute nouvelle forme utilisée par le CP doit être ajoutée aux fixtures.
- Si Claude Code fait évoluer ces payloads (nom d'outil, champs), seul `hooks/lib/normalize.cjs` est à adapter.
