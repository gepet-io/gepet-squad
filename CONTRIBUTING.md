# Faire évoluer claude-gepet-squad

## Ajouter un rôle (sub-agent)

Exemple : un agent `devops` qui met en place la CI/CD et le déploiement.

1. Créez `agents/devops.md` :
   ```markdown
   ---
   name: devops
   description: <quand le Chef de projet doit le lancer, en une phrase>
   model: sonnet
   effort: medium
   color: cyan
   tools: Read, Glob, Grep, Write, Edit, Bash
   ---
   Tu es le **DevOps** d'une squad IT. Tu réponds au Chef de projet…
   ## Mission reçue
   (les champs : MODE, REPO, REFERENCES…)
   ## Méthode
   ## Rapport final
   Réponds uniquement avec le bloc `RAPPORT_DEVOPS` de report-formats.md.
   ```
2. Ajoutez le bloc `RAPPORT_DEVOPS` dans `skills/gepet-squad/references/report-formats.md`.
3. Dans `skills/gepet-squad/SKILL.md` :
   - ajoutez `claude-gepet-squad:devops` à la liste des agents ;
   - décrivez **quand** le lancer (quelle phase ou quel statut), **quelle mission** lui passer et **que faire** de chaque verdict.
4. Si le rôle introduit un nouveau statut, ajoutez le label dans `scripts/bootstrap.sh` et `references/github-conventions.md`, et le cas de reprise dans `skills/gepet-squad-resume/SKILL.md`.
5. Mettez le tableau « La squad » du README à jour.

Règle de conception : un agent **ne parle pas à l'utilisateur** et **ne lance pas d'autres agents**. S'il a besoin d'une décision, il la renvoie au Chef de projet dans son rapport.

## Ajouter une commande

Créez `skills/<nom>/SKILL.md` avec un frontmatter `name`, `description` et éventuellement `argument-hint` et `disable-model-invocation: true` (pour une commande qui ne doit se déclencher que si on la tape). La commande est ensuite disponible sous `/<nom>`.

## Publier une version

1. `version` dans `.claude-plugin/plugin.json` (semver : correctif = patch, nouveau rôle ou nouvelle commande = minor, changement du contrat des rapports ou des labels = major).
2. Une entrée dans `CHANGELOG.md`.
3. `claude plugin validate .`
4. Commit, puis push.
5. Sur chaque machine : `/plugin marketplace update claude-gepet-squad`, puis redémarrer Claude Code.
