.PHONY: up down build test test-python test-go test-ts lint lint-python lint-go lint-ts ci logs health

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

lint: lint-python lint-go lint-ts

lint-python:
	cd services/api-gateway && pip install -q flake8 && flake8 --max-line-length=120 --exclude=__pycache__ .

lint-go:
	cd services/metrics-worker && go vet ./...

lint-ts:
	cd services/dashboard-bff && npm ci --silent && npx tsc --noEmit

ci: lint test

logs:
	docker compose logs -f

health:
	@echo "API Gateway:"; curl -s http://localhost:8000/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Metrics Worker:"; curl -s http://localhost:8001/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Dashboard BFF:"; curl -s http://localhost:8002/health | python3 -m json.tool 2>/dev/null || echo "  not running"
