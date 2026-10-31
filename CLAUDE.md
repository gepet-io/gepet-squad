# gepet-squad : notes pour les sessions qui font évoluer ce plugin

Ce repo **est** un plugin Claude Code, et aussi sa propre marketplace (`.claude-plugin/marketplace.json`, `source: "./"`). Il ne contient pas d'application : seulement des prompts (agents, skills), un script bash et un hook node.

## Architecture du plugin

- `skills/gepet-squad/SKILL.md` est le **Chef de projet** : l'orchestrateur, exécuté dans la session principale. Il est la seule pièce qui lance des agents et parle à l'utilisateur, parce que les subagents ne peuvent ni lancer d'autres subagents ni poser de questions.
- `agents/*.md` sont les rôles. Chacun reçoit une mission en `CHAMP: valeur` (MODE, REPO, ISSUE, PR, BRANCHE, REFERENCES…) et répond **uniquement** avec un bloc défini dans `skills/gepet-squad/references/report-formats.md`.
- `report-formats.md` est le **contrat** entre l'orchestrateur et les agents. Si tu modifies un bloc, mets à jour à la fois l'agent qui le produit et la section du SKILL qui le lit.
- Les agents reçoivent le chemin absolu des références dans `REFERENCES`. On n'utilise pas `${CLAUDE_PLUGIN_ROOT}` dans les agents, parce qu'il n'y est pas garanti. Dans les skills, `${CLAUDE_SKILL_DIR}` et `${CLAUDE_PLUGIN_ROOT}` sont disponibles.
- L'état d'un projet vit sur GitHub (labels `status:*`, `retry:*`, milestones, commentaires de PR) et dans `.gepet-squad.json`. Tout nouvel état doit pouvoir être reconstruit par `gepet-squad-resume`.

## Conventions

- Tout est rédigé en **français** : prompts, rapports, docs.
- Subagent : `subagent_type` = `gepet-squad:<name>`. Noms de fichiers en kebab-case, sans accent.
- Outils des agents : au minimum nécessaire. Le vérificateur et le testeur n'ont ni `Edit` ni `Write`.
- Chaque changement de comportement : bump de `version` (semver) dans `.claude-plugin/plugin.json` et une entrée dans `CHANGELOG.md`.

## Vérifier un changement

```bash
claude plugin validate .
echo '{"tool_name":"Bash","tool_input":{"command":"git push origin main"},"cwd":"<repo avec .gepet-squad.json>"}' | node hooks/guard.cjs
bash -n scripts/bootstrap.sh
```

Pour un test de bout en bout : `claude --plugin-dir .` dans un dossier vide, puis `/gepet-squad "API REST todo-list en Node + petite page web"` sur un repo GitHub jetable.
