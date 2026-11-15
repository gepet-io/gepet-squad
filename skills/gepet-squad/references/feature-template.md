# Modèle de feature (corps d'une issue GitHub, ou d'une fiche `docs/squad/features/F-xx-<slug>.md` en mode économe)

Titre de l'issue : `[<scope>] <verbe à l'infinitif> <résultat>`, par exemple `[stock-api] Exposer la réservation de stock d'un produit`.

```markdown
## Contexte
<Pourquoi cette feature existe, toujours relié au besoin métier : qui en a besoin, quel problème elle résout, où elle s'insère dans le parcours ou le système. 2 à 6 lignes.>

## Objectif
<Une phrase : le résultat vérifiable attendu.>

## Critères d'acceptance
- [ ] <Comportement fonctionnel observable, formulé de manière testable : « Étant donné… quand… alors… » si utile>
- [ ] <Cas d'erreur / limite attendu>
- [ ] Tests unitaires : <les comportements essentiels couverts : nominal et cas d'erreur qui compte>
- [ ] Tests d'intégration : <la frontière d'I/O couverte : contrat d'API, accès BDD, appel inter-services>
- [ ] (optionnel) Tests complexes : <parcours critique e2e ou vrai service, et pourquoi il le faut> — lancés par le vérificateur, hors CI
- [ ] Lint, build et tests essentiels du sous-projet au vert

## Notes techniques
- Sous-projet : `apps/<x>`
- ADR de référence : `docs/architecture/adr/000N-…`
- Fichiers / modules concernés : <…>
- Contraintes : <issues du PITCH>

## Skills / outils recommandés
- <skill Claude ou outil réel, et pourquoi>

## Dépendances
- <#n ou F-xx : feature qui doit être mergée avant>, ou « aucune »

## Taille
S | M
```

## Règles (vérifiées par le CP avant publication et par l'architecte en revue)

1. **Contexte** et **Critères d'acceptance** sont obligatoires et non vides.
2. Il y a toujours un critère « Tests unitaires ». Il y a aussi un critère « Tests d'intégration » dès que la feature touche une I/O, une API, une BDD, un fichier, une file de messages ou un autre service. La ligne « Lint, build et tests essentiels au vert » est toujours présente.
3. Chaque critère est vérifiable par un test ou une commande. Les formulations floues sont interdites : « performant », « propre », « bien géré ».
4. **Découpage obligatoire** quand la feature est de taille L, qu'elle a plus d'environ 7 critères fonctionnels, qu'elle touche plus d'un sous-projet, qu'elle orchestre plusieurs services, qu'elle porte une sécurité à plusieurs niveaux (ex. authN + RBAC + chiffrement), ou qu'elle mélange socle technique et fonctionnalité.
5. Un sous-projet par feature (un seul label `scope:*`). Les contrats entre sous-projets (schéma d'API, événements) sont des features à part, réalisées avant leurs consommateurs.
6. Le premier milestone commence par le **socle** : initialisation des sous-projets, outillage de tests (commandes « tests essentiels » et « tests complexes »), lint, build, CI et fichier `.gepet-squad.json`. Si `ci.mode` vaut `local` (toujours le cas en mode économe), le socle ne crée **pas** de workflow GitHub Actions : il définit à la place `ci.commands` dans `.gepet-squad.json` (installation, lint, build, tests essentiels). Sinon, il définit aussi `ci.commands`, crée le workflow minimal de `tests-et-ci.md` (déclenché sur les PR vers `main` si `ci.mode` vaut `release`), et `release.yml` seulement si `packages.enabled` vaut `true`.
7. **Tests sobres** (`tests-et-ci.md`) : les critères de tests demandent l'essentiel (1 à 3 tests par critère fonctionnel, un test d'intégration par frontière d'I/O), jamais une couverture exhaustive. Un critère « Tests complexes » n'apparaît que pour un parcours critique qui le justifie.
