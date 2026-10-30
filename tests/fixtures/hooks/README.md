# Fixtures de payloads de hooks

Ces fichiers sont les JSON que Claude Code envoie sur le stdin des hooks. Ils alimentent `tests/hooks/normalize.test.cjs`. Le champ `_provenance` est ignoré par `normalize()` ; il sert uniquement à tracer l'origine.

## Provenance

**Aucune fixture n'est une capture réelle.** La capture avec `claude --plugin-dir . --debug-file <f>` était impossible dans l'environnement du développeur : la CLI imbriquée répond `Failed to authenticate: OAuth session expired and could not be refreshed`. Conformément à l'issue #2, chaque fixture est donc tirée de la documentation officielle (`"_provenance": "doc:<URL>"`), avec des valeurs anonymisées et un prompt ou un rapport rédigé selon les formats de `skills/gepet-squad/references/`.

| Fichier | Hook | Provenance | État |
|---|---|---|---|
| `pre-tool-use-agent.json` | `PreToolUse` `Agent` (développeur, `MODE`, `ISSUE`) | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `pre-tool-use-agent-verificateur.json` | `PreToolUse` `Agent` (vérificateur, `ISSUE`, `PR`, `TENTATIVE`, sans `MODE`) | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `post-tool-use-agent-async-launched.json` | `PostToolUse` `Agent`, `status: "async_launched"` | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `post-tool-use-agent-completed.json` | `PostToolUse` `Agent`, `status: "completed"` | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `subagent-start.json` | `SubagentStart` (`agent_id` avec préfixe `agent-`, comme l'exemple de la doc) | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `subagent-stop.json` | `SubagentStop` (`agent_id` sans préfixe, comme l'exemple de la doc) | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |
| `pre-tool-use-subagent-handback.json` | `PreToolUse` `SubagentHandback`, dans le subagent | doc:https://code.claude.com/docs/en/hooks | non confirmé par capture |

Les marqueurs `SECRET_*_MARKER` placés dans les prompts, messages et contenus servent aux tests de minimisation : aucun d'eux ne doit se retrouver dans un événement.

## Points ouverts de l'ADR 0004

| Point | État |
|---|---|
| `SubagentStart` et `SubagentStop` se déclenchent-ils pour un agent lancé **en arrière-plan** ? | **non confirmé.** La documentation les décrit sans exception, mais ne le dit pas explicitement. Aucune capture n'a pu être faite. |
| Format de l'identifiant : `agentId` (`tool_response`) contre `agent_id` (`SubagentStart`, `SubagentStop`, `SubagentHandback`) | **non confirmé.** Les exemples de la doc se contredisent : `a4d2c8f1e0b3a297` (sans préfixe) pour `agentId`, `agent-abc123` pour `SubagentStart` et `def456` pour `SubagentStop`. Le nom de fichier du transcript est `agent-def456.jsonl`. `normalizeAgentId` retire donc le préfixe `agent-` éventuel, ce qui couvre les deux formes. |

## Refaire une capture réelle

Dans un projet jetable (`git init`, un `.gepet-squad.json`), avec une session authentifiée :

1. déclarer dans `.claude/settings.json` des hooks `PreToolUse` et `PostToolUse` (matcher `Agent|SubagentHandback`), `SubagentStart` et `SubagentStop` qui copient leur stdin dans un fichier (`cat > "capture-$(date +%s%N).json"`) ;
2. lancer `claude --plugin-dir <repo du plugin> --debug-file capture.log`, puis demander un agent `claude-gepet-squad:*` en synchrone, puis un autre en arrière-plan ;
3. anonymiser (chemins, identifiants de session, logins), ajouter `"_provenance": "capture:claude <version>, <date>"`, remplacer le fichier correspondant et passer l'état à « confirmé par capture » dans ce tableau ;
4. relancer `npm test` : si `SubagentStop` n'est pas émis en arrière-plan, le constater dans la PR pour que le chef de projet ouvre l'ADR complémentaire.
