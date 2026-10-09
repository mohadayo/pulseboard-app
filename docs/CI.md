# CI ワークフロー（CI）

このドキュメントは `.github/workflows/` 配下のワークフローを **横断的に** まとめた一次リファレンスです。各ワークフロー YAML のコメントは個別の実装理由を記していますが、ワークフロー間で共通する方針（権限最小化・`concurrency` キャンセル挙動・timeout）はここに集約します。

新規ワークフロー追加時はまず本ドキュメントの「新規追加時のチェックリスト」を確認してから作業してください。

## ワークフロー一覧

| ワークフロー | ファイル | 目的 | 主なトリガー | timeout | 主な権限 |
|---|---|---|---|---|---|
| `CI` | [`.github/workflows/ci.yml`](../.github/workflows/ci.yml) | 3 サービス（Python / Go / TypeScript）の lint / test と docker compose build | `push` / `pull_request` to `main` | job: 10m（docker-build のみ 20m） | `contents: read` |
| `Actionlint` | [`.github/workflows/actionlint.yml`](../.github/workflows/actionlint.yml) | `.github/workflows/*.yml` の静的検査（構文・式・shell） | `push` / `pull_request` を対象ワークフローファイル変更時 | 既定 | `contents: read` |
| `CodeQL` | [`.github/workflows/codeql.yml`](../.github/workflows/codeql.yml) | 3 言語の脆弱性静的解析（SAST） | `push` / `pull_request` to `main` + 週次スケジュール | 既定 | `contents: read` + `security-events: write` |

## 共通方針

### 権限は最小化（least privilege）

全ワークフローはトップレベル `permissions:` を宣言し、既定を `contents: read` に絞っています。これは OpenSSF Scorecard 準拠であり、依存 Action が侵害された際の blast radius を最小化するためです。

- `CI` / `Actionlint` は書き込みを一切行わないため `contents: read` のみで足りる
- `CodeQL` は SARIF をアップロードするため `security-events: write` を job レベルで追加している

**新規ワークフローを追加する際は**、まず `permissions: contents: read` から始めて、必要な権限のみを job レベルで `permissions:` ブロックに宣言してください（トップレベルを広げない）。

### 同一 ref で古いジョブはキャンセル

`CI` では `concurrency: { group: ${{ github.workflow }}-${{ github.ref }}, cancel-in-progress: true }` を宣言しています。PR に短時間で連続 push した場合に、進行中の古いジョブをキャンセルして実行枠・実行時間を節約します。

- PR 側（`refs/pull/<n>/merge`）と main 側（`refs/heads/main`）は別グループなので、main への merge で PR のジョブがキャンセルされることはない
- ローカル `make ci` にはこの挙動はないため、集中的に走らせたい時は手で中断する

### Timeout は妥当な上限で明示

`CI` の各テストジョブは `timeout-minutes: 10`、`docker-build` のみ `20`。これより長くなるテストは **ユニットの設計を見直す**（統合 / E2E は別パイプラインを検討）。

### 依存キャッシュを有効化

`CI` の各テストジョブは `setup-python` / `setup-go` / `setup-node` のキャッシュ機能を有効化しています（`cache: pip` / `cache: true` / `cache: npm`）。キャッシュキーは `requirements.txt` / `go.sum` / `package-lock.json` のハッシュに紐づくため、依存追加・更新時のみキャッシュが再生成されます。

## ジョブごとの詳細

### `test-python`

- Python 3.12 で `services/api-gateway/` を対象
- `pip install -r requirements.txt flake8` → `flake8` → `pytest`
- flake8 ルール: `--max-line-length=120 --exclude=__pycache__`

### `test-go`

- Go 1.22 で `services/metrics-worker/` を対象
- `go vet ./...` → `go test -v ./...`
- `cache: true` + `cache-dependency-path: services/metrics-worker/go.sum`

### `test-typescript`

- Node.js 20 で `services/dashboard-bff/` を対象
- `npm ci` → `npx tsc --noEmit` → `npm test`
- 型検査は build とは別に実施（build ステップがなくても型エラーで CI を落とす）

### `docker-build`

- 上記 3 ジョブに `needs:` で直列化
- `docker compose build` で全サービスのイメージをビルド
- 本番相当のビルドが壊れていないことを merge 前に確認する最終防波堤

## 新規ワークフロー追加時のチェックリスト

- [ ] `permissions:` をトップレベルで宣言し、既定を `contents: read` に絞る
- [ ] 書き込みが必要な場合は job 単位で `permissions:` を override する（トップレベルを広げない）
- [ ] `concurrency.group` と `cancel-in-progress: true` を宣言し、PR の高速連投で枠が溢れないようにする
- [ ] `timeout-minutes` を各ジョブに明示する（既定の 360 分は長すぎる）
- [ ] `uses:` の Action は **メジャーバージョンのタグ**（`@v4` 等）を指定する（コミット SHA 固定は Dependabot が維持する範囲で許容）
- [ ] `actionlint` のためにシェルスクリプトは `run: |` の中でクォート・エラー処理を適切に書く
- [ ] 可能なら `cache:` オプションを使って依存解決を再利用する
- [ ] 対応する `make <target>` と内容を揃え、ローカル再現性を担保する

## ローカルで CI を再現する

CI の `test-python` / `test-go` / `test-typescript` は Makefile の対応ターゲットで再現できます：

```sh
make ci       # lint + test の集約（CI と同じ構成）
make test     # test-python + test-go + test-ts
make lint     # lint-python + lint-go + lint-ts
```

CodeQL / Actionlint はローカル再現性より CI での検出を主としていますが、Actionlint のバイナリをローカルに入れれば `actionlint .github/workflows/*.yml` で同等の検査が可能です。

## 関連ドキュメント

- [`./TESTING.md`](./TESTING.md) — 3 言語テスト戦略の一次情報（テストの書き方・配置規約・カバレッジ）
- [`./TROUBLESHOOTING.md`](./TROUBLESHOOTING.md) — CI 失敗を含む運用上の切り分け手順
- [`../Makefile`](../Makefile) — ローカルで CI 相当を実行する `make ci` 等のターゲット定義
- [`../.github/workflows/`](../.github/workflows) — 本ドキュメントが対象とするワークフロー YAML の一次定義
