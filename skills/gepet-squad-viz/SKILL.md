---
name: gepet-squad-viz
description: Ouvre la vue 3D temps réel d'un projet de la squad gepet. Démarre le serveur local en arrière-plan et affiche l'URL à ouvrir dans le navigateur ; avec l'argument « stop », arrête ce serveur.
argument-hint: "[stop]"
disable-model-invocation: true
---

# Vue 3D d'un projet gepet-squad

Argument de l'utilisateur : $ARGUMENTS

Ce skill est une commande mince : toute la logique (unicité du serveur, verrou, arrêt) est dans la CLI `viz/server.cjs`. Tu ne manipules aucun identifiant de processus, tu n'envoies aucun signal d'arrêt toi-même, et tu ne lis ni n'écris le fichier de verrou : tu appelles la CLI et tu rapportes son résultat.

Dans les commandes ci-dessous, `<cwd>` est le répertoire courant de la session, en chemin absolu, entre guillemets. Garde ces guillemets : le chemin peut contenir des espaces.

## 1. Vérifications préalables

Fais-les dans l'ordre et arrête-toi au premier échec, avec un message clair et sans lancer aucun serveur.

1. **Projet squad.** Cherche `.gepet-squad.json` dans le répertoire courant, puis dans ses parents, jusqu'à la racine du disque. S'il est introuvable, réponds : « Aucun projet gepet-squad ici : `.gepet-squad.json` est introuvable depuis ce dossier. Place-toi dans un projet lancé avec `/gepet-squad "<besoin>"`, ou lance cette commande depuis un de ses sous-dossiers. »
2. **Node.** Lance `node --version`. Si la commande échoue, ou si la version majeure est inférieure à 22, réponds que la vue 3D demande Node 22 ou plus (en indiquant la version trouvée, ou l'absence de Node), et arrête-toi.

## 2. Si l'argument est `stop`

Lance :

```bash
node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" stop --project "<cwd>"
```

- Code de sortie 0 : réponds que le serveur est arrêté.
- Code de sortie différent de 0 : rapporte le message de la CLI tel quel (par exemple « Aucun serveur lancé pour ce projet. ») sans rien tenter d'autre.

Puis termine : ne démarre rien.

## 3. Sinon, démarrer ou réafficher

Un argument autre que `stop` n'est pas reconnu : dis-le en une phrase, rappelle l'usage (`/gepet-squad:gepet-squad-viz` ou `/gepet-squad:gepet-squad-viz stop`) et arrête-toi.

1. **Un serveur tourne-t-il déjà ?** Lance :

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" status --project "<cwd>"
   ```

   Si le code de sortie est 0, la sortie standard est l'URL : affiche-la et termine (c'est le même serveur, rien n'est relancé).

2. **Sinon (code 1), démarre le serveur en arrière-plan.** Utilise l'outil Bash avec `run_in_background: true` pour cette commande, qui ne rend jamais la main tant que le serveur tourne :

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" --project "<cwd>"
   ```

3. **Attends l'URL.** Le serveur n'écoute qu'après son premier instantané GitHub, ce qui peut prendre jusqu'à 15 s. Lance donc, en avant-plan :

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/viz/server.cjs" status --project "<cwd>" --wait 20
   ```

   - Code 0 : la sortie standard est l'URL. Affiche-la.
   - Code 1 : le serveur n'a pas démarré à temps. Consulte la sortie de la tâche en arrière-plan, rapporte le message d'erreur qu'elle contient (préfixe `[gepet-squad-viz]`) et suggère de vérifier que `gh` est authentifié (`gh auth status`). N'insiste pas et ne relance pas en boucle.

## 4. Ce que tu réponds

Reste bref :

- l'URL, sur sa propre ligne, à ouvrir dans le navigateur (la page montre le bureau de la squad, son kanban et les bonhommes au travail) ;
- une seule phrase après l'URL : la vue est en lecture seule et se met à jour toute seule, `/gepet-squad:gepet-squad-viz stop` arrête le serveur, et `?mode=texte` à la fin de l'URL ouvre la vue texte si la 3D ne s'affiche pas.

N'ouvre pas le navigateur toi-même.
