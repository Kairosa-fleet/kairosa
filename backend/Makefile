VENV := ../.venv/bin
export JWT_SECRET ?= dev-secret-key-at-least-32-characters-long!!

.PHONY: help up down dev test lint fmt migrate revision smoke

help:
	@grep -E '^[a-z-]+:.*?##' $(MAKEFILE_LIST) | sed 's/:.*##/\t-/'

up:              ## Start Postgres + Redis
	cd .. && docker compose up -d

down:            ## Stop containers
	cd .. && docker compose down

dev:             ## Run the API with autoreload
	$(VENV)/uvicorn app.main:app --reload --port 8000

migrate:         ## Apply migrations
	$(VENV)/alembic upgrade head

revision:        ## Autogenerate a migration: make revision m="message"
	$(VENV)/alembic revision --autogenerate -m "$(m)"

test:            ## Run the full test suite
	$(VENV)/pytest -v

lint:            ## Lint
	$(VENV)/ruff check app tests

fmt:             ## Format + autofix
	$(VENV)/ruff format app tests && $(VENV)/ruff check --fix app tests

smoke:           ## End-to-end smoke test against a running server
	$(VENV)/python scripts/smoke_test.py
