# Your Car Your Way — chat PoC

[![ci](../../actions/workflows/ci.yml/badge.svg)](../../actions/workflows/ci.yml)
[![chaos](../../actions/workflows/chaos.yml/badge.svg)](../../actions/workflows/chaos.yml)

[Français](#français) · [English](#english)

---

## Français

> Squelette — le contexte, le schéma d'architecture, le scénario de démo, les ADR et la liste de ce
> qui est hors périmètre seront complétés au fil du PoC.

### Prérequis

- Docker 29+ avec Docker Compose 2.40+
- Java 21 (le build passe par le Maven Wrapper `./mvnw`, aucun Maven installé n'est nécessaire)
- Node 24 (fichier `.nvmrc`) : `nvm install 24 && nvm use`. Sans Node 24 local, `make test-frontend`
  lance npm dans un conteneur `node:24` ; `make chaos` et `make e2e` exigent Node 24 sur la machine.
- `make`

### Lancer le projet

Tout passe par le `Makefile` racine (`make help` liste toutes les cibles) :

```bash
make up          # construit les images puis démarre toute la pile ; attend que tout soit "healthy"
                 # → http://localhost:8080
make logs        # suit les logs (make logs S=chat-1 pour un seul service)
make down        # arrête la pile (la base est conservée)
make clean       # supprime pile, volume, images locales et sorties de build
```

Démo « tuer une instance » :

```bash
make kill-1      # tue chat-1 (instance du client)
make start-1     # redémarre chat-1 et attend qu'il soit prêt
```

Tests :

```bash
make test        # ./mvnw verify (unitaires + Testcontainers) + Vitest chat-web + vérifications unitaires du client de chaos
make e2e         # Playwright + axe contre la pile lancée (make up d'abord)
make chaos       # test de chaos (kill/start des instances) ; GATE_LATENCY=1 pour vérifier p95 < 300 ms
make chaos-region  # variante O10 : BD de chat-2 via toxiproxy +80 ms ; phase stable + exactitude, sans kill, p95 rapporté
```

Base de données : aucun `psql` local n'est nécessaire, `make psql` ouvre psql **dans le conteneur
Postgres** sur la base `chat` (`docker compose exec postgres psql -U chat -d chat`).

Plusieurs piles en parallèle : `COMPOSE_PROJECT_NAME=demo2 HTTP_PORT=18080 POSTGRES_PORT=55433 make up`.

### Topologie locale

| Service | Rôle (équivalent cible) |
|---|---|
| `nginx` (1.28) | répartiteur round-robin `/ws` + `/api` vers chat-1/chat-2 (ALB) et sert chat-web ; `/ws-a`, `/ws-b` : chemins de démo épinglés sur chat-1 / chat-2 |
| `chat-1`, `chat-2` | deux instances du service de chat (Fargate) |
| `auth-stub` | émetteur de jetons de développement (`/dev/tokens`), simule le monolithe |
| `postgres` (17) | base `chat` propre au service (RDS) |
| `jwt-keys` (ponctuel) | génère une fois la paire RSA de développement (volume `jwt-keys`) : clé privée → auth-stub, clé publique → chat-1/chat-2 (configuration, pas d'appel à l'émetteur) |
| `toxiproxy` (profil `chaos`) | latence simulée entre chat-2 et la base (variante transatlantique) |

---

## English

> Skeleton — context, architecture diagram, demo script, ADRs and the out-of-scope list will be
> filled in as the PoC progresses.

### Prerequisites

- Docker 29+ with Docker Compose 2.40+
- Java 21 (builds use the Maven Wrapper `./mvnw`; no Maven install needed)
- Node 24 (`.nvmrc`): `nvm install 24 && nvm use`. Without a local Node 24, `make test-frontend`
  runs npm in a `node:24` container; `make chaos` and `make e2e` need Node 24 on the host.
- `make`

### Running

Everything goes through the root `Makefile` (`make help` lists every target):

```bash
make up          # build images, start the whole stack, wait until every service is healthy
                 # → http://localhost:8080
make logs        # follow logs (make logs S=chat-1 for one service)
make down        # stop the stack (database volume kept)
make clean       # remove stack, volume, local images and build outputs
```

Kill-an-instance demo:

```bash
make kill-1      # kill chat-1 (the customer's instance)
make start-1     # start chat-1 again and wait until it is ready
```

Tests:

```bash
make test        # ./mvnw verify (unit + Testcontainers) + chat-web Vitest + chaos client unit checks
make e2e         # Playwright + axe against the running stack (make up first)
make chaos       # chaos run (kills/starts instances); GATE_LATENCY=1 also gates p95 < 300 ms
make chaos-region  # O10 variant: chat-2's DB through toxiproxy +80 ms; steady phase + correctness, no kills, p95 reported
```

Database: no local `psql` needed — `make psql` runs psql **inside the Postgres container** on the
`chat` database (`docker compose exec postgres psql -U chat -d chat`).

Parallel stacks: `COMPOSE_PROJECT_NAME=demo2 HTTP_PORT=18080 POSTGRES_PORT=55433 make up`.

### Local topology

| Service | Role (target equivalent) |
|---|---|
| `nginx` (1.28) | round-robin `/ws` + `/api` to chat-1/chat-2 (ALB) and serves chat-web; `/ws-a`, `/ws-b` are demo-only paths pinned to chat-1 / chat-2 |
| `chat-1`, `chat-2` | two chat service instances (Fargate) |
| `auth-stub` | dev-only token issuer (`/dev/tokens`) standing in for the monolith |
| `postgres` (17) | the service's own `chat` database (RDS) |
| `jwt-keys` (one-shot) | generates the dev-only RSA keypair once (`jwt-keys` volume): private key → auth-stub, public key → chat-1/chat-2 (config, no call to the issuer) |
| `toxiproxy` (profile `chaos`) | simulated latency between chat-2 and the database (cross-region variant) |

### Repository layout

```
chat-service/   Spring Boot 4.1 (Java 21): STOMP /ws, REST, Flyway, JDBC, LISTEN/NOTIFY fan-out
auth-stub/      dev-only RS256 token issuer
chat-web/       Angular 22 app (Vitest unit tests)
chaos/          Node 24 chaos client
e2e/            Playwright + axe
infra/          docker-compose.yml, nginx.conf, toxiproxy config, Postgres init
docs/adr/       architecture decision records
.github/workflows/  ci.yml, chaos.yml
```
