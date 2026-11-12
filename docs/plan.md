# Team Up — plan de construction

**But :** un site d'annonces « cherche coéquipier » en direct, où la liste ne montre que les joueurs connectés.

**Architecture :** un serveur HTTP Node sans dépendance sert l'interface, garde les annonces en mémoire et les pousse aux navigateurs par un flux d'événements (SSE). Une annonce vit tant que la connexion de son auteur est ouverte.

**Outils :** Node 24 (modules ES, `node:http`, `node:test`), HTML/CSS/JS sans framework.

**Design :** [design.md](design.md)

## Contraintes globales

- Aucune dépendance npm.
- Port `3210` (variable `PORT` pour le changer).
- Contenu des joueurs toujours affiché comme texte, jamais comme HTML.
- Aucun logo ni visuel officiel de jeu.
- Joueurs fictifs uniquement avec `--demo`, toujours marqués `demo: true`.
- Interface en français.

## Points de vigilance

1. Annonce avec un jeu inconnu ou une valeur hors catalogue → refusée avec un message clair.
2. Pseudo ou message contenant du HTML ou des caractères de contrôle → affiché tel quel comme texte, caractères de contrôle retirés.
3. Fermeture ou rechargement de l'onglet → l'annonce disparaît, puis revient toute seule au rechargement.
4. Quelqu'un tente de modifier l'annonce d'un autre → impossible sans le jeton de session.
5. Liste vide pour un jeu → message d'invitation à publier, pas un écran vide.

## Fichiers

| Fichier | Rôle |
| --- | --- |
| `package.json` | scripts `start`, `demo`, `test` |
| `public/games.js` | catalogue : `GAMES`, `COMMON_FIELDS`, `getGame(id)` |
| `lib/listings.js` | `validateListing(input)`, `createStore()`, `compatibility(a, b)` |
| `lib/demo.js` | `startDemo(store)` : joueurs fictifs qui vont et viennent |
| `server.js` | statiques, `GET /api/stream`, `POST`/`DELETE /api/listing` |
| `public/index.html`, `styles.css`, `app.js` | interface |
| `test/listings.test.js` | tests de validation, stockage, compatibilité |
| `test/server.test.js` | tests de bout en bout du serveur |

## Tâches

### 1. Catalogue et logique des annonces

- [ ] `public/games.js` : six jeux, chaque champ `{id, label, type: 'select' | 'number' | 'text', options?, min?, max?, match?: 'same' | 'near'}`.
- [ ] Tests `test/listings.test.js` : annonce valide acceptée ; jeu inconnu refusé ; valeur hors catalogue refusée ; niveau hors bornes refusé ; pseudo vide refusé ; caractères de contrôle retirés ; longueurs tronquées ; `compatibility` vaut 1 pour deux annonces identiques, 0 pour deux jeux différents, et baisse quand la faction diffère.
- [ ] `lib/listings.js` :
  - `validateListing(input) → {ok: true, listing} | {ok: false, error}`
  - `createStore({max = 500}) → {upsert(token, listing), remove(token), all(), size, onChange(fn)}` ; les annonces publiques portent `id` (public), jamais le jeton.
  - `compatibility(mine, other) → number` entre 0 et 1.
- [ ] `node --test` passe.

### 2. Serveur

- [ ] Tests `test/server.test.js` : `GET /` renvoie la page ; `GET /../server.js` ne sort pas de `public/` ; le flux envoie `hello` puis `state` ; publier fait apparaître l'annonce dans `state` ; jeton inconnu → 401 ; corps trop gros → 413 ; fermer le flux retire l'annonce.
- [ ] `server.js` exporte `createApp({demo}) → http.Server` et démarre seulement s'il est lancé directement.
- [ ] En-têtes : CSP, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`.
- [ ] Limites : corps 4 Ko, 8 flux par adresse, une publication par seconde et par session.
- [ ] `lib/demo.js` : une vingtaine de joueurs fictifs, renouvelés régulièrement.

### 3. Interface

- [ ] `index.html` : en-tête avec compteur en direct, accroche, choix du jeu, salon (formulaire + filtres + liste), pied de page.
- [ ] `styles.css` : thème sombre néon, angles coupés, couleur d'accent par jeu, responsive, `prefers-reduced-motion`, focus visible.
- [ ] `app.js` : connexion au flux, formulaire généré depuis le catalogue, publication/retrait, filtres, tri par compatibilité, copie de l'identifiant, annonce gardée en local et republiée au rechargement.

### 4. Vérification

- [ ] `node --test` : tout passe.
- [ ] Dans le navigateur : publier une annonce, la voir dans un second onglet, fermer le premier onglet et la voir disparaître ; vérifier mobile ; aucune erreur dans la console.
