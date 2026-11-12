# Team Up — design (validé le 2026-11-12)

## Intention

Un site d'annonces « cherche coéquipier » en direct. Un joueur choisit un jeu,
remplit ses critères, s'inscrit dans la liste et voit immédiatement les autres
joueurs connectés qui cherchent aussi, avec leur pseudo et leur identifiant de
plateforme (BattleTag, Riot ID, Steam…). Le but : trouver quelqu'un avec qui
jouer **maintenant**, pas laisser une annonce qui traîne.

## Objectifs

- Présence réelle : la liste ne montre que des joueurs dont la page est ouverte.
- Critères propres à chaque jeu (faction/serveur/niveau pour WoW, rang/rôle/région
  pour les jeux compétitifs).
- Filtrer la liste et repérer d'un coup d'œil les joueurs compatibles.
- Copier l'identifiant d'un joueur en un clic.
- Look très moderne, franchement gaming, utilisable sur mobile.

## Hors périmètre

- Comptes, mots de passe, base de données, chat intégré.
- Hébergement : le site tourne en local tant qu'il n'est pas déployé.
- Vérification des identifiants auprès de Blizzard, Riot ou Steam.

## À éviter absolument

- De faux joueurs présentés comme réels. Le mode démo existe pour juger le rendu,
  et chaque joueur fictif porte un badge « DÉMO ».
- Des logos ou visuels officiels des jeux (droits) : chaque jeu a un monogramme
  et une couleur d'accent maison.

## Approches considérées

1. **Serveur Node sans dépendance + flux en direct (retenu).** Le serveur garde
   les annonces en mémoire et les pousse à tous les onglets. Une annonce vit tant
   que la connexion de son auteur est ouverte. Aucun `npm install`, démarrage
   immédiat. Limite : les annonces disparaissent au redémarrage, une seule
   instance.
2. **Démo statique avec faux joueurs.** Plus simple à héberger, mais personne ne
   s'y voit vraiment : contraire à l'intention.
3. **Framework + base de données + comptes.** Plus solide à terme, mais beaucoup
   plus lourd, et rien de tout ça n'est nécessaire pour valider l'idée.

## Architecture

- `server.js` — serveur HTTP Node : fichiers statiques, API, flux d'événements.
- `lib/listings.js` — validation des annonces, stockage en mémoire, compatibilité.
- `lib/demo.js` — joueurs fictifs du mode démo (`--demo`).
- `public/games.js` — catalogue des jeux et de leurs critères, partagé entre
  serveur et navigateur.
- `public/index.html`, `styles.css`, `app.js` — l'interface, sans framework.

### Présence

1. Le navigateur ouvre `GET /api/stream`. Le serveur répond par un événement
   `hello` contenant un jeton secret de session, puis un événement `state`
   (nombre de visiteurs, toutes les annonces) à chaque changement.
2. `POST /api/listing` avec le jeton publie ou met à jour l'annonce.
   `DELETE /api/listing` la retire.
3. Quand la connexion se ferme, l'annonce est supprimée. Le navigateur garde
   l'annonce en local et la republie tout seul au rechargement.

### Jeux au lancement

| Jeu | Critères | Identifiant |
| --- | --- | --- |
| World of Warcraft | version, faction, serveur, niveau, rôle, activité | BattleTag |
| League of Legends | rang, rôle, serveur, mode | Riot ID |
| Valorant | rang, rôle, région, mode | Riot ID |
| Counter-Strike 2 | cote Premier, rôle, mode | Steam |
| Overwatch 2 | rang, rôle, plateforme, mode | BattleTag |
| Rocket League | rang, mode, plateforme | Epic / Steam |

Champs communs : pseudo, identifiant, langue, micro, message court facultatif.

### Compatibilité

Quand j'ai une annonce active, chaque autre joueur du même jeu reçoit un score :
part des critères « à faire correspondre » qui collent (même faction, même
serveur, même mode ; rang ou niveau proches). La liste est triée par score puis
par ancienneté.

### Sécurité

- Les contenus des joueurs sont affichés comme du texte, jamais comme du HTML.
- Le serveur revalide tout : jeu connu, valeurs dans le catalogue, longueurs
  bornées, caractères de contrôle retirés.
- Seul le détenteur du jeton de session peut modifier ou retirer son annonce.
- Taille des requêtes limitée, nombre de connexions par adresse limité, nombre
  total d'annonces plafonné, en-têtes de sécurité, pas de sortie du dossier
  `public/`.

## Mes choix (non discutés ensemble)

- Dossier `team-up/` séparé du projet Remotion.
- Aucune dépendance, pas de framework : démarrage par `node server.js`.
- Port 3210.
- Mode démo utilisé pour l'aperçu, afin que la liste ne soit pas vide.
- Tests avec le lanceur de tests intégré à Node.
