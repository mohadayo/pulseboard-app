.PHONY: up down build test test-python test-go test-ts logs health

up:
	docker compose up -d --build

down:
	docker compose down

build:
	docker compose build

test: test-python test-go test-ts

test-python:
	cd services/api-gateway && pip install -q -r requirements.txt && pytest -v

test-go:
	cd services/metrics-worker && go test -v ./...

test-ts:
	cd services/dashboard-bff && npm install --silent && npm test

logs:
	docker compose logs -f

health:
	@echo "API Gateway:"; curl -s http://localhost:8000/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Metrics Worker:"; curl -s http://localhost:8001/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Dashboard BFF:"; curl -s http://localhost:8002/health | python3 -m json.tool 2>/dev/null || echo "  not running"
