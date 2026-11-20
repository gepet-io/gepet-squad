# 0014 — Sobriété de contexte : relais, relève, transitions scriptées et voie légère
Statut : Acceptée — Date : 2026-11-20 — Complète l'[ADR 0013](0013-contrat-lecture-transcripts-et-attribution.md), dont il réutilise la lecture des transcripts dans un hook.

## Contexte

Mesures de `conso/cli.cjs` sur un projet réel (mode économe hybride, 64 features, 254 agents, 1,03 Md tokens) :

| Poste | Part | Contexte moyen relu à chaque appel |
|---|---|---|
| Développeurs | 57 % | 117k (≈ 50 appels par agent ; médiane 3,2 M, moyenne 7 M, les 8 plus gros font 38 % du poste) |
| Chef de projet | 29 % | 272k (il part de 80k et monte jusqu'à 740k) |
| Testeurs | 6 % | 30k |
| Vérificateurs | 4 % | 38k |

96 % des tokens sont des relectures de cache : le coût d'un agent est à peu près son **nombre d'appels × la taille de son contexte**, qui croît plus vite que la durée de la mission. Les postes qui comptent sont les contextes longs (développeurs de la longue traîne, CP sur plusieurs milestones), puis ce qui gonfle chaque appel : sorties de tests complètes, attente active, liste des skills chargée par l'outil `Skill` (≈ 8 à 9k tokens dans chaque appel du développeur), 2,6 tours du CP par agent lancé.

## Décision

1. **Relais du développeur.** Un hook `PostToolUse` synchrone (`hooks/budget.cjs`) lit la fin du transcript de l'agent (`<session>/subagents/agent-<id>.jsonl`, contrat de l'ADR 0013) et calcule le contexte du dernier appel (entrée + cache lu + cache écrit). Au premier franchissement de `budget.developpeur` (120 000 par défaut), il injecte une consigne (`additionalContext`) : le développeur commite son travail, écrit une note de relais et rend `Statut: RELAIS`. Le CP relance un développeur neuf en `MODE: REPRISE`, sans compter d'échec ; au troisième relais d'une feature, escalade.
2. **Relève du CP.** À la fin de chaque milestone (clé `releve`, `milestone` par défaut) ou quand le hook voit le contexte du CP dépasser `budget.chefDeProjet` (250 000), le CP atteint un point calme et passe la main : `/clear` puis `/gepet-squad-resume`. Le CP ne pouvant pas vider son contexte lui-même, c'est le seul arrêt de la phase autonome ; il coïncide avec le merge de release que l'utilisateur fait de toute façon. Le hook ne s'adresse à une session principale que si elle a lancé des agents de la squad (`.meta.json` de ses agents).
3. **Transitions scriptées.** `scripts/squad.cjs` (`etat`, `statut`, `merge`) remplace les suites `gh` / `git` / `Edit` du CP par une commande à sortie courte, dans les trois modes. Le garde-fou ne voyant que `node squad.cjs`, le script applique lui-même ses règles (merge vers `develop` seulement, ni `gh` ni push en économe local) et journalise les commandes `gh` exécutées comme le ferait le collecteur.
4. **Sorties bornées.** `scripts/run-quiet.sh` garde le log complet dans un fichier et n'affiche que le verdict, les lignes d'erreur et la fin du log ; `--ci` enchaîne les `ci.commands`. Les agents lancent leurs commandes au premier plan, sans attente active.
5. **`Skill` réservé.** Le développeur n'a plus l'outil `Skill` ; la variante `developpeur-outille` le garde et relit les instructions du développeur depuis `agents/developpeur.md` (une seule source). Le CP la lance pour une feature dont la taille porte `· outillé`. La conso et la vue la rangent sous le rôle `developpeur`.
6. **Voie légère.** Une feature `S` sans enjeu réseau, protocole, authentification, persistance, zone sensible (`sensitivePaths`) ni test complexe passe par le développeur puis le testeur, qui relit le diff avec une grille courte (sans `Skill`) avant de tester. Retour en voie normale au second échec ou si le testeur la juge hors voie légère.

## Alternatives écartées

- **Supprimer le vérificateur partout** : 4 % du total, et il apporte une vraie valeur sur le réseau et la sécurité.
- **`/code-review` chez le testeur** (proposition initiale de la voie légère) : l'outil `Skill` ajouterait à chaque appel du testeur la liste des skills, environ la moitié du coût d'un vérificateur.
- **Compter les appels d'outils dans le prompt** pour déclencher le relais : un modèle compte mal, et le nombre d'appels ne dit pas la taille du contexte.

## Conséquences

- Simulation sur les courbes de contexte réelles : −27 à −39 % sur les développeurs (seuil 160k à 120k), −42 à −52 % sur le CP (relève à 250k ou 200k). Ces chiffres sont optimistes, puisque l'agent repris relit un peu de code ; l'objectif reste d'environ −30 % au total.
- Le hook tourne à chaque appel d'outil (≈ 60 ms, comme le garde-fou) et ne fait rien hors d'un projet squad.
- La relève demande une action de l'utilisateur par milestone ; `"releve": "aucune"` garde l'ancien enchaînement.
