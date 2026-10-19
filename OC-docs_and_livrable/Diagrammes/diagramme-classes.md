# Diagramme de classes — Your Car Your Way

> Brief autonome pour une conversation Claude Design dédiée. Ce document contient tout le contexte nécessaire — il n'y a pas d'autre échange préalable à connaître.

## Contexte du projet

"Your Car Your Way" est un service de location de véhicules opérant dans plusieurs pays. Ce diagramme doit modéliser le **domaine métier central** : comptes, réservations, véhicules/offres, agences, paiement — tel qu'il résulte des spécifications fonctionnelles (user stories) du projet. La base de données cible est **PostgreSQL**, modèle **relationnel** (choix explicite, pour les garanties ACID sur les réservations/paiements — pas de NoSQL en système de référence).

## Objectif de ce diagramme

Un **diagramme de classes UML**, représentant les entités du domaine métier, leurs attributs principaux, et leurs relations (cardinalités comprises). Ce n'est pas un schéma de base de données physique (pas de clés étrangères techniques, pas de tables de jonction techniques) — c'est le modèle de domaine, au niveau conceptuel/logique.

## Règles métier à refléter dans le modèle (issues des user stories actées)

- **Compte invité → activé** : un enregistrement lié à un email existe dès la première réservation (sans inscription), et devient un compte complet si l'utilisateur s'inscrit plus tard avec le même email — ses réservations passées sont alors automatiquement rattachées. Une réservation existe donc toujours en lien avec un compte, qu'il soit "invité" ou "activé".
- **Suppression de compte** : si une réservation est en cours/à venir, ou si des données doivent être légalement conservées, le compte repasse à l'état "invité" plutôt que d'être totalement supprimé.
- **Conducteur distinct du réservataire** : une réservation désigne un conducteur (nom, date de naissance) qui peut être différent de la personne qui réserve et paie ; par défaut, le réservataire est aussi le conducteur.
- **Recherche/réservation inter-pays** : ville de départ et ville de retour peuvent être dans des pays différents.
- **Catégorie de véhicule (norme ACRISS)** + **attribut "véhicule adapté"** (accessibilité fauteuil roulant, mobilité réduite) — deux informations distinctes sur un véhicule.
- **Extras/options** (ex. siège enfant) ajoutables à une réservation, avec des règles de délai/frais (modification sans frais si plus de 2h avant le début de la location, frais sinon).
- **Paiement** : intégralement délégué à un prestataire externe (Stripe) — aucune donnée de carte stockée, uniquement une référence/statut du côté du domaine. Statut de TVA/exonération possible pour un profil entreprise.
- **Personnel d'agence** : accès scopé par région/agence (principe du moindre privilège) — pas d'accès global par défaut.
- **Annulation tardive** : remboursement partiel (25 % du montant total) si annulation à moins d'une semaine du début de la location — règle distincte du délai de modification (48h).

## Classes à représenter

- **Compte**
  Attributs : `email`, `statut` (invité | activé), `motDePasseHash` *(nul si invité)*, `dateCreation`, `nom` *(nul si invité)*, `prénom` *(nul si invité)*, `dateNaissance` *(nul si invité)*, `adresse` *(nul si invité)*.
  Rôle : identité centrale, support du mécanisme invité/activé. Une seule classe plutôt que deux (`Compte`/`Profil` séparés) : plus simple, et correspond probablement à un seul enregistrement en base — les attributs personnels restent nuls tant que le compte est à l'état invité.

- **PersonnelAgence**
  Attributs : `nom`, `rôle`.
  Rôle : utilisateur interne, distinct d'un `Compte` client, rattaché à une ou plusieurs agences (scope d'accès).

- **Réservation**
  Attributs : `référence` (code utilisé pour l'accès invité), `dateDebut`, `dateFin`, `villeDepart`, `villeRetour`, `devise`, `statut` (confirmée | modifiée | annulée), `montantTotal`.
  Rôle : entité centrale du domaine, relie compte, conducteur, offre, extras et paiement.

- **Conducteur**
  Attributs : `nom`, `prénom`, `dateNaissance`.
  Rôle : personne désignée pour conduire sur une réservation donnée (peut être la même personne que le `Compte` réservataire, ou un tiers).

- **Offre**
  Attributs : `tarif`, `dateDebutDisponibilite`, `dateFinDisponibilite`.
  Rôle : combinaison réservable d'un véhicule, d'une période, d'une agence de départ et d'une agence de retour.

- **Véhicule**
  Attributs : `categorieACRISS` (code), `accessible` (booléen, véhicule adapté mobilité réduite), `identifiant`.
  Rôle : référentiel des véhicules physiques/modèles, rattaché à une agence.

- **Agence**
  Attributs : `nom`, `ville`, `pays`, `région` (pour le scope d'accès personnel).
  Rôle : point de prise en charge/retour des véhicules.

- **Extra**
  Attributs : `type` (ex. siège enfant), `tarif`.
  Rôle : option ajoutable à une réservation.

- **ReservationExtra** *(classe-association)*
  Attributs : `quantité`.
  Rôle : relie une `Réservation` à un ou plusieurs `Extra`, avec quantité.

- **Paiement**
  Attributs : `montant`, `devise`, `statutTVA` *(nul si non applicable)*, `référenceExterne` (identifiant côté Stripe), `statut` (confirmé | remboursé partiellement | remboursé).
  Rôle : trace du paiement délégué à Stripe — aucune donnée de carte, uniquement le résultat/référence.

## Relations à représenter (avec cardinalités)

- `Compte` **1** — **0..\*** `Réservation` (un compte, invité ou activé, peut avoir plusieurs réservations)
- `Réservation` **1** — **1** `Conducteur` (conducteur désigné, par défaut = titulaire du compte)
- `Réservation` **1** — **1** `Offre` (l'offre réservée)
- `Offre` **1** — **1** `Véhicule`
- `Offre` **\*** — **1** `Agence` (agence de départ)
- `Offre` **\*** — **1** `Agence` (agence de retour — même classe `Agence`, deux rôles d'association distincts à nommer, ex. `agenceDepart` / `agenceRetour`)
- `Véhicule` **\*** — **1** `Agence` (agence de rattachement du véhicule)
- `Réservation` **1** — **0..\*** `ReservationExtra` — **\*** — **1** `Extra`
- `Réservation` **1** — **1** `Paiement`
- `Agence` **1** — **0..\*** `PersonnelAgence`

## Explicitement hors périmètre de ce diagramme

- Pas d'entités liées au tchat (Conversation, Message) — c'est le périmètre d'une PoC séparée (étape 4), avec sa propre architecture ; peut faire l'objet d'un diagramme de classes dédié plus tard si besoin, mais ne pas l'inclure ici.
- Pas de modèle de facturation détaillé (mentions légales, numérotation) — volontairement écarté du périmètre fonctionnel, remplacé par un simple reçu de paiement.
- Pas de colonnes techniques de base de données (clés primaires/étrangères auto-générées, index) — modèle conceptuel, pas schéma physique.

## Points déjà validés avec l'utilisateur

- `Compte` et `Profil` sont **fusionnés en une seule classe** `Compte`, avec attributs personnels nullables tant que le compte est à l'état invité.
- `Offre` reste une **entité distincte de `Véhicule`** : cohérent avec les user stories, où une recherche retourne des offres (véhicule + période + tarif + agences), pas des véhicules bruts.
- `Offre` porte bien **deux rôles d'association `Agence`** (départ/retour, même classe `Agence`) — nécessaire pour couvrir le cas inter-pays (ville de départ ≠ pays de la ville de retour) ; à bien nommer les rôles dans le diagramme pour éviter toute ambiguïté.

## Style attendu

Notation UML2 standard pour les diagrammes de classes (rectangles à 3 compartiments : nom, attributs, méthodes — les méthodes peuvent être omises ou réduites à l'essentiel, ce domaine étant surtout structurel), cardinalités explicites sur chaque extrémité d'association, classe-association notée en pointillé pour `ReservationExtra`.

## Légende à inclure dans le diagramme

Le diagramme doit comporter une légende explicite couvrant au minimum :
- La signification de la notation de cardinalité (ex. `1`, `0..*`, `0..1`) utilisée sur les associations.
- La distinction entre une association simple (ligne pleine) et une classe-association (ligne pointillée reliant `ReservationExtra` à l'association `Réservation`–`Extra`).
- Le rôle des deux associations distinctes entre `Offre` et `Agence` (`agenceDepart` / `agenceRetour`), pour éviter toute ambiguïté de lecture.
