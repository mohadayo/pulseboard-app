# syntax=docker/dockerfile:1

FROM node:20-alpine

WORKDIR /app

# --chown=node:node で /app 配下の所有権をプリセットの node ユーザに移す。
# CIS Docker Benchmark 4.1 に従い、以降のプロセスは非 root で実行する。
COPY --chown=node:node package.json package-lock.json* ./
RUN npm install

COPY --chown=node:node . .
RUN npm run build

# node:20-alpine にプリセットされている非 root ユーザで実行する。
USER node

EXPOSE 8002

CMD ["node", "dist/index.js"]
