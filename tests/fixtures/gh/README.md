# Fixtures de commandes `gh`

Chaque fichier `.txt` contient une ligne de commande Bash (éventuellement sur plusieurs lignes) telle que le Chef de projet ou un agent la lance. Elles alimentent `tests/hooks/gh-command.test.cjs`. Les formes viennent de `skills/gepet-squad/references/github-conventions.md`, de `skills/gepet-squad/SKILL.md` et de `agents/*.md`, avec des valeurs concrètes (`o/r`, issue 12, PR 34, milestone 3) à la place des marqueurs `<n>`.

- `doc-placeholders.txt` garde les marqueurs `<n>`, `<REPO>`… tels quels. Ce n'est pas une commande exécutable : elle ne doit produire aucun événement.
- `pr-comment-heredoc.txt` contient, dans son heredoc, des lignes qui ressemblent à des commandes `gh` : elles ne doivent produire aucun événement.
- `read-only.txt` regroupe des commandes `gh` non suivies (lecture seule) : aucun événement.
