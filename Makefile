# Single entry point for the ycyw chat PoC. `make help` lists every target.
#
# Overridable variables (environment or `make VAR=value`):
#   COMPOSE_PROJECT_NAME  compose project (default ycyw-chat); use a unique name per parallel stack
#   HTTP_PORT             nginx host port (default 8080)
#   POSTGRES_PORT         Postgres host port on 127.0.0.1 (default 55432)
#   TOXIPROXY_API_PORT    toxiproxy API host port (default 8474)
#   REGION_LATENCY_MS     latency added to chat-2's DB connections by chaos-region (default 80)
#   GATE_LATENCY=1        also gate steady-phase p95 < 300 ms in `make chaos` (O5)

SHELL := /bin/bash
.DEFAULT_GOAL := help

export COMPOSE_PROJECT_NAME ?= ycyw-chat
export HTTP_PORT ?= 8080
export POSTGRES_PORT ?= 55432
export TOXIPROXY_API_PORT ?= 8474
REGION_LATENCY_MS ?= 80

COMPOSE_FILE := infra/docker-compose.yml
export COMPOSE_FILE
COMPOSE := docker compose -f $(COMPOSE_FILE)
BASE_URL := http://localhost:$(HTTP_PORT)
export BASE_URL

# Node 24 is required (.nvmrc). Order: node on PATH if it is 24.x, else the newest nvm-installed
# 24.x, else (unit tests only) npm inside a node:24 container — same glibc platform as the host, so
# node_modules stay interchangeable. chaos/e2e drive docker and browsers from the host: they need a
# host Node 24.
NODE_MAJOR := $(shell node -v 2>/dev/null | sed -E 's/^v([0-9]+).*/\1/')
NVM_NODE24 := $(lastword $(sort $(wildcard $(HOME)/.nvm/versions/node/v24.*/bin)))
ifeq ($(NODE_MAJOR),24)
HOST_NODE24 := 1
else ifneq ($(NVM_NODE24),)
export PATH := $(NVM_NODE24):$(PATH)
HOST_NODE24 := 1
endif
ifdef HOST_NODE24
NPM := npm
else
NPM := docker run --rm -u $(shell id -u):$(shell id -g) -e HOME=/tmp -e CI=true -e NG_CLI_ANALYTICS=false \
	-v $(CURDIR):/repo -w /repo node:24-slim npm
endif
REQUIRE_HOST_NODE24 = $(if $(HOST_NODE24),,$(error This target needs Node 24 on the host: nvm install 24 && nvm use))

CHAOS_ARGS := $(if $(filter 1 true yes,$(GATE_LATENCY)),-- --gate-latency,)

.PHONY: help up down logs ps build test test-backend test-frontend lint-frontend e2e chaos chaos-region \
	kill-1 kill-2 start-1 start-2 psql clean

help: ## List targets
	@awk 'BEGIN {FS = ":.*## "; printf "Usage: make <target> [VAR=value]\n\nTargets:\n"} \
		/^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@printf "\nProject: %s   nginx: %s\n" "$(COMPOSE_PROJECT_NAME)" "$(BASE_URL)"

## ---- Stack -------------------------------------------------------------------

up: ## Build images if needed and start the whole stack; waits until every service is healthy
	$(COMPOSE) up -d --build --wait
	@echo "Stack up: $(BASE_URL)  (customer: $(BASE_URL)/?node=a  agent: $(BASE_URL)/agent?node=b)"

down: ## Stop and remove the stack's containers (keeps the database volume)
	$(COMPOSE) --profile chaos down --remove-orphans

logs: ## Follow logs of all services (or one: make logs S=chat-1)
	$(COMPOSE) logs -f --tail=200 $(S)

ps: ## Show service status and health
	$(COMPOSE) --profile chaos ps

build: ## Build all Docker images (chat-service, auth-stub, chat-web/nginx)
	$(COMPOSE) build

## ---- Tests -------------------------------------------------------------------

test: test-backend test-frontend ## Run all unit + integration tests (Maven verify + chat-web Vitest)

test-backend: ## ./mvnw verify: unit tests + Testcontainers integration tests (needs Docker)
	./mvnw -B verify

test-frontend: chat-web/node_modules ## chat-web lint + Vitest unit tests (Node 24)
	$(NPM) --prefix chat-web run lint
	$(NPM) --prefix chat-web run test:ci

lint-frontend: chat-web/node_modules ## chat-web lint only
	$(NPM) --prefix chat-web run lint

chat-web/node_modules: chat-web/package-lock.json
	$(NPM) --prefix chat-web ci --no-audit --no-fund
	@touch $@

e2e: ## Playwright E2E + axe against the running stack (run `make up` first)
	$(REQUIRE_HOST_NODE24)
	npm --prefix e2e ci --no-audit --no-fund
	cd e2e && npx playwright install $(if $(CI),--with-deps,) chromium
	npm --prefix e2e test

## ---- Chaos -------------------------------------------------------------------

chaos: ## Chaos run against the running stack (kills/starts chat-1/chat-2); GATE_LATENCY=1 gates p95
	$(REQUIRE_HOST_NODE24)
	npm --prefix chaos ci --no-audit --no-fund
	CHAOS_VARIANT=default npm --prefix chaos run chaos $(CHAOS_ARGS)

chaos-region: ## O10 variant: chat-2's DB via toxiproxy +REGION_LATENCY_MS (80) ms, then chaos run (p95 reported, not gated)
	$(REQUIRE_HOST_NODE24)
	$(COMPOSE) --profile chaos up -d --wait toxiproxy
	CHAT2_DB_URL=jdbc:postgresql://toxiproxy:15432/chat \
	CHAT2_LISTENER_JDBC_URL='jdbc:postgresql://toxiproxy:15433/chat?socketTimeout=10&tcpKeepAlive=true' \
		$(COMPOSE) --profile chaos up -d --wait --no-deps chat-2
	@for p in chat2-pool chat2-listener; do \
		curl -sf -X DELETE http://127.0.0.1:$(TOXIPROXY_API_PORT)/proxies/$$p/toxics/region-latency >/dev/null || true; \
		curl -sf -X POST http://127.0.0.1:$(TOXIPROXY_API_PORT)/proxies/$$p/toxics \
			-H 'Content-Type: application/json' \
			-d '{"name":"region-latency","type":"latency","stream":"downstream","attributes":{"latency":$(REGION_LATENCY_MS),"jitter":0}}' >/dev/null \
			&& echo "toxiproxy: +$(REGION_LATENCY_MS) ms on $$p"; \
	done
	npm --prefix chaos ci --no-audit --no-fund
	CHAOS_VARIANT=region npm --prefix chaos run chaos
	@echo "chat-2 still routes through toxiproxy; run 'make up' to restore the direct connection."

## ---- Demo helpers --------------------------------------------------------------

kill-1: ## docker kill chat-1 (demo: kill the customer's instance)
	$(COMPOSE) kill chat-1

kill-2: ## docker kill chat-2
	$(COMPOSE) kill chat-2

start-1: ## Start chat-1 again and wait until it is ready
	$(COMPOSE) up -d --wait --no-deps chat-1

start-2: ## Start chat-2 again and wait until it is ready
	$(COMPOSE) up -d --wait --no-deps chat-2

psql: ## psql shell on the chat database (inside the Postgres container; no local psql needed)
	$(COMPOSE) exec postgres psql -U chat -d chat

## ---- Cleanup -------------------------------------------------------------------

clean: ## Remove stack, volumes, local images and build outputs
	-$(COMPOSE) --profile chaos down -v --remove-orphans --rmi local
	-./mvnw -q clean
	rm -rf chat-web/dist chat-web/.angular e2e/playwright-report e2e/test-results chaos/results
