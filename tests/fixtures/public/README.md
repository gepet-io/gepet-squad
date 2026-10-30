# Dossier public de fixture

Utilisé par `tests/viz-server/server.test.cjs` via `--public-dir tests/fixtures/public/`, à la place de `viz/public/`.

- `index.html` contient un importmap inline : le serveur en calcule l'empreinte pour la CSP.
- `js/app.js` et `css/app.css` : fichiers statiques de la liste blanche.
- `notes.txt` et ce `README.md` : extensions hors liste blanche, le serveur répond 404.
