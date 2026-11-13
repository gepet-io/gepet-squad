# Faire évoluer gepet-squad

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
   - ajoutez `gepet-squad:devops` à la liste des agents ;
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

## Mettre à jour les assets 3D

Le décor et les personnages de la vue 3D sont des assets CC0 de [Kenney](https://www.kenney.nl) vendorisés dans `viz/public/vendor/kenney/`. Télécharge à la main les packs « Mini Characters » et « Furniture Kit » sur kenney.nl (le lien est signé : le script ne télécharge rien), puis lance :

```bash
bash scripts/vendor-assets.sh <zip-mini-characters> <zip-furniture-kit>
```

Le script extrait uniquement les fichiers listés, vérifie leur présence avant de toucher au dossier, puis le reconstruit et réécrit `SOURCE.md` (sha256 par fichier). Si tu changes la liste, mets aussi à jour `viz/public/js/assets.js` et `tests/viz-web/kenney-assets.test.mjs`.

## Lint et tests

L'outillage (ESLint, tests `node:test`) ne sert qu'au développement : le plugin n'a aucune dépendance npm à l'exécution.

```bash
npm ci            # installe ESLint (devDependencies uniquement)
npm run lint      # eslint .
npm test          # node --test : tests/**/*.test.{cjs,mjs}
bash -n scripts/bootstrap.sh
```

Les helpers de test sont dans `tests/helpers/` : repo git temporaire avec worktree (`createTempRepo`), faux `gh` placé en tête du `PATH` (`installFakeGh`, avec `gh.cmd` pour Windows) et client SSE (`openSse`). La CI GitHub Actions (`.github/workflows/ci.yml`) lance ces mêmes commandes sur ubuntu et windows.
