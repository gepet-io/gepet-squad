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

## RAPPORT_DEV (Développeur → CP)

```
RAPPORT_DEV
Statut: LIVRÉ | BLOQUÉ
Issue: #<n> — PR: #<n> — Branche: <branche>
### Critères d'acceptance
- [x] <critère> — preuve : <test / fichier:ligne / sortie>
### Tests
<commande> → <N passés, M échoués>
### Fichiers principaux
### Points d'attention / blocage
```

---

## RAPPORT_VERIFICATION (Vérificateur → CP)

```
RAPPORT_VERIFICATION
Verdict: PASS | FAIL — PR #<n> — tentative <k>
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
Verdict: PASS | FAIL — PR #<n> — tentative <k>
### Résultats
| Sous-projet | Baseline develop | Candidat (PR + develop) |
| <x> | 120 ✅ / 0 ❌ | 131 ✅ / 0 ❌ |
### Régressions / défauts
1. <test ou commande> — <erreur résumée> — repro : <étapes> — cause probable : <…>
### Critères observables vérifiés
### Réserves (ce qui n'a pas pu être testé et pourquoi)
```
