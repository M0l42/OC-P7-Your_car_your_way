# Diagramme de déploiement — Your Car Your Way

> Brief autonome pour une conversation Claude Design dédiée. Ce document contient tout le contexte nécessaire — il n'y a pas d'autre échange préalable à connaître.

## Contexte du projet

"Your Car Your Way" est un service de location de véhicules opérant dans plusieurs pays (Europe : FR/DE/ES/IT/UK ; Amérique du Nord : CA/US). L'architecture cible est un **monolithe modulaire unique** (un seul artefact applicatif), mais **déployé en plusieurs exemplaires indépendants**, répartis par région, pour des raisons de latence et de couverture géographique — ce n'est pas une décomposition en microservices, c'est de la réplication du même artefact.

## Décisions techniques déjà actées (à respecter strictement dans le diagramme)

- **Hébergement : AWS**, retenu notamment pour sa couverture géographique Europe + Amérique du Nord et son service PostgreSQL managé.
- **Conteneurisation/orchestration : conteneurs Docker sur une plateforme de conteneurs managée sans gestion de cluster** — concrètement **AWS Fargate/ECS**. Kubernetes a été explicitement écarté (sur-dimensionné pour un monolithe à déploiement unique, charge opérationnelle disproportionnée pour l'équipe).
- **Base de données : PostgreSQL managé (Amazon RDS)**, avec **réplicas régionaux en lecture** — un socle de données unique fait autorité (un seul primaire en écriture), les données ne doivent pas être fragmentées en silos régionaux.
- **Redondance applicative** : plusieurs instances du monolithe par région (pas de point de défaillance unique, contrairement à l'existant).
- **Déploiements automatisés (CI/CD)** : remplace les déploiements manuels de l'existant, identifiés à l'audit comme cause probable du faible taux de réussite des déploiements et du MTTR élevé.
- **Service Tchat** (étape 4, PoC) : service **indépendant** du monolithe (WebSocket, profil de charge différent), déployé séparément mais sur la même plateforme de conteneurs managée (pas besoin de Kubernetes pour faire cohabiter les deux).

## Objectif de ce diagramme

Un **diagramme de déploiement UML**, montrant la topologie physique/infrastructure cible : les régions, les nœuds (conteneurs, bases de données), la répartition du trafic entre régions, et le flux de déploiement (CI/CD). L'objectif est de rendre visible que :
1. C'est **le même artefact applicatif** qui tourne dans chaque région (pas des services différents par région).
2. Il n'y a **qu'une seule source de vérité** pour les données (un primaire PostgreSQL), avec des réplicas en lecture régionaux.
3. Il n'y a **pas de cluster Kubernetes** — la plateforme de conteneurs managée gère l'exécution sans couche d'orchestration visible/à opérer.

## Éléments à représenter

**Deux régions** (décision actée — "Région Europe" couvrant FR/DE/ES/IT/UK, "Région Amérique du Nord" couvrant CA/US ; pas de région AWS précise type `eu-west-1`/`us-east-1` à nommer, ce niveau de détail n'a pas été tranché) :

Dans **chaque région** :
- Un nœud **"Load balancer régional"** (ex. Application Load Balancer AWS), recevant le trafic entrant de la région.
- Un nœud **"Service applicatif (ECS/Fargate)"** contenant **N instances/tasks** du conteneur Docker du monolithe (représenter explicitement plusieurs instances, pour illustrer la redondance/absence de point de défaillance unique).
- Un nœud **"Service Tchat (ECS/Fargate)"**, séparé du service applicatif ci-dessus, avec son propre load balancer ou une route dédiée supportant les connexions persistantes (WebSocket).
- Un nœud **"PostgreSQL (Amazon RDS)"** :
  - Dans une seule région désignée comme région primaire : l'instance **primaire (lecture/écriture)**.
  - Dans l'autre région (et toute région supplémentaire) : un **réplica en lecture**.

**Au niveau global** (au-dessus des régions) :
- Un nœud **"Routage global (Amazon Route 53, routage par latence)"**, qui dirige chaque utilisateur vers le load balancer de la région la plus proche.
- Un nœud **"CDN + stockage statique"** (ex. Amazon S3 + CloudFront), **séparé du backend**, qui sert les fichiers statiques compilés du frontend Angular (SPA). Le frontend n'est pas déployé sur Fargate/ECS avec le backend — c'est un déploiement indépendant, mis en cache au plus près de l'utilisateur.

**Flux de déploiement** (CI/CD — peut être représenté comme un nœud/flux annexe plutôt qu'un nœud d'exécution) :
- Un nœud **"GitHub Actions"** (pipeline CI/CD) qui construit l'image Docker du monolithe, la pousse vers un registre de conteneurs (Amazon ECR), puis déclenche le déploiement vers le service applicatif de **chaque** région (même image partout).

**Hors des nœuds AWS** :
- **Client (navigateur)** → charge le frontend Angular depuis le CDN, puis envoie ses requêtes API au nœud de routage global.
- **Prestataire de paiement externe (Stripe)** → appelé depuis le service applicatif de n'importe quelle région (pas de nœud AWS, système tiers externe).

## Relations/flux à représenter

- Client → CDN + stockage statique (chargement du frontend Angular)
- Client → Routage global (HTTPS, appels API)
- Routage global → Load balancer régional (de la région la plus proche)
- Load balancer régional → instances du Service applicatif (répartition de charge intra-région)
- Service applicatif (chaque région) → PostgreSQL primaire (écritures, depuis n'importe quelle région)
- Service applicatif (chaque région) → PostgreSQL réplica local (lectures, en priorité depuis la région où se trouve le réplica)
- PostgreSQL primaire → PostgreSQL réplica(s) (réplication asynchrone)
- Service applicatif → Prestataire de paiement externe (HTTPS, appel sortant)
- Pipeline CI/CD → registre de conteneurs → Service applicatif de chaque région (flux de déploiement, à distinguer visuellement du trafic utilisateur, ex. flèche en pointillé ou couleur différente)
- Client → Service Tchat, potentiellement via un chemin WebSocket distinct (à illustrer si cela aide la lisibilité, sinon simplifier)

## Explicitement hors périmètre de ce diagramme

- Pas de détail sur les modules internes du monolithe (Utilisateurs, Réservations, Catalogue, Paiement) — c'est l'objet du diagramme de composants, dans un document séparé.
- Pas de VPC/sous-réseaux/sécurité réseau détaillée (NACL, security groups) — hors du niveau de détail demandé par la mission pour ce livrable.
- Pas de nom de région AWS réel (ex. `eu-west-1`) — resté générique, voir hypothèses ci-dessous.

## Points déjà validés avec l'utilisateur

- Le frontend Angular est servi par un **CDN séparé du backend** (ex. S3 + CloudFront) — déploiement indépendant, pas sur Fargate/ECS avec l'API.
- **2 régions** : Europe (FR/DE/ES/IT/UK) et Amérique du Nord (CA/US) — pas de granularité plus fine par pays.
- **Routage global : Amazon Route 53, routage par latence.**
- **Pipeline CI/CD : GitHub Actions**, cohérent avec le dépôt GitHub déjà requis pour la PoC tchat.

Il n'y a plus d'hypothèse ouverte sur ce diagramme — tous les choix de nommage/outillage sont actés ; Claude Design n'a qu'à dessiner la topologie décrite ci-dessus.

## Style attendu

Notation UML2 standard pour les diagrammes de déploiement (nœuds en boîte 3D `<<device>>`/`<<execution environment>>`, artefacts à l'intérieur des nœuds, associations de communication étiquetées). Faire ressortir visuellement la symétrie entre les deux régions (même artefact, même structure), et l'asymétrie primaire/réplica côté base de données.

## Légende à inclure dans le diagramme

Le diagramme doit comporter une légende explicite couvrant au minimum :
- La distinction entre **trafic utilisateur/applicatif** (flèches pleines) et **flux de déploiement CI/CD** (flèches pointillées ou couleur dédiée).
- La distinction visuelle entre l'instance **PostgreSQL primaire (lecture/écriture)** et les **réplicas en lecture**.
- La signification des nœuds en pointillé/boîte 3D (`<<execution environment>>` pour les services Fargate/ECS, `<<device>>` ou équivalent pour les éléments managés comme RDS, CloudFront).
- Une note indiquant que le **même artefact applicatif** (monolithe) tourne dans chaque région — ce n'est pas un service différent par région.
