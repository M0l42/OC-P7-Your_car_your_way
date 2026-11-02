# Diagramme de composants — Your Car Your Way

> Brief autonome pour une conversation Claude Design dédiée. Ce document contient tout le contexte nécessaire — il n'y a pas d'autre échange préalable à connaître.

## Contexte du projet

"Your Car Your Way" est un service de location de véhicules opérant dans plusieurs pays (France, Allemagne, Espagne, Italie, Royaume-Uni, Canada, États-Unis). L'existant est composé de 4 systèmes indépendants (silos par pays/zone), sans base de données ni API partagées. Le projet consiste à concevoir une architecture cible commune, pensée pour l'ensemble des marchés.

**Décision d'architecture retenue** : un **monolithe modulaire**, structuré selon les principes du **Domain-Driven Design (DDD)** — une seule application déployée, mais strictement découpée en modules de domaine avec des frontières internes explicites (plutôt que des microservices, jugés disproportionnés pour la taille de l'équipe et le périmètre fonctionnel).

**Stack technique déjà décidée** (pertinente pour nommer/annoter les composants, pas pour le contenu du diagramme lui-même) : backend Java + Spring Boot, base de données PostgreSQL, frontend Angular. Le paiement est intégralement délégué à un prestataire externe (Stripe) — aucune donnée de paiement n'est stockée par l'application.

**Exception au monolithe** : la fonctionnalité de **tchat** (support client, étape 4 du projet) est extraite comme un **service indépendant**, car son modèle de connexions persistantes (WebSocket) et son profil de charge diffèrent nettement du reste de l'application. C'est la seule extraction prévue à ce stade.

## Objectif de ce diagramme

Un **diagramme de composants UML**, montrant l'architecture applicative logique du monolithe modulaire : ses modules internes, leurs responsabilités, leurs dépendances mutuelles, et ses interfaces avec l'extérieur (client frontend, service de paiement externe, base de données, service de tchat et sa propre base).

Ce diagramme doit rendre visibles deux choses en particulier :
1. Que l'application est **un seul déployable** (pas des microservices) — les modules sont des frontières logiques internes, pas des services réseau séparés.
2. Que le service de tchat est, lui, **réellement séparé** (autre unité de déploiement), et pourquoi (WebSocket / charge différente).

## Composants à représenter

**À l'intérieur du monolithe** (frontières de modules internes, notation `<<module>>` ou équivalent — pas des composants déployables séparément) :

- **Module Utilisateurs & Comptes**
  Gestion du cycle de vie compte "invité → activé" (un enregistrement lié à l'email existe dès la première réservation, devient un compte complet à l'inscription avec le même email), authentification, profil utilisateur, suppression de compte (avec retour à l'état "invité" si conservation nécessaire), accès du personnel d'agence scopé par région/agence.

- **Module Catalogue (Véhicules, Offres, Agences)**
  Référentiel des véhicules (catégorie ACRISS, attribut "véhicule adapté" pour mobilité réduite), des offres (véhicule + période + tarif), et des agences (localisation, rattachement du personnel).

- **Module Réservations**
  Recherche d'offres (y compris inter-pays : ville de départ ≠ pays de la ville de retour), création/modification/annulation de réservation, désignation d'un conducteur distinct du réservataire, gestion des extras/options (ex. siège enfant), règles métier de délai (modification impossible à moins de 48h sur date/heure/ville, frais au-delà de 2h sur les extras, remboursement partiel à 25 % en cas d'annulation tardive).

- **Module Paiement**
  Orchestration du paiement auprès du prestataire externe (voir composant externe ci-dessous) — ne stocke aucune donnée de paiement, gère le statut TVA/exonération pour les profils entreprise, génère uniquement une confirmation/reçu.

- **Module API**
  Expose les opérations CRUD par domaine (utilisateurs, réservations, véhicules...), consommées à la fois par le frontend web et par les applications utilisées en agence.

**En dehors du monolithe** (composants/systèmes séparés) :

- **Frontend Angular (SPA)** — client consommant l'API du monolithe via HTTPS/REST.
- **Service Tchat** — composant déployé indépendamment, connexions persistantes (WebSocket/STOMP), hors périmètre du monolithe. Plusieurs instances, synchronisées par la base (`LISTEN/NOTIFY`).
- **Base de données `chat`** — base logique PostgreSQL **propre au Service Tchat** (conversations, messages), avec ses propres identifiants et migrations ; hébergée sur la même instance PostgreSQL que la base du monolithe, mais sans aucun lien avec son schéma.
- **Base de données PostgreSQL** — source de vérité unique, consommée par les modules internes via une couche d'accès aux données (pas de composant interne dédié à représenter séparément, sauf si tu préfères isoler un "Module Accès aux données").
- **Prestataire de paiement externe (Stripe)** — système tiers, appelé par le Module Paiement ; gère aussi la conversion de devise et le statut TVA/exonération (capacité exacte à vérifier, mais pertinent à montrer comme interface externe).

## Relations à représenter

- Frontend Angular → Module API (interface REST/HTTPS)
- Applications agence → Module API (même interface, autre client)
- Module API → Module Utilisateurs & Comptes, Module Catalogue, Module Réservations (délégation par domaine)
- Module Réservations → Module Catalogue (vérifie la disponibilité d'une offre/véhicule)
- Module Réservations → Module Utilisateurs & Comptes (rattache une réservation à un compte invité ou activé)
- Module Réservations → Module Paiement (déclenche le paiement à la finalisation d'une réservation)
- Module Paiement → Prestataire de paiement externe (Stripe) (interface externe, hors monolithe)
- Tous les modules internes → Base de données PostgreSQL (persistance ; un seul socle de données partagé, pas un schéma par module)
- Frontend Angular → Service Tchat (WebSocket/STOMP pour le temps réel, REST pour l'historique)
- Service Tchat → Base de données `chat` (persistance des conversations et messages, et notifications `LISTEN/NOTIFY` entre ses instances)
- Service Tchat ⇢ Module Utilisateurs & Comptes : **dépendance de confiance uniquement, pas d'appel** — le Service Tchat vérifie les jetons JWT signés par le monolithe avec une clé publique en configuration ; il n'appelle jamais le monolithe à l'exécution (à représenter en pointillé léger avec la note « vérifie les jetons JWT émis par », ou par une simple note si plus lisible)
- Service Tchat : **aucune dépendance aux modules du monolithe ni à la base du monolithe** (c'est le point à illustrer — il est autonome ; la référence de réservation est un identifiant fourni par le client, pas une intégration directe)

## Explicitement hors périmètre de ce diagramme

- Pas de détail d'infrastructure (régions, load balancers, conteneurs) — c'est l'objet du diagramme de déploiement, dans un document séparé.
- Pas d'attributs/méthodes de classes — c'est l'objet du diagramme de classes, dans un document séparé.
- Pas de moteur de facturation interne (volontairement écarté du périmètre fonctionnel).

## Points déjà validés avec l'utilisateur

- Le découpage retenu est bien 4 modules métier (Utilisateurs & Comptes, Catalogue, Réservations, Paiement) + 1 module API.
- **Agences** est regroupé dans le module Catalogue (pas de module séparé) : il s'agit surtout de données de référence (localisation, rattachement véhicule), sans logique métier propre qui justifierait une frontière dédiée.
- Le Service Tchat n'a aucune dépendance directe aux modules du monolithe ni à sa base — il est autonome — mais il **possède sa propre base `chat`** (la persistance des messages avant diffusion est au cœur de sa fiabilité). *(Corrigé à l'étape 4 : la version précédente indiquait « aucune base de données », ce qui contredisait la structure de données demandée pour le tchat.)*
- Le Service Tchat identifie ses utilisateurs par un **jeton JWT signé par le monolithe** (module Utilisateurs & Comptes), qu'il vérifie avec une clé publique en configuration. C'est la seule dépendance au monolithe, et elle est de confiance uniquement : aucun appel à l'exécution : tant que le jeton d'un utilisateur est valide, le tchat fonctionne même si le monolithe est indisponible.

## Style attendu

Notation UML2 standard pour les diagrammes de composants (rectangles `<<component>>`/`<<module>>`, interfaces en lollipop/socket si pertinent, flèches de dépendance pointillées). Lisible, sans surcharge visuelle — l'objectif est la clarté des frontières de modules, pas l'exhaustivité technique.

## Légende à inclure dans le diagramme

Le diagramme doit comporter une légende explicite couvrant au minimum :
- La distinction `<<module>>` (frontière interne au monolithe, non déployable séparément) vs `<<component>>` (unité déployable indépendamment — ex. Service Tchat, Frontend Angular).
- La signification des flèches de dépendance (appel/utilisation) — et, si des interfaces lollipop/socket sont utilisées, leur signification (interface fournie / requise).
- Une indication claire que le monolithe (modules internes) constitue **un seul artefact déployé**, par opposition aux composants externes qui sont des déploiements séparés.
