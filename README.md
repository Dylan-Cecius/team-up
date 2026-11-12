# Team Up

Annonces en direct pour trouver un coéquipier : choisis un jeu, publie tes critères,
et vois les joueurs connectés à l'instant qui cherchent la même chose.

## Lancer le site

Il faut Node 20 ou plus récent. Aucune installation de dépendances.

```bash
node server.js
```

Puis ouvre http://localhost:3210.

Pour juger le rendu avec du monde dans les salons, lance le mode démo : il ajoute
des joueurs fictifs, tous marqués d'un badge « DÉMO ».

```bash
node server.js --demo
```

Variables : `PORT` (3210 par défaut) et `HOST` (`localhost` par défaut ; mets
`0.0.0.0` pour que d'autres appareils du réseau puissent se connecter).

## Tests

```bash
node --test
```

## Comment ça marche

- Chaque onglet ouvre une connexion en direct avec le serveur. Une annonce vit tant
  que cette connexion est ouverte : fermer l'onglet la retire pour tout le monde.
- Recharger la page republie l'annonce toute seule. Un second onglet compte comme
  un autre joueur.
- Les annonces sont gardées en mémoire : elles disparaissent si le serveur redémarre.
- Les identifiants de jeu (BattleTag, Riot ID, Discord…) ne sont pas vérifiés.

## Comptes

Le compte est facultatif : on peut publier sans s'inscrire.

- Un compte réserve son pseudo (un invité ne peut plus l'utiliser), garde les
  identifiants de jeu d'un appareil à l'autre et affiche un badge « Membre ».
- Connexion par pseudo et mot de passe. Aucun e-mail n'est demandé, donc un mot
  de passe oublié ne peut pas être récupéré.
- Les comptes sont enregistrés dans `data/accounts.json` (variable `ACCOUNTS_FILE`
  pour changer d'endroit). Les mots de passe y sont hachés (scrypt), les jetons de
  session aussi. Ce dossier est exclu de git : ne le publie pas.
- Derrière HTTPS, lance le serveur avec `SECURE_COOKIES=1` pour que le cookie de
  session ne voyage jamais en clair.

## Abonnement Plus

L'abonnement Plus (annonce en tête de liste, alertes, badge) est prêt mais fermé
tant que les réglages Stripe sont absents. Mode d'emploi et liste de ce qu'il faut
régler avant de faire payer : [docs/plus.md](docs/plus.md).

## Ajouter un jeu

Tout est dans `public/games.js` : ajoute une entrée à `GAMES` avec ses critères.
Le formulaire, les filtres, la validation côté serveur et le calcul de
compatibilité s'adaptent sans autre changement. Pour le logo, dépose un fichier
dans `public/logos/` et indique son chemin dans le champ `logo` du jeu.

## Logos

Les logos sont des marques déposées de leurs éditeurs. Ils servent ici à
identifier les jeux ; Team Up n'est affilié à aucun éditeur. Avant une mise en
ligne publique, vérifie les règles de chaque éditeur pour les sites de fans.

| Fichier | Source (Wikimedia Commons) | Retouche |
| --- | --- | --- |
| `wow.svg` | WoW icon.svg | aucune (icône : le logo complet n'y est pas disponible librement) |
| `lol.svg` | League of Legends 2019 vector.svg | aucune |
| `valorant.svg` | Valorant logo - pink color version.svg | aucune |
| `cs2.svg` | Counter-Strike 2 logo.svg | texte passé en blanc pour fond sombre |
| `ow2.svg` | Overwatch 2 full logo.svg | texte passé en blanc pour fond sombre |
| `rl.svg` | Rocket League logo.svg | texte passé en blanc pour fond sombre |
| `dofus.webp` | Dofus 3 Logo.webp | aucune |

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `server.js` | serveur HTTP, flux en direct, limites et en-têtes de sécurité |
| `lib/listings.js` | validation des annonces et stockage en mémoire |
| `lib/billing.js` | paiement Stripe et vérification des webhooks |
| `lib/accounts.js` | comptes : inscription, connexion, sessions, profil |
| `lib/demo.js` | joueurs fictifs du mode démo |
| `public/games.js` | catalogue des jeux et de leurs critères |
| `public/compat.js` | score de compatibilité entre deux annonces |
| `public/app.js`, `styles.css`, `index.html` | l'interface |
| `public/account.js` | fenêtre de compte (inscription, connexion, identifiants) |
| `public/logos/` | logos des jeux |
| `docs/` | design validé et plan de construction |
