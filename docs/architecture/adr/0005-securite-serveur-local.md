# 0005 — Sécurité du serveur local
Statut : Acceptée — Date : 2026-10-30

## Contexte

`/gepet-squad-viz` démarre un serveur HTTP sur le poste de l'utilisateur. Il expose l'état d'un projet, éventuellement privé : titres d'issues, numéros de PR, logins. N'importe quelle page web ouverte dans le navigateur peut tenter de joindre `127.0.0.1` (requêtes cross-origin, DNS rebinding). Les titres d'issues sont saisis par des humains ou des agents : ce sont des données non fiables. Le collecteur, lui, tourne dans chaque session Claude Code du projet.

## Décision

Le niveau retenu est celui d'un **outil local mono-utilisateur, en lecture seule, sans authentification applicative**. La protection repose sur le confinement réseau et l'origine :

1. **Écoute** sur `127.0.0.1` uniquement. Le port vaut `0` (choix automatique) par défaut, ou la valeur de `--port`. Le port et le pid sont écrits dans un fichier verrou `<git-common-dir>/gepet-squad/viz.lock`, qui garantit l'unicité. Les sous-commandes `node viz/server.cjs status` et `stop`, comme le démarrage, lisent ce verrou et appliquent **la même définition de « vivant »** (voir ci-dessous). `stop` arrête le processus par `process.kill`. Le skill ne manipule jamais de pid lui-même, ce qui garantit le même comportement sous Windows, macOS et Linux. Le verrou est une entrée non fiable : seuls un pid et un port entiers valides en sont lus (sinon il est invalide), et l'URL affichée est reconstruite à partir du port. Sous Windows, `process.kill` termine le serveur sans lui laisser supprimer son verrou : `stop` le supprime lui-même.

   **Définition de « vivant ».** Un serveur est vivant quand deux conditions sont réunies : (a) le pid du verrou existe, et (b) `GET /health` sur le port du verrou répond `{"ok":true,"pid":<n>}` avec un `pid` égal à celui du verrou. Le pid seul ne suffit pas : après un redémarrage de la machine ou un arrêt brutal du serveur, un verrou peut subsister avec un pid réattribué à un autre processus, sur un port muet ou tenu par un autre programme. La vérification classe le verrou en trois états :
   - `live` : (a) et (b) ;
   - `stale` : le pid n'existe plus, ou `/health` est muet, hors délai, d'un statut autre que 200, illisible, de plus de 1 Ko, ou annonce un autre pid (ou aucun) ;
   - `invalid` : le contenu du verrou est corrompu (JSON invalide, pid ou port hors bornes, fichier de plus de 4 Ko).

   Conséquences pour les commandes. `status` affiche l'URL et répond 0 pour un verrou `live` seulement (`status --wait` attend un verrou `live`) ; pour `stale` ou `invalid`, il supprime le verrou et répond 1. Un démarrage face à un verrou `live` affiche l'URL existante et répond 0 sans lancer de second serveur ; face à un verrou `stale` ou `invalid`, il le remplace et démarre. `stop` n'envoie un signal que pour un verrou `live`, donc seulement si `/health` renvoie le pid du verrou : un processus étranger qui a repris le pid, ou un faux serveur qui répond `{"ok":true}` sans le bon pid, ne reçoit aucun signal ; le verrou `stale` est supprimé et `stop` répond 1 avec un message qui nomme le fichier. Le verrou n'est supprimé que s'il n'a pas changé pendant le sondage, pour ne pas effacer celui d'un serveur qui vient de démarrer.

   Le sondage de `/health` est borné : délai total de 1 s (y compris face à un serveur qui répond au compte-gouttes), aucune redirection suivie, corps de plus de 1 Ko ignoré. Seul l'entier `pid` en est extrait ; rien de ce qui est reçu n'est exécuté, ouvert ni affiché. Le pid dans `/health` n'est pas une authentification : il distingue le serveur du verrou d'un pid réattribué ou d'un port réutilisé, mais ne protège pas d'un processus local malveillant qui connaîtrait le pid et ouvrirait ce port, ce qui reste hors du niveau de menace retenu (poste mono-utilisateur). Un serveur vivant mais bloqué plus d'une seconde serait vu comme `stale` : ce risque résiduel est décrit et accepté dans « Conséquences » (« Faux `stale` »).
2. **En-tête `Host`** : il doit valoir `127.0.0.1:<port>` ou `localhost:<port>`, sinon le serveur répond **421**. C'est la protection contre le DNS rebinding.
3. **Méthodes** : seules GET et HEAD sont acceptées, les autres reçoivent **405**. Aucun en-tête `Access-Control-Allow-*` n'est envoyé.
4. **Fichiers statiques** : servis depuis `viz/public/` uniquement. Le chemin est résolu, puis on vérifie qu'il reste sous cette racine : sinon **403**. Les types MIME proviennent d'une liste blanche (`.html`, `.js`, `.css`, `.json`, `.svg`, `.png`), tout le reste reçoit **404**.
5. **En-têtes** :
   - `Content-Security-Policy: default-src 'self'; script-src 'self' 'sha256-<importmap>'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'` ;
   - `X-Content-Type-Options: nosniff` ;
   - `Referrer-Policy: no-referrer` ;
   - `Cache-Control: no-store` sur `/state` et `/events`.
6. **Rendu** : toute donnée venue de GitHub ou du journal est insérée par `textContent` (étiquettes CSS2D comprises). `innerHTML` est interdit dans `viz/public/js/`, et une règle ESLint `no-restricted-properties` l'impose.
7. **Secrets** : aucun. `gh` gère l'authentification, et il est appelé par `execFile` avec des arguments en tableau, sans shell. Le seul argument variable est le repo lu dans `.gepet-squad.json`, validé par `^[\w.-]+/[\w.-]+$`. Les sorties d'erreur de `gh` ne sont pas renvoyées au navigateur : le navigateur ne reçoit qu'un message générique, le détail part sur stderr.
8. **Collecteur** : `async`, il ne produit rien sur stdout, sort toujours avec le code 0 et ne lève jamais d'exception. Il ne lit que les champs listés dans l'ADR 0003, et les lignes du journal sont bornées à 4 Ko (troncature des champs texte).
9. **Dépendances** : aucune à l'exécution. Three.js est épinglé à une version et vendoré avec sa licence. Les devDependencies sont verrouillées par `package-lock.json`.

## Alternatives considérées

| Option | Avantages | Inconvénients |
|---|---|---|
| Jeton aléatoire dans l'URL (`?t=…`) | Protège aussi des autres utilisateurs locaux | L'URL devient fragile à partager entre la commande et le navigateur, la fuite par historique est possible, et c'est superflu pour un poste mono-utilisateur en lecture seule. Pourra être ajouté par ADR si le besoin apparaît. |
| Écoute sur `0.0.0.0` (consultation depuis une autre machine) | Accès à distance | Exposition réseau d'un projet privé : hors périmètre |
| CSP avec `'unsafe-inline'` | Simple pour l'importmap | Annule la protection contre l'injection de script |

## Conséquences

- Les tests d'intégration de `viz-server` doivent couvrir : `Host` étranger → 421, `POST` → 405, traversée (`/../`, `%2e%2e`) → 403, présence de la CSP, absence d'en-tête CORS.
- `index.html` ne contient qu'un seul script inline, l'importmap, dont l'empreinte est calculée par le serveur au démarrage. Tout autre script est un fichier.
- `viz.lock` doit être nettoyé à l'arrêt. Au démarrage, on remplace un verrou `stale` ou `invalid` (pid inexistant, `/health` qui ne répond pas avec ce pid, contenu corrompu).
- Les tests couvrent la décision `live` / `stale` / `invalid` avec un `/health` simulé (bon pid, autre pid, sans pid, muet, hors délai, corps trop gros) et, avec un faux serveur HTTP sur le port du verrou, le comportement de `status`, du démarrage et de `stop` face à un pid vivant mais étranger : aucun signal n'est envoyé.
- **Faux `stale` (risque résiduel accepté).** Un serveur vivant dont la boucle d'événements est bloquée plus d'une seconde ne répond pas à `/health` dans le délai : il est jugé `stale`. `status` ou le démarrage supprime alors son verrou, et le démarrage lance un second serveur. Le premier devient orphelin et `stop` ne peut plus l'atteindre. Ce cas est accepté pour le MVP : l'orphelin reste en lecture seule, n'écoute que sur 127.0.0.1, et on l'arrête à la main (processus `node viz/server.cjs`) ou en fermant la session. Piste non retenue pour le MVP : refaire un sondage (une ou deux nouvelles tentatives espacées) avant de conclure à `stale`. Elle réduirait ce risque, mais allongerait de plusieurs secondes `status`, `stop` et le démarrage dans le cas courant d'un verrou réellement périmé.
