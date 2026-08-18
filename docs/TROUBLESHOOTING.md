# Troubleshooting

PulseBoard は Python(FastAPI) / Go / TypeScript(Express) の 3 サービスを Docker
Compose 上で協調動作させる構成です。このドキュメントはローカル / CI で
よく遭遇する症状を「症状 → 原因 → 対処」形式でまとめたものです。

参照している環境変数・エンドポイント・コマンドはすべて
[`README.md`](../README.md) / [`.env.example`](../.env.example) /
[`docker-compose.yml`](../docker-compose.yml) / [`Makefile`](../Makefile) に
実在する値に限定しています。ここに載っていない挙動を見つけたら
[`.github/ISSUE_TEMPLATE`](../.github/ISSUE_TEMPLATE) から Issue を立ててください。

---

## 1. まず最初に確認するコマンド

```bash
# 3 サービスの /health を叩いてサマリを表示（Makefile 定義）
make health

# コンテナの up / healthy / restarting を一覧
docker compose ps

# 特定サービスのログを追いかける（api-gateway / metrics-worker / dashboard-bff）
docker compose logs -f dashboard-bff
```

`make health` の各行が JSON を返せば当該サービスは起動済みかつ HTTP を受けられる
状態です。`  not running` と表示された行だけログを掘れば十分です。

---

## 2. 起動時のトラブル

### 2.1 ポートが既に使われている（`bind: address already in use`）

**症状**: `make up` / `docker compose up` の途中で `Bind for 0.0.0.0:8000
failed: port is already allocated` などのエラーで停止する。

**原因**: 既定のポート `8000` (API Gateway) / `8001` (Metrics Worker) /
`8002` (Dashboard BFF) のいずれかを別プロセスが掴んでいる。

**対処**: `.env` で個別のポートを上書きする。
[`docker-compose.yml`](../docker-compose.yml) は
`"${API_GATEWAY_PORT:-8000}:8000"` の形でホスト側ポートを差し込めるようになっている。

```dotenv
# .env
API_GATEWAY_PORT=18000
WORKER_PORT=18001
BFF_PORT=18002
```

コンテナ内部のポート (`8000` / `8001` / `8002`) は変更してはいけない。
`dashboard-bff` は Compose ネットワーク内部で `http://api-gateway:8000` /
`http://metrics-worker:8001` にアクセスするため、内部ポートを変えると
BFF からの内部呼び出しが 502 になる。

### 2.2 `.env` を作らずに `make up` を叩いた

**症状**: 起動はするが、意図した設定 (`LOG_LEVEL` / 各種 `MAX_*` 上限) が反映されない。

**原因**: [`.env.example`](../.env.example) の内容は自動では読まれない。
Docker Compose は `.env` のみを読み込む。

**対処**: 最初に必ず `cp .env.example .env` を実行する。README の Quick Start
にも記載がある通り、これが手順の 1 行目。

### 2.3 `docker compose` v2 と `docker-compose` v1

**症状**: `docker-compose: command not found` あるいは古い v1 と混在して
不可解なビルドエラーが出る。

**原因**: Compose CLI には旧 v1 (`docker-compose`) と新 v2 (`docker compose`)
がある。本リポジトリは [`Makefile`](../Makefile) / [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
のいずれでも v2 の `docker compose` を使う前提。

**対処**: v2 を利用可能な Docker Desktop / `docker-compose-plugin` を導入し、
`docker compose version` が動くことを確認してから `make up` する。

### 2.4 `dashboard-bff` がいつまでも起動しない

**症状**: `docker compose ps` で `dashboard-bff` が `Created` のまま進まない、
または `starting` のままログが動かない。

**原因**: [`docker-compose.yml`](../docker-compose.yml) の
`dashboard-bff.depends_on` は `condition: service_healthy` を指定しており、
`api-gateway` と `metrics-worker` の healthcheck がパスするまで起動しない。
どちらかの上流サービスが unhealthy のとき、BFF は永久待ちに見える。

**対処**: 上流のログを先に確認する。

```bash
docker compose ps                          # どれが unhealthy か
docker compose logs api-gateway            # 起動失敗の一次情報
docker compose logs metrics-worker
```

healthcheck 自体は `interval: 10s / retries: 3 / start_period: 5s` なので、
通常 30 秒程度で healthy になる。1 分以上待っても healthy にならなければ
上流の起動エラーを疑う。

---

## 3. サービス間の疎通ができない

**症状**: `dashboard-bff` のログに `ECONNREFUSED` / `getaddrinfo ENOTFOUND
api-gateway` などが出る。あるいは `POST /api/v1/dashboard/metrics` が
5xx を返す。

**原因**: BFF は Compose ネットワーク上のサービス名 (`api-gateway` /
`metrics-worker`) を DNS 経由で解決する。ホストマシンから `localhost:8000`
に届いていても、コンテナ内部からは別ネットワークになる。

**対処**:

1. [`.env.example`](../.env.example) の `API_GATEWAY_URL` /
   `WORKER_URL` を `localhost` に書き換えていないか確認する。
   Compose 起動時は `http://api-gateway:8000` / `http://metrics-worker:8001`
   のままにする。
2. `docker compose exec dashboard-bff wget -qO- http://api-gateway:8000/health`
   で BFF コンテナ内部から到達性を確認する。
3. ホスト側から検証したい場合は `.env` で公開ポートをずらして
   `curl http://localhost:${API_GATEWAY_PORT}/health` を叩く（`localhost`
   はホスト側でのみ有効）。

---

## 4. データが再起動で消える

**症状**: `make down` してから `make up` すると、投入したメトリクスが 0 件に戻る。

**原因**: 3 サービスとも in-memory ストア (`api-gateway` は
`metrics_store`、`dashboard-bff` は Node.js プロセス内の Map) を採用しており、
永続化バックエンドを持たない。プロセスが落ちればデータも消える。

**対処**: 現状は仕様。永続化が必要な検証ではデータ投入シナリオを
シェルスクリプト / テストとして再実行できる形にしておく。
`docker compose restart <svc>` でも当該サービスのメモリは初期化される
点に注意。

### 4.1 古いデータが勝手に消える（FIFO eviction）

**症状**: 大量にメトリクスを投入すると、古いものが黙って消えている。

**原因**: 同一 `name` あたりの保持件数には上限がある。
`api-gateway` は `MAX_METRICS_PER_NAME`（既定 `1000`）、`dashboard-bff` は
`MAX_DASHBOARD_METRICS`（既定 `10000`）を超えると FIFO で古い順に破棄する
（README の該当節参照）。

**対処**: `.env` で上限を引き上げるか、`0` 以下に設定して無効化する。
運用時のメモリ消費と引き換えになる点だけ注意。

---

## 5. リクエストが `413` / `422` / `400` で拒否される

### 5.1 `413 Request Entity Too Large`

`metrics-worker` の `/api/v1/aggregate` は次の 2 つの上限を持つ。
超過は `413` で拒否される（既定値と env は [`.env.example`](../.env.example) を参照）。

| Env | 既定 | 意味 |
|-----|------|------|
| `MAX_AGGREGATE_BODY_BYTES` | `1048576` (1 MiB) | リクエストボディ全体の最大バイト数 |
| `MAX_AGGREGATE_VALUES` | `10000` | `values` 配列の最大要素数 |

`dashboard-bff` は `express.json` の `MAX_REQUEST_BODY`（既定 `100kb`）を
超えると `413` を返す。どの上限も `0` 以下で無効化できるが、DoS 耐性を
落とすため本番運用では非推奨。

### 5.2 `422` / `400` バリデーションエラー

- `api-gateway` の POST `/api/v1/metrics`
  - `name` は 1〜128 文字の文字列。範囲外は `422`。
  - `value` は有限な数値のみ。`+Infinity` / `-Infinity` / `NaN` は `422`
    で拒否される（`1e500` は JSON としては合法だが Python で `inf` に
    解釈されるため）。
- `dashboard-bff` の POST `/api/v1/dashboard/metrics`
  - `name` は 1〜128 文字。範囲外は `400`。
  - `value` は `Number.isFinite` を満たす数値のみ。`Infinity` / `-Infinity`
    / `NaN` は `400`（`JSON.parse('1e500')` が `Infinity` を返すため
    `typeof === 'number'` だけでは抜けてしまう点に対応）。
- `dashboard-bff` の GET `/api/v1/dashboard/summary?limit=`
  - 範囲は `1`〜`MAX_SUMMARY_LIMIT`（既定 `500`）。整数以外や `0` 以下は `400`。
- `dashboard-bff` の GET `/api/v1/dashboard/metrics/names?since=&until=`
  - `since > until` あるいは ISO8601 として解釈できない値は `400`。

---

## 6. タイムアウトを調整したい

`metrics-worker` は Slowloris 等の遅延接続対策として HTTP サーバに
複数のタイムアウトを設定している。大きな入力を伴う統計処理で誤って切られる
場合は `.env` で緩められる（[`.env.example`](../.env.example) 参照）。

| Env | 既定 (秒) | 意味 |
|-----|-----------|------|
| `WORKER_READ_HEADER_TIMEOUT` | `5` | ヘッダ読み込み完了までの猶予 |
| `WORKER_READ_TIMEOUT` | `15` | リクエスト全体の読み込み猶予 |
| `WORKER_WRITE_TIMEOUT` | `15` | レスポンス書き込みの猶予 |
| `WORKER_IDLE_TIMEOUT` | `60` | Keep-Alive アイドル猶予 |

いずれも `0` 以下で無効化できる（テスト用途のみ推奨）。

---

## 7. ログが多い / 少ない

- `LOG_LEVEL`（既定 `INFO`）で出力レベルを切り替える。`api-gateway` /
  `metrics-worker` で運用を揃えている。
- `LOG_LEVEL=DEBUG` のときのみ `/health` へのアクセスログ
  （`Health check requested`）が出る。K8s の `livenessProbe` /
  `readinessProbe` やロードバランサの高頻度 probe でログを汚したくない
  ため、既定 (`INFO`) では抑止される。
- 集計ジョブ完了ログ（`Aggregation job #N completed: ...`）等の INFO レベル
  は `LOG_LEVEL` 未設定 / 不正値でも常時出る。

---

## 8. テストと CI

### 8.1 ローカルで個別に走らせる

[`Makefile`](../Makefile) にサービスごとのターゲットがある。

```bash
make test-python   # services/api-gateway で pytest -v
make test-go       # services/metrics-worker で go test -v ./...
make test-ts       # services/dashboard-bff で npm test
make test          # 上記 3 つを順に実行
```

Python 側は `pip install -q -r requirements.txt` を毎回実行する。
仮想環境を使う場合は事前に `venv` を activate してから叩く。

### 8.2 CI と同じ条件で lint / vet を回す

[`.github/workflows/ci.yml`](../.github/workflows/ci.yml) で走っているのと
同じコマンド。

```bash
# Python: flake8 の設定に注意
cd services/api-gateway && flake8 --max-line-length=120 --exclude=__pycache__ .

# Go: vet はテストとは別ジョブ
cd services/metrics-worker && go vet ./...
```

`--max-line-length=120` を付けない `flake8` はローカルで通っても CI で
落ちる（既定 `79` 文字）。同様に `go vet` はコンパイル失敗を早期に
拾うので、`go test` の前に単独で走らせると原因が絞りやすい。

### 8.3 `docker-build` ジョブが CI で失敗する

CI の `docker-build` ジョブは `test-python` / `test-go` / `test-typescript`
がすべてパスした後にのみ実行される。テストジョブのいずれかが赤い場合、
`docker-build` は skip されるので、まず先に上流ジョブのログを見る。

---

## 9. それでも解決しない場合

- [`.github/ISSUE_TEMPLATE`](../.github/ISSUE_TEMPLATE) から Bug Report を作成し、
  以下を添えて起票してください：
  - `docker compose version` / OS の種類
  - `docker compose ps` の出力
  - 対象サービスの直近 100 行程度のログ
  - 実行したコマンドと期待した結果
- サポート方針は [`.github/SUPPORT.md`](../.github/SUPPORT.md)、
  セキュリティ関連の報告手順は [`SECURITY.md`](../SECURITY.md) を参照してください。
