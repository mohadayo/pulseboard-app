# syntax=docker/dockerfile:1

# ---------- Stage 1: builder ----------
FROM golang:1.22-alpine AS builder

WORKDIR /app
COPY go.mod .
COPY *.go .
# CGO を無効化してスタティックリンクした Linux バイナリを生成する。
# 実行イメージ (alpine) に glibc が入らなくても動くことを保証する。
RUN CGO_ENABLED=0 GOOS=linux go build -o metrics-worker .

# ---------- Stage 2: runtime ----------
FROM alpine:3.20

# コンテナ内プロセスを非 root で実行するための共通ユーザ。
# CIS Docker Benchmark 4.1 "Ensure that a user for the container has been created"
# に従い、root による特権実行を回避する。
# -D: パスワードなし, -H: ホームディレクトリを作らない, -s /sbin/nologin: シェル無効
RUN adduser -D -H -s /sbin/nologin app

WORKDIR /app
COPY --from=builder --chown=app:app /app/metrics-worker .

# 以降のプロセスは非 root ユーザで実行する。
USER app

EXPOSE 8001

CMD ["./metrics-worker"]
