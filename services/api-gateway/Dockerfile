# syntax=docker/dockerfile:1

FROM python:3.12-slim

# コンテナ内プロセスを非 root で実行するための共通ユーザ (UID 1000)。
# CIS Docker Benchmark 4.1 "Ensure that a user for the container has been created"
# に従い、root による特権実行を回避する。
RUN groupadd --system --gid 1000 app \
    && useradd --system --uid 1000 --gid app --home /app --shell /sbin/nologin app

WORKDIR /app

# 依存インストールは root のまま実行 (パッケージインストールに書き込み権限が要る)。
# --chown で /app 配下の所有権を app ユーザに移し、コピー段階以降は app として動く。
COPY --chown=app:app requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app . .

# 以降のプロセスは非 root ユーザで実行する。
USER app

EXPOSE 8000

CMD ["uvicorn", "app:app", "--host", "0.0.0.0", "--port", "8000"]
