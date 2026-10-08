.PHONY: help up down build test test-python test-go test-ts lint lint-python lint-go lint-ts ci logs health

.DEFAULT_GOAL := help

help:  ## このヘルプメッセージを表示する
	@awk 'BEGIN {FS = ":.*?## "; printf "使用方法: make \033[36m<target>\033[0m\n\n利用可能なターゲット:\n"} /^[a-zA-Z_-]+:.*?## / {printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)

up:  ## 全サービスをビルドしてバックグラウンドで起動する
	docker compose up -d --build

down:  ## 全サービスを停止する
	docker compose down

build:  ## 全サービスのイメージをビルドする
	docker compose build

test: test-python test-go test-ts  ## 全言語のテストを実行する

test-python:  ## api-gateway (Python) のテストを実行する
	cd services/api-gateway && pip install -q -r requirements.txt && pytest -v

test-go:  ## metrics-worker (Go) のテストを実行する
	cd services/metrics-worker && go test -v ./...

test-ts:  ## dashboard-bff (TypeScript) のテストを実行する
	cd services/dashboard-bff && npm install --silent && npm test

lint: lint-python lint-go lint-ts  ## 全言語の lint を実行する

lint-python:  ## api-gateway (Python) に flake8 を実行する
	cd services/api-gateway && pip install -q flake8 && flake8 --max-line-length=120 --exclude=__pycache__ .

lint-go:  ## metrics-worker (Go) に go vet を実行する
	cd services/metrics-worker && go vet ./...

lint-ts:  ## dashboard-bff (TypeScript) に tsc --noEmit を実行する
	cd services/dashboard-bff && npm ci --silent && npx tsc --noEmit

ci: lint test  ## CI 相当の処理（lint + test）をローカルで実行する

logs:  ## 全サービスのログをフォローする
	docker compose logs -f

health:  ## 各サービスの /health エンドポイントを確認する
	@echo "API Gateway:"; curl -s http://localhost:8000/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Metrics Worker:"; curl -s http://localhost:8001/health | python3 -m json.tool 2>/dev/null || echo "  not running"
	@echo "Dashboard BFF:"; curl -s http://localhost:8002/health | python3 -m json.tool 2>/dev/null || echo "  not running"
