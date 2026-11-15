# Tests et CI : juste assez

Valable dans les deux modes. But : une PR se valide en quelques minutes, pas en un quart d'heure. La CI vérifie les grandes lignes ; le vérificateur s'assure des tests complexes.

## Deux niveaux de tests

| Niveau | Contenu | Qui le lance | Budget |
|---|---|---|---|
| **Essentiels** | Tests unitaires du comportement attendu (cas nominal et principal cas d'erreur de chaque critère) et tests d'intégration légers (BDD en mémoire ou conteneur déjà prévu, faux serveur HTTP, fichiers temporaires). Déterministes, sans réseau ni service externe. | développeur (avant livraison), testeur (non-régression), CI (mode normal), CP (avant release, en CI locale) | **≈ 3 min au total** pour tout le repo, installation comprise |
| **Complexes** | e2e et navigateur, vrais services, charge, matrices multi-OS ou multi-versions, tests de plus de quelques secondes. | **vérificateur**, seulement ceux qui concernent la feature revue | hors CI |

- L'architecture donne **une commande par niveau et par sous-projet** (`ARCHITECTURE.md`, section Commandes : colonnes « tests essentiels » et « tests complexes »). Un sous-projet sans tests complexes l'écrit (« aucun »).
- La commande des tests essentiels est celle de la CI et de `ci.commands`. Un test lent, instable ou qui touche le réseau n'a pas sa place dans les essentiels : il passe en complexe.

## Sobriété des tests (règle des features et de la revue)

- 1 à 3 tests par critère fonctionnel : le cas nominal et le cas d'erreur qui compte. Pas de combinatoire exhaustive.
- Un test d'intégration par frontière d'I/O réellement touchée (API, BDD, fichier, file de messages), pas un par variante.
- On ne teste pas une bibliothèque ni un framework, un getter, une constante ou un code généré. Pas de snapshot géant, pas de doublon unitaire / intégration du même comportement.
- Un test doit toujours échouer si le comportement casse : pas d'assertion vide, de `skip` ni de `only`, pas de mock de la chose testée.
- Tests complexes : seulement si un critère l'exige explicitement (parcours utilisateur critique, contrat entre sous-projets). Jamais par défaut.

## Où tournent les contrôles : `ci.mode`

| `ci.mode` | Features (PR vers `develop`) | Release (PR `release/*` → `main`) | Usage |
|---|---|---|---|
| `release` | `ci.commands` en local : développeur avant livraison, testeur comme barrière | GitHub Actions, **une fois par milestone** | **défaut du mode normal** |
| `local` | `ci.commands` en local | `ci.commands` en local, par le CP | mode économe, ou GitHub Actions indisponible |
| `github` | GitHub Actions sur chaque PR | GitHub Actions | ancien comportement, sur demande explicite seulement |

Dans tous les cas, le CP rejoue `ci.commands` sur `develop` avant d'ouvrir la release : la CI de release ne doit pas découvrir un échec que la squad pouvait voir.

## CI GitHub Actions (mode normal uniquement)

En mode économe ou avec `ci.mode` = `local` : **aucun workflow**. Sinon, un seul workflow, `.github/workflows/ci.yml`, qui ne fait que :

1. installer les dépendances (avec le cache de l'action `setup-*`) ;
2. lint ;
3. build (le projet se construit) ;
4. tests essentiels.

Règles :

- déclenchement **uniquement** sur `pull_request` vers `main` avec `ci.mode` = `release` (la PR `release/*` du milestone), ou vers `develop` avec `ci.mode` = `github` ; jamais sur `push` ; `paths-ignore` sur la documentation ;
- `concurrency` avec `cancel-in-progress: true` : un nouveau commit annule le run en cours ;
- un seul job, `ubuntu-latest`, **pas de matrice** sauf si un ADR l'impose (plusieurs OS ou versions réellement supportés) ;
- `timeout-minutes: 10` ;
- **interdits** : `actions/upload-artifact` (rapports de tests, couverture, logs, builds), tests complexes, packaging, déploiement, `schedule`, services lourds.

Le rapport de tests n'est jamais un artefact de CI : c'est le commentaire de PR du testeur et du vérificateur (ou leur fichier Markdown en mode économe).

```yaml
name: CI
on:
  pull_request:
    branches: [main]          # ci.mode = release ; [develop] seulement si ci.mode = github
    paths-ignore: ["docs/**", "**/*.md"]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
permissions:
  contents: read
jobs:
  essentiels:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4        # adapter au langage (setup-python, setup-go…)
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npm run lint
      - run: npm run build
      - run: npm run test:essentiels
```

## Dépendances : audit local à la release, pas de Dependabot

Valable dans tous les modes. Les mises à jour de dépendances ne passent jamais par des PR automatiques, qui déclenchent chacune la CI.

- **Aucun `.github/dependabot.yml`** : ni le socle ni un développeur n'en crée. La squad n'active pas non plus les « Dependabot security updates » (PR automatiques) ; les **alertes** Dependabot, gratuites et sans PR, restent un réglage du repo que l'utilisateur gère lui-même.
- **Une commande d'audit par sous-projet**, donnée par l'architecture (colonne « audit » de la section Commandes) : par exemple `npm audit --omit=dev --audit-level=high`, `pip-audit`, `cargo audit`, `govulncheck ./...`, `dotnet list package --vulnerable`. « aucun » si l'écosystème n'a pas d'outil.
- **Le CP la lance à chaque release**, sur `develop` à jour, juste après `ci.commands` :
  - faille **haute ou critique** : crée une feature `type:tech` dans le milestone courant (`[<scope>] Mettre à jour <paquet> (<identifiant de la faille>)`, critères : version corrigée installée, tests essentiels au vert), prête tout de suite. Elle suit le circuit normal (développeur, vérificateur, testeur) ; la release attend son merge ;
  - faille **modérée ou basse** : ne bloque pas ; liste-la dans la ligne « Audit des dépendances » du corps de release, pour que l'utilisateur décide ;
  - outil absent ou registre injoignable : note-le sur la même ligne, sans bloquer.
- L'audit interroge le registre de paquets, jamais GitHub : il ne consomme rien sur GitHub, dans aucun mode.

## Packages (mode normal uniquement)

- Par défaut : **aucun package**, aucune publication, aucun artefact. `.gepet-squad.json` porte `"packages": { "enabled": false }`.
- Le CP demande au cadrage si l'utilisateur veut des packages (réponse par défaut : non). Seulement en cas d'accord : `"packages": { "enabled": true }`, et le socle ajoute un second workflow `.github/workflows/release.yml`, déclenché **uniquement** par `release: types: [published]`, qui construit et publie le package. Jamais sur une PR ni sur un push.
- La release GitHub n'est publiée que par l'utilisateur, après le merge de la PR `release/*` sur `main` : le CP lui donne la commande (`gh release create v<x.y.z> --target main --generate-notes`).
- Mode économe : jamais de package.
