# Formats d'échange de la squad

Chaque agent répond au Chef de projet **uniquement** avec le bloc de son mode. Les blocs sont du Markdown dont la première ligne est l'en-tête exact ci-dessous, pour que le chef de projet puisse les reconnaître sans ambiguïté.

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
| Sous-projet | install | lint | build | test (tout) |
### Skills / outils recommandés par domaine
### Risques à surveiller
```

---

## VERDICT_ROADMAP (Architecte → CP)

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
Critères: <tenus>/<total> — Correctifs bloquants: <n> — Remarques mineures: <m>
Difficultés: <une phrase, ou « aucune »>
Détail: <URL du commentaire de PR « 🔍 Vérification »>
```

En `FAIL`, le bloc donne le **nombre** de correctifs bloquants, jamais leur détail.

### Contenu du commentaire de PR (Vérificateur)

Titre : `🔍 Vérification — tentative <k> — PASS|FAIL`.

```
### Critères d'acceptance
- ✅|❌ <critère> — <fichier:ligne / remarque>
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
Tests: candidat <N> passés / <M> échoués (baseline <N0> / <M0>) — Régressions et défauts: <r>
Difficultés: <une phrase, ou « aucune » ; réserve éventuelle>
Détail: <URL du commentaire de PR « 🧪 Tests de non-régression »>
```

En `FAIL`, le bloc donne le **nombre** de régressions et défauts, jamais leur détail.

### Contenu du commentaire de PR (Testeur)

Titre : `🧪 Tests de non-régression — tentative <k> — PASS|FAIL`.

```
### Résultats
| Sous-projet | Baseline develop | Candidat (PR + develop) |
| <x> | 120 ✅ / 0 ❌ | 131 ✅ / 0 ❌ |
### Régressions / défauts
1. <test ou commande> — <erreur résumée> — repro : <étapes> — cause probable : <…>
### Critères observables vérifiés
### Réserves (ce qui n'a pas pu être testé et pourquoi)
```
