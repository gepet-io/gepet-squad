# 0005 — Sécurité du serveur local
Statut : Acceptée — Date : 2026-10-30

## Contexte

`/gepet-squad-viz` démarre un serveur HTTP sur le poste de l'utilisateur. Il expose l'état d'un projet, éventuellement privé : titres d'issues, numéros de PR, logins. N'importe quelle page web ouverte dans le navigateur peut tenter de joindre `127.0.0.1` (requêtes cross-origin, DNS rebinding). Les titres d'issues sont saisis par des humains ou des agents : ce sont des données non fiables. Le collecteur, lui, tourne dans chaque session Claude Code du projet.

## Décision

Le niveau retenu est celui d'un **outil local mono-utilisateur, en lecture seule, sans authentification applicative**. La protection repose sur le confinement réseau et l'origine :

1. **Écoute** sur `127.0.0.1` uniquement. Le port vaut `0` (choix automatique) par défaut, ou la valeur de `--port`. Le port et le pid sont écrits dans un fichier verrou `<git-common-dir>/gepet-squad/viz.lock`, qui garantit l'unicité et permet `stop`.
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
- `viz.lock` doit être nettoyé à l'arrêt. Au démarrage, on ignore un verrou dont le pid n'existe plus.
