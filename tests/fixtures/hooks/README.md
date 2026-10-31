# Fixtures de payloads de hooks

Ces fichiers sont les JSON que Claude Code envoie sur le stdin des hooks. Ils alimentent `tests/hooks/normalize.test.cjs`. Le champ `_provenance` vaut strictement `doc:<URL>` ou `capture:<version>` ; un éventuel commentaire (anonymisation, choix de valeurs) va dans `_note`. Ces deux champs sont ignorés par `normalize()` ; ils servent uniquement à tracer l'origine.

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
| `SubagentStart` et `SubagentStop` se déclenchent-ils pour un agent lancé **en arrière-plan** ? | **confirmé par capture (2026-10-30)** : oui, les cinq signaux arrivent pour un agent en arrière-plan (voir l'ADR 0004, « Constats de la capture réelle »). |
| Format de l'identifiant : `agentId` (`tool_response`) contre `agent_id` (`SubagentStart`, `SubagentStop`, `SubagentHandback`) | **confirmé par capture (2026-10-30)** : les deux identifiants coïncident après normalisation (`a152ecd0174a7c035`, voir l'ADR 0004). Les exemples de la doc se contredisent (`a4d2c8f1e0b3a297`, `agent-abc123`, `def456`), d'où le maintien de `normalizeAgentId`, qui retire le préfixe `agent-` éventuel et couvre les deux formes. |

La capture a produit un journal d'événements normalisés, versionné dans `tests/fixtures/journal/capture-reprise.jsonl` (14 lignes, rejouées par `tests/viz-server/reducer.test.cjs`). Le debug log ne contenant pas les payloads bruts, elle ne remplace aucune fixture de ce dossier : les fixtures `doc:` ci-dessus sont conservées, avec leur colonne « non confirmé par capture » (payloads bruts non capturés).

## Refaire une capture réelle

Dans un projet jetable (`git init`, un `.gepet-squad.json`), avec une session authentifiée :

1. déclarer dans `.claude/settings.json` des hooks `PreToolUse` et `PostToolUse` (matcher `Agent|SubagentHandback`), `SubagentStart` et `SubagentStop` qui copient leur stdin dans un fichier (`cat > "capture-$(date +%s%N).json"`) ;
2. lancer `claude --plugin-dir <repo du plugin> --debug-file capture.log`, puis demander un agent `claude-gepet-squad:*` en synchrone, puis un autre en arrière-plan ;
3. anonymiser (chemins, identifiants de session, logins), ajouter `"_provenance": "capture:claude <version>, <date>"`, remplacer le fichier correspondant et passer l'état à « confirmé par capture » dans ce tableau ;
4. relancer `npm test` : si `SubagentStop` n'est pas émis en arrière-plan, le constater dans la PR pour que le chef de projet ouvre l'ADR complémentaire.
