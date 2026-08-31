# 設定リファレンス (Configuration)

Pulseboard アプリで使用するすべての環境変数を、サービス単位で整理したリファレンスです。
実際のサンプルは [`.env.example`](../.env.example) を参照してください。本ドキュメントは「意味・既定値・チューニング指針」を集約する位置付けです。

## 1. サービス別の環境変数早見表

| 変数                            | 消費サービス            | 種別   |
| ------------------------------- | ----------------------- | ------ |
| `API_GATEWAY_PORT`              | api-gateway             | ポート |
| `LOG_LEVEL`                     | api-gateway             | 動作   |
| `MAX_METRICS_PER_NAME`          | api-gateway             | 上限   |
| `METRICS_DEFAULT_LIMIT`         | api-gateway             | 上限   |
| `METRICS_MAX_LIMIT`             | api-gateway             | 上限   |
| `WORKER_PORT`                   | metrics-worker          | ポート |
| `MAX_AGGREGATE_BODY_BYTES`      | metrics-worker          | 上限   |
| `MAX_AGGREGATE_VALUES`          | metrics-worker          | 上限   |
| `WORKER_READ_HEADER_TIMEOUT`    | metrics-worker          | セキュリティ |
| `WORKER_READ_TIMEOUT`           | metrics-worker          | セキュリティ |
| `WORKER_WRITE_TIMEOUT`          | metrics-worker          | セキュリティ |
| `WORKER_IDLE_TIMEOUT`           | metrics-worker          | セキュリティ |
| `BFF_PORT`                      | dashboard-bff           | ポート |
| `API_GATEWAY_URL`               | dashboard-bff           | 接続先 |
| `WORKER_URL`                    | dashboard-bff           | 接続先 |
| `MAX_DASHBOARD_METRICS`         | dashboard-bff           | 上限   |
| `MAX_REQUEST_BODY`              | dashboard-bff           | 上限   |
| `MAX_SUMMARY_LIMIT`             | dashboard-bff           | 上限   |

## 2. api-gateway

- **`API_GATEWAY_PORT`** — 待ち受けポート番号。既定 `8000`。
- **`LOG_LEVEL`** — ログレベル。既定 `INFO`。`DEBUG` / `WARNING` / `ERROR` を状況に応じて設定。
- **`MAX_METRICS_PER_NAME`** — メトリクス名 1 件あたりインメモリ保持できるサンプル数の上限。超過分は先頭 (FIFO) から破棄される。**`0` 以下で無制限**。既定 `1000`。
  - 大きくしすぎるとメモリ増加。減らしすぎると古いサンプルが即座に消えるので集約 API の対象範囲が狭まる。
- **`METRICS_DEFAULT_LIMIT`** — `GET /api/v1/metrics` の既定ページサイズ。既定 `100`。
- **`METRICS_MAX_LIMIT`** — `GET /api/v1/metrics` の `limit` パラメータの上限。既定 `1000`。上限を超えるリクエストは 400 で拒否される。

## 3. metrics-worker

- **`WORKER_PORT`** — 待ち受けポート番号。既定 `8001`。
- **`MAX_AGGREGATE_BODY_BYTES`** — `/api/v1/aggregate` のリクエストボディ最大バイト数。**`0` 以下で無効化**。既定 `1048576` (1 MiB)。
- **`MAX_AGGREGATE_VALUES`** — `values` 配列の最大要素数。**`0` 以下で無効化**。既定 `10000`。
- **`WORKER_READ_HEADER_TIMEOUT`** — HTTP リクエストヘッダを読み終えるまでの秒数上限。既定 `5`。**Slowloris 系の攻撃対策**として短めが推奨。
- **`WORKER_READ_TIMEOUT`** — リクエスト全体を読み終えるまでの秒数上限。既定 `15`。
- **`WORKER_WRITE_TIMEOUT`** — レスポンス書き出しの秒数上限。既定 `15`。
- **`WORKER_IDLE_TIMEOUT`** — Keep-Alive 接続のアイドル秒数上限。既定 `60`。

> セキュリティ推奨: `WORKER_READ_HEADER_TIMEOUT` は本番でも 10 秒以下、`WORKER_READ_TIMEOUT` は 30 秒以下に留めることを推奨します。長すぎるとリソース占有攻撃を許容しやすくなります。

## 4. dashboard-bff

- **`BFF_PORT`** — 待ち受けポート番号。既定 `8002`。
- **`API_GATEWAY_URL`** — api-gateway への接続先 URL。既定 `http://api-gateway:8000`。Docker Compose のサービス名で解決される。
- **`WORKER_URL`** — metrics-worker への接続先 URL。既定 `http://metrics-worker:8001`。
- **`MAX_DASHBOARD_METRICS`** — ダッシュボードストアの保持件数上限。超過分は FIFO で破棄。**`0` 以下で無制限**。既定 `10000`。
- **`MAX_REQUEST_BODY`** — `express.json` のリクエストボディ上限。文字列指定 (`100kb` / `1mb` 等)。既定 `100kb`。
- **`MAX_SUMMARY_LIMIT`** — `GET /api/v1/dashboard/summary` の `limit` 上限。既定 `500`。

## 5. セキュリティ推奨設定まとめ

以下は本番運用時に見直すことを強く推奨するパラメータ群です。

| 変数                            | 推奨方針                                       |
| ------------------------------- | ---------------------------------------------- |
| `WORKER_READ_HEADER_TIMEOUT`    | 5〜10 秒。Slowloris 対策として短めに          |
| `WORKER_READ_TIMEOUT`           | 15〜30 秒                                      |
| `MAX_AGGREGATE_BODY_BYTES`      | ユースケースに合わせ最小値へ。**必ず有効化**   |
| `MAX_AGGREGATE_VALUES`          | ユースケースに合わせ最小値へ                   |
| `MAX_REQUEST_BODY`              | 数百 KB 以内に抑えるのが原則                   |

## 6. 変更ポリシー

- `.env.example` に新しい変数を追加する場合は本ドキュメントにも追記してください（PR レビューで確認）。
- 既定値や上限を変更する場合、影響範囲を PR 本文に必ず記載してください。

## 7. 関連ドキュメント

- [`.env.example`](../.env.example) — 実サンプル値
- [`docs/architecture.md`](./architecture.md) — サービス間関係とデプロイ構成
- [`docs/RUNBOOK.md`](./RUNBOOK.md) — 運用ランブック
- [`docs/TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — 症状別トラブルシュート
- [`SECURITY.md`](../SECURITY.md) — 脆弱性報告
