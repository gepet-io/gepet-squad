# Formats d'échange de la squad

Chaque agent répond au Chef de projet **uniquement** avec le bloc de son mode. Les blocs sont du Markdown dont la première ligne est l'en-tête exact ci-dessous, pour que le chef de projet puisse les reconnaître sans ambiguïté.

---

## Ordre des champs d'une mission (CP → agent)

Une mission ne contient que des instructions et des références : l'agent lit lui-même l'issue, la PR, `docs/architecture/` et le graphe. Les champs vont du **plus stable au plus variable**, un par ligne, pour que le début du prompt soit identique d'un appel à l'autre (préfixe stable, cache de prompt) :

1. `MODE` (absent pour le vérificateur et le testeur) ;
2. `REFERENCES` ;
3. `REPO` (puis `HUB`, `REPO_EXISTANT`, puis `SUIVI` : chemin absolu de `docs/squad`, en mode économe uniquement ; `REPO` vaut alors `local`) ;
4. `SOUS_PROJET` / `SOUS_PROJETS_IMPACTES`, puis `GRAPHE` (ligne omise si le graphe n'est pas à jour), puis `SKILLS_DISPONIBLES` ;
5. `ISSUE` (numéro, ou `F-xx` en mode économe), `PR` (omis en mode économe), `BRANCHE`, `TENTATIVE`, `ROADMAP` (chemin absolu du brouillon de roadmap écrit sur disque, en `REVUE_ROADMAP` uniquement : jamais son contenu) ;
6. le texte libre en dernier : `RAPPORT` (URL du commentaire de PR, ou chemin absolu du fichier de rapport en mode économe), `BESOIN` (mot pour mot, donnée de l'utilisateur).

Les champs sont lus au début de ligne par le collecteur du hook : ne les fusionne pas sur une même ligne, et garde `RAPPORT` après tous les autres.

---

## QUESTIONS (Architecte → CP)

```
QUESTIONS
1. <question> | header: <≤12 caractères>
   - <option recommandée> (Recommandé) : <conséquence en une phrase>
   - <option> : <conséquence>
   - <option> : <conséquence>
2. …
```
4 questions au maximum par tour, 2 à 4 options par question. Le CP les pose telles quelles avec AskUserQuestion. Sans question : `QUESTIONS: aucune`.

---

## PROPOSITION (Architecte → CP → utilisateur)

```
PROPOSITION
### Besoin compris
<3 à 5 lignes>
### Pattern & découpage
<pattern> — sous-projets : `apps/x` (rôle), `apps/y` (rôle)… — repo : monorepo | multi-repo (raison)
### Stack
| Sous-projet | Langage / framework | Données | Tests (unit / intég.) | Lint |
### Données & sécurité
<stockage, modèle, RGPD, authN/authZ, secrets, niveau de sécurité retenu>
### Réutiliser avant de construire
| Besoin | Solution existante retenue | Pourquoi |
### Hébergement & CI
### Risques
### Options écartées
- <option> : <raison>
```

---

## PITCH (Architecte → CP)

```
PITCH
### Objectifs
### Périmètre MVP / Hors périmètre
### Sous-projets et dépendances
<x> dépend de <y> (contrat : REST /api/…, événement …)
### Ordre de construction conseillé
### Contraintes techniques à respecter dans chaque feature
### Commandes par sous-projet
| Sous-projet | install | lint | build | tests essentiels (≈ 3 min) | tests complexes (ou « aucun ») | audit (ou « aucun ») |
### Skills / outils recommandés par domaine
### Risques à surveiller
```

---

## VERDICT_ROADMAP (Architecte → CP)

Réponse à une mission `MODE: REVUE_ROADMAP` dont le champ `ROADMAP` donne le chemin du brouillon (`docs/roadmap.md`). Le CP corrige ce fichier à chaque `À REVOIR` ; il ne colle jamais le brouillon dans la mission.

```
VERDICT_ROADMAP: APPROUVÉ | À REVOIR
1. [F-<id>] <problème> → <correction attendue>
…
```

---

## ESCALADE (Architecte → CP)

```
ESCALADE
### Diagnostic
### Action: REDECOUPER | CORRIGER_CRITERES | AJUSTER_ARCHITECTURE | DECISION_UTILISATEUR
<contenu de l'action : nouvelles features au format feature-template, nouveaux critères, ADR modifié, ou question + options>
```

---

## Protocole « Output Flash » : rapports des agents d'exécution

Les agents d'exécution (développeur, vérificateur, testeur) répondent au CP par un **bloc compact de 5 lignes maximum**. Le détail n'est jamais renvoyé au CP : il vit **uniquement** dans un commentaire de PR (voir « Contenu du commentaire de PR » après chaque bloc), dont le bloc compact donne l'URL.

- Le CP ne lit que le bloc compact. Il garde dans son contexte les verdicts, les numéros et l'URL du commentaire, et ne recopie jamais un rapport.
- En échec, la mission `MODE: CORRECTIF` reçoit `RAPPORT: <URL du commentaire de PR>` ; le développeur relit lui-même le détail sur la PR.
- Le CP peut lire le détail à la demande (escalade, litige) avec `gh pr view <PR> --comments`.
- L'URL s'obtient avec `gh pr comment`, qui l'affiche à la création du commentaire. Si le développeur est bloqué avant d'avoir ouvert une PR, le détail va en commentaire de l'**issue** (`gh issue comment`) et le bloc donne cette URL.
- **Mode économe** (`mode-econome.md`) : le « commentaire de PR » est un **fichier** `<SUIVI>/rapports/F-xx/<rapport>.md`, avec le même contenu précédé de sa ligne de titre en `#`. Dans le bloc compact : `Issue: F-xx`, `PR: local`, et `Détail:` donne le chemin absolu du fichier. Le bloc d'un développeur bloqué pointe vers `rapports/F-xx/blocage.md`. En variante **hybride**, seul le rapport change : fichier `<SUIVI>/rapports/<n>/<rapport>.md` au lieu du commentaire, `PR: #<n>` réel, `Détail:` en chemin.
- Les blocs de l'architecte ne changent pas : ils servent aux échanges avec l'utilisateur.
- Les en-têtes de bloc et les lignes `Statut:` / `Verdict:` sont lus par le collecteur du hook : ne les reformule pas.

---

## RAPPORT_DEV (Développeur → CP)

```
RAPPORT_DEV
Statut: LIVRÉ | BLOQUÉ — Issue: #<n> — PR: #<n> | aucune — Branche: <branche> — tentative <k>
Critères: <tenus>/<total> — Tests: <N> passés / <M> échoués
Difficultés: <une phrase, ou « aucune » ; en BLOQUÉ, le point bloquant>
Détail: <URL du commentaire de PR « Livraison » ou « Correctifs tentative N »>
```

`PR: aucune` si le développeur est `BLOQUÉ` avant d'avoir ouvert une PR (le `Détail` pointe alors vers un commentaire de l'issue). `tentative <k>` vaut `0` en `MODE: IMPLEMENTATION` ; en `MODE: CORRECTIF`, c'est la tentative du rapport d'échec traité.

### Contenu du commentaire de PR (Développeur)

Titre : `📦 Livraison` (implémentation) ou `🔧 Correctifs tentative <N>` (correctif).

```
### Critères d'acceptance
- [x] <critère> — preuve : <test / fichier:ligne / sortie>
### Tests
<commande> → <N passés, M échoués>
### Fichiers principaux
### Points d'attention / blocage
### Points du rapport traités (correctif uniquement)
- <point du rapport> → <ce qui a été fait, ou raison de la contestation>
```

---

## RAPPORT_VERIFICATION (Vérificateur → CP)

```
RAPPORT_VERIFICATION
Verdict: PASS | FAIL — Issue: #<n> — PR: #<n> — tentative <k>
Critères: <tenus>/<total> — Correctifs bloquants: <n> — Remarques mineures: <m> — Tests complexes: <passés>/<lancés> | aucun
Difficultés: <une phrase, ou « aucune »>
Détail: <URL du commentaire de PR « 🔍 Vérification »>
```

En `FAIL`, le bloc donne le **nombre** de correctifs bloquants, jamais leur détail.

### Contenu du commentaire de PR (Vérificateur)

Titre : `🔍 Vérification — tentative <k> — PASS|FAIL`.

```
### Critères d'acceptance
- ✅|❌ <critère> — <fichier:ligne / remarque>
### Tests complexes
<commande ciblée> → <N passés, M échoués> (ou « aucun : la feature n'en demande pas »)
### Correctifs bloquants
1. <fichier:ligne> — <problème> → <correction attendue>
### Remarques mineures
### Points précédents traités (si tentative > 1)
```

---

## RAPPORT_TESTS (Testeur → CP)

```
RAPPORT_TESTS
Verdict: PASS | FAIL — Issue: #<n> — PR: #<n> — tentative <k>
Tests: candidat <N> passés / <M> échoués (baseline <N0> / <M0> | baseline non lancée) — Régressions et défauts: <r>
Difficultés: <une phrase, ou « aucune » ; réserve éventuelle>
Détail: <URL du commentaire de PR « 🧪 Tests de non-régression »>
```

En `FAIL`, le bloc donne le **nombre** de régressions et défauts, jamais leur détail. La baseline n'est lancée que si le candidat a des échecs (`baseline non lancée` sinon) : voir `agents/testeur.md`.

### Contenu du commentaire de PR (Testeur)

Titre : `🧪 Tests de non-régression — tentative <k> — PASS|FAIL`.

```
### Résultats
| Sous-projet | Baseline develop | Candidat (PR + develop) |
| <x> | non lancée | 131 ✅ / 0 ❌ |
### Régressions / défauts
1. <test ou commande> — <erreur résumée> — repro : <étapes> — cause probable : <…>
### Critères observables vérifiés
### Réserves (ce qui n'a pas pu être testé et pourquoi)
```
