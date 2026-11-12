# Team Up Plus — brancher le paiement

Plus est un abonnement mensuel payé par Stripe Checkout. Le code est prêt et testé
avec un faux Stripe, mais **rien n'est actif tant que tu n'as pas donné tes propres
réglages Stripe** : sans eux, le site affiche « Bientôt disponible » et toutes les
routes de paiement répondent « pas encore ouvert ».

## Ce que Plus apporte aujourd'hui

- Annonce en tête de liste, juste après la sienne.
- Alertes quand un joueur compatible (70 % ou plus) arrive, tant que l'annonce est
  en ligne : notification du navigateur si l'onglet est en arrière-plan, message
  dans la page sinon.
- Badge « Plus » sur les annonces.

Pas encore fait : plusieurs annonces à la fois, et « sans publicité » (il n'y a pas
de publicité sur le site pour l'instant).

## Comment ça marche

1. Un membre connecté clique sur **Passer à Plus** : le serveur crée une session
   Stripe Checkout et renvoie le navigateur vers la page de paiement de Stripe.
   Les données de carte ne passent jamais par Team Up.
2. Après paiement, Stripe prévient le serveur par un **webhook signé**
   (`/api/billing/webhook`). C'est la seule chose qui active ou coupe Plus : le
   retour du navigateur n'est jamais cru sur parole.
3. **Gérer mon abonnement** ouvre le portail Stripe : changer de carte, voir les
   factures, résilier.
4. Un compte ne peut pas être supprimé tant qu'un abonnement court sans résiliation
   programmée, pour éviter de continuer à payer un compte qui n'existe plus.

## Mise en route (en mode test d'abord)

1. Crée un compte sur stripe.com et reste en **mode test**.
2. **Produits** : crée « Team Up Plus » avec un prix récurrent mensuel (le montant
   est à toi). Copie l'identifiant du prix (`price_…`).
3. **Développeurs → Clés API** : copie la clé secrète de test (`sk_test_…`).
   Ne la mets jamais dans le code ni dans un fichier suivi par git.
4. **Réglages → Facturation → Portail client** : active-le et autorise la
   résiliation, le changement de moyen de paiement et l'historique des factures.
   Sans ça, le bouton « Gérer mon abonnement » échoue.
5. **Webhook** :
   - en local, installe la CLI Stripe et lance
     `stripe listen --forward-to localhost:3210/api/billing/webhook` : elle affiche
     un secret `whsec_…` ;
   - en ligne, crée un point d'accès `https://TON-SITE/api/billing/webhook` avec
     les événements `checkout.session.completed`,
     `customer.subscription.created`, `customer.subscription.updated` et
     `customer.subscription.deleted`.
6. Crée un fichier `.env` dans `team-up/` (déjà exclu de git) :

   ```
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_PRICE_ID=price_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   SITE_URL=http://localhost:3210
   PLUS_PRICE_LABEL=2,99 € / mois
   ```

   `PLUS_PRICE_LABEL` n'est qu'un texte affiché : il doit correspondre au prix créé
   dans Stripe.
7. Lance `node --env-file=.env server.js`. La console doit afficher
   « Abonnement Plus : ouvert ».
8. Paie avec la carte de test `4242 4242 4242 4242` (date future, code au choix).
   Au retour, Plus doit s'activer en quelques secondes.

Pour passer en réel : clés, prix et webhook **du mode réel** (les trois sont
différents de ceux du mode test), `SITE_URL` en `https://`, et `SECURE_COOKIES=1`.

## Avant de faire payer de vraies personnes

Ce n'est pas un avis juridique : à vérifier auprès d'un professionnel ou des sites
officiels.

- **Statut** : vendre un abonnement demande une activité déclarée (par exemple une
  micro-entreprise) et un régime de TVA clair.
- **Pages légales** : le site n'a aucune page de conditions de vente, de mentions
  légales ni de politique de confidentialité. Elles sont obligatoires avant de
  vendre, et l'adresse de la politique de confidentialité doit être déclarée dans
  Stripe.
- **Droit de rétractation** : pour un service numérique, l'accord exprès du client
  pour commencer tout de suite doit être recueilli au paiement (Stripe Checkout
  peut le demander).
- **Logos et nom** : les logos des jeux sont des marques de leurs éditeurs et le nom
  « Team Up » est déjà déposé par d'autres. Le risque est bien plus grand une fois
  qu'il y a de l'argent. Voir le README.
- **Sauvegardes** : le statut Plus de chaque compte est dans `data/accounts.json`.
  Sauvegarde ce fichier ; s'il est perdu, des abonnés qui paient perdent Plus.
- **Une seule instance** : les annonces sont en mémoire et les comptes dans un
  fichier. Ne lance qu'un seul serveur.

## Limites connues

- Quand l'abonnement s'arrête, une annonce déjà en ligne garde son badge jusqu'à ce
  que son auteur recharge la page ou la republie.
- Un paiement échoué (`past_due`) coupe Plus tout de suite, sans délai de grâce,
  même si Stripe retente le prélèvement.
- Les comptes n'ont pas d'e-mail : c'est Stripe qui recueille celui du client et
  envoie les reçus, si tu l'actives dans ses réglages.
