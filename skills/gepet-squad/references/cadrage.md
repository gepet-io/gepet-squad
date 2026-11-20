# Cadrage, pitch et roadmap (phases 1 à 3 du Chef de projet)

> Lu par le Chef de projet (`SKILL.md`) seulement tant que la roadmap n'est pas publiée : une fois les issues (ou `docs/squad/etat.md`) créées, ce fichier ne sert plus. Les règles d'or, l'économie de contexte et les modes restent ceux de `SKILL.md`.

## Phase 1 : Cadrage (Architecte ⇄ utilisateur)

1. Lance `architecte` avec :
   ```
   MODE: CADRAGE_QUESTIONS
   REFERENCES: <chemin absolu>
   REPO: <owner/repo>
   REPO_EXISTANT: oui|non
   GRAPHE: <chemin absolu de graphify-out, si à jour>
   SKILLS_DISPONIBLES: <noms + descriptions courtes des skills et plugins de cette session utiles au dev : front, design, tests, langages…>
   BESOIN: <$ARGUMENTS, mot pour mot>
   ```
2. Pose les `QUESTIONS` reçues à l'utilisateur avec **AskUserQuestion**, en reprenant le header, les options et l'option recommandée en premier. Deux tours au maximum : si l'architecte a encore des questions après le second tour, il fait des hypothèses et les écrit dans la proposition.
3. Lance `architecte` en `MODE: CADRAGE_PROPOSITION` avec le besoin et toutes les réponses. Continue le même agent avec SendMessage si possible, sinon fais une nouvelle mission complète.
4. Présente la `PROPOSITION` à l'utilisateur (le bloc tel quel, en Markdown lisible), puis demande-lui avec AskUserQuestion : **Valider l'architecture** / **Ajuster** (l'utilisateur précise via « Other »). En cas d'ajustement, renvoie le retour à l'architecte et recommence ce point.
   **✅ Point de validation utilisateur n°1. Ne continue jamais sans un « Valider » explicite.**
5. Lance `architecte` en `MODE: CADRAGE_FINALISATION`. Il écrit `docs/architecture/` et te renvoie le `PITCH`.
6. Mets à jour `.gepet-squad.json` (`layout`, `scopes` et leurs `path` ou `repo`, et `sensitivePaths` : la liste des chemins de la ligne `Zones sensibles` du PITCH, `[]` si « aucune »). En multi-repo (mode normal uniquement : un projet économe est toujours un monorepo), crée les sous-repos listés dans l'architecture validée (privés), puis lance le bootstrap sur chacun.
   **Packages** (mode normal uniquement) : demande avec AskUserQuestion « Publier des packages lors des releases ? » : **Non (Recommandé)** / **Oui**. Écris la réponse dans `"packages": { "enabled": false|true }` (`tests-et-ci.md`). Sans réponse explicite : non.
7. Commit sur `develop` (`docs(architecture): architecture et ADR initiaux`), puis push (mode normal uniquement).
8. **Graphify** (optionnel, voir `graphify.md`) : vérifie que `graphify` est disponible, propose l'installation sinon (AskUserQuestion, sans bloquer en cas de refus), puis construis le graphe initial, ajoute `graphify-out/` au `.gitignore` et écris `"graphify": { "enabled": true }` dans `.gepet-squad.json` (commit + push). Sur un repo existant qui contient déjà du code, fais-le dès la phase 0, avant le cadrage, pour que l'architecte puisse le consulter (`GRAPHE`).

## Phase 2 : Pitch

Garde le `PITCH` comme référence pour toute la suite : périmètre, ordre de construction, contraintes, commandes et skills.

## Phase 3 : Roadmap

1. Lis `feature-template.md` et `roadmap-template.md`. Rédige la roadmap complète (milestones, puis features `F-xx` au format complet), en partant du PITCH, **directement dans `docs/roadmap.md`** (brouillon non commité). Le **socle** vient en premier : init des sous-projets, outillage de tests (commandes « tests essentiels » et, s'il y en a, « tests complexes »), lint, build, CI : le socle définit toujours `ci.commands` dans `.gepet-squad.json` ; si `ci.mode` vaut `local` (toujours vrai en mode économe), aucun workflow GitHub Actions ; si `ci.mode` vaut `release`, le workflow minimal de `tests-et-ci.md` déclenché sur les PR vers `main` seulement ; plus `release.yml` seulement si `packages.enabled`.
   Pour chaque feature, la ligne de taille porte les mentions de la règle 8 de `feature-template.md` : `· voie légère` seulement si toutes ses conditions sont remplies (zones sensibles : `sensitivePaths`), `· outillé` si la feature recommande un skill Claude.
2. **Auto-contrôle** avant la revue : chaque feature respecte les règles 1 à 8 de `feature-template.md`. Découpe toute feature trop grosse. Corrige le fichier, pas ta mémoire.
3. Lance `architecte` avec cette mission, qui ne contient que le **chemin** du brouillon (il le lit lui-même) :
   ```
   MODE: REVUE_ROADMAP
   REFERENCES: <chemin absolu>
   REPO: <owner/repo>
   GRAPHE: <chemin absolu de graphify-out, si à jour>
   ROADMAP: <chemin absolu de docs/roadmap.md>
   ```

   Si le verdict est `À REVOIR`, corrige **chaque** point directement dans `docs/roadmap.md` et relance la même mission (le chemin ne change pas). Trois tours au maximum : au-delà, présente les désaccords restants à l'utilisateur.
4. Le brouillon approuvé est déjà dans `docs/roadmap.md`. Présente à l'utilisateur un résumé : le tableau des milestones, puis par milestone la liste `F-xx · titre · scope · taille · dépendances` (titre et scope via `grep -n "^### F-" docs/roadmap.md` ; taille et dépendances via `grep -n -A2 "^## Taille\|^## Dépendances" docs/roadmap.md`, sans relire les sections), avec le lien vers le fichier pour le détail. Demande-lui ensuite avec AskUserQuestion : **Valider la roadmap** / **Ajuster**.
   **✅ Point de validation utilisateur n°2. Ne publie rien sans un « Valider » explicite.**
5. **Publication** (voir `github-conventions.md`) :
   - crée les labels `scope:<x>` manquants et les milestones GitHub ;
   - crée les issues dans l'**ordre topologique** des dépendances, pour pouvoir réécrire les `F-xx` en `#n` ;
   - label `status:ready` si l'issue n'a pas de dépendance, `status:backlog` sinon, plus `type:*` et `scope:*` ;
   - ajoute dans `docs/roadmap.md` la section `## Correspondance F-xx → issues GitHub` (titre exact), avec une ligne de table `| F-xx | #n |` par feature, puis commit (`docs(roadmap): roadmap validée`) et push sur `develop`. À partir de là, `docs/roadmap.md` et GitHub sont ta mémoire externe (voir « Économie de contexte », volet « État externe »).
   - **Mode économe** : rien de tout cela sur GitHub. Écris une fiche `docs/squad/features/F-xx-<slug>.md` par feature et `docs/squad/etat.md` (milestones, puis une ligne par feature : `ready` sans dépendance, `backlog` sinon), au format de `mode-econome.md`. Pas de table de correspondance : les `F-xx` restent les identifiants. Commit `docs(roadmap): roadmap validée`, sans push. `etat.md` remplace alors `gh issue list` dans le volet « État externe » (`grep -n "^| F-" docs/squad/etat.md`).
6. À partir d'ici, tout est **autonome** jusqu'à la fin de la roadmap. Les seules exceptions sont l'escalade de type `DECISION_UTILISATEUR` et les cas imprévus de la règle d'or n°7.
