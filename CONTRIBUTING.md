# Contributing to PulseBoard

PulseBoard へのコントリビュートに興味を持っていただきありがとうございます。
本ドキュメントは、このリポジトリでの開発フロー・ローカル動作確認手順・PR / Issue の
運用ルールをまとめたハンドブックです。

まずはコミュニティの [行動規範 (`CODE_OF_CONDUCT.md`)](./CODE_OF_CONDUCT.md) をご一読ください。
すべてのコントリビューター・レビュアーはこの規範に従うことが期待されます。

---

## 1. リポジトリ構成

このリポジトリは 3 言語混在のマイクロサービスモノレポです。

```
pulseboard-app/
├── docker-compose.yml
├── Makefile
├── .env.example
├── .github/workflows/ci.yml
├── services/
│   ├── api-gateway/     # Python 3.12 (FastAPI)   :8000
│   ├── metrics-worker/  # Go 1.22                 :8001
│   └── dashboard-bff/   # TypeScript / Node 20    :8002
├── README.md
├── SECURITY.md
├── CODE_OF_CONDUCT.md
└── LICENSE              # MIT
```

各サービスの責務・API 仕様は [`README.md`](./README.md) を参照してください。

---

## 2. 開発環境の前提

以下のいずれかを想定しています。

- **Docker 開発** (推奨): Docker Engine 24+ / Docker Compose v2 のみ
- **サービス単体でのローカル開発**:
  - Python 3.12 以上
  - Go 1.22 以上
  - Node.js 20 以上 (npm 同梱)

`.env.example` を `.env` にコピーすることで既定の環境変数がロードされます。

```bash
cp .env.example .env
```

---

## 3. ローカルセットアップ

### 3.1 全サービス起動

```bash
make up          # docker compose up -d --build
make health      # 3 サービスの /health を確認
```

### 3.2 停止 / ログ確認

```bash
make down        # docker compose down
make logs        # docker compose logs -f
```

### 3.3 ビルドのみ

```bash
make build       # docker compose build
```

---

## 4. テスト・静的解析

### 4.1 一括実行

```bash
make test        # Python / Go / TypeScript のテストを順に実行
```

### 4.2 サービス個別 (CI と同一コマンド)

#### Python (api-gateway)

```bash
cd services/api-gateway
pip install -r requirements.txt flake8
flake8 --max-line-length=120 --exclude=__pycache__ .
pytest -v
```

Makefile ショートカット:

```bash
make test-python
```

#### Go (metrics-worker)

```bash
cd services/metrics-worker
go vet ./...
go test -v ./...
```

Makefile ショートカット:

```bash
make test-go
```

#### TypeScript (dashboard-bff)

```bash
cd services/dashboard-bff
npm ci
npm test
```

Makefile ショートカット:

```bash
make test-ts
```

### 4.3 CI での実行

`.github/workflows/ci.yml` が `main` へのすべての push / pull_request で
以下のジョブを実行します。

1. `test-python` — `flake8` + `pytest`
2. `test-go` — `go vet` + `go test`
3. `test-typescript` — `jest` (npm test)
4. `docker-build` — 3 サービス揃った `docker compose build` 検証
   （1〜3 が全て緑になった後に実行）

**PR を出す前に、変更対象サービスのローカルテストが緑であることを必ず確認してください。**

---

## 5. ブランチ運用とコミットメッセージ

### 5.1 ブランチ命名

- 直接 `main` にコミットしない
- ブランチ名は次のプレフィクスを目安に付けます
  - `feat/<short-topic>` — 新機能
  - `fix/<short-topic>` — バグ修正
  - `docs/<short-topic>` — ドキュメント
  - `chore/<short-topic>` — 雑務 (依存更新・設定・CI)
  - `refactor/<short-topic>` — 挙動変更なしの内部改善
  - `test/<short-topic>` — テスト追加・改善のみ

### 5.2 コミットメッセージ

- 1 行目にプレフィクス付きの要約を書きます（日本語可）
  - 例: `feat(api-gateway): /api/v1/metrics/by_month を追加`
  - 例: `fix(dashboard-bff): 不正な JSON ボディで 400 を返す`
  - 例: `docs: README の API リファレンス表を更新`
- プレフィクスは概ね次を使います
  - `feat:` / `fix:` / `docs:` / `chore:` / `refactor:` / `test:` / `ci:` / `perf:`
- スコープは `(api-gateway)` / `(dashboard-bff)` / `(metrics-worker)` / `(ci)` / `(docs)` 等
- 本文で「なぜ変更したか」「影響範囲」「注意点」を補足します

---

## 6. Pull Request の作り方

1. `main` を最新に更新してからブランチを切ります
2. 変更に対応するテストを追加します（ドキュメントのみの場合は不要）
3. ローカルで [§4 テスト・静的解析](#4-テスト静的解析) を実行し、緑を確認します
4. **Draft PR** で作成することを推奨します（レビュー準備が整ってから "Ready for review" に切り替え）
5. `.github/PULL_REQUEST_TEMPLATE.md` のセクションに沿って記述してください
   - 変更概要 / 変更内容の詳細 / 対応 Issue (`Closes #N`) / 影響範囲 / 動作確認手順 / リスク・注意点 / チェックリスト
6. `.github/CODEOWNERS` に基づいて自動的にレビュアーがアサインされます
7. CI が全ジョブ緑になってからレビュー依頼を出してください
8. Squash マージを既定とし、マージコミットメッセージはプレフィクス規約に揃えます

### PR に含めない方が良いもの

- 無関係な自動フォーマット差分（`.editorconfig` / `.gitattributes` が既に整えるべき範囲）
- 生成物 (`node_modules/` / `__pycache__/` / ビルド成果物) — `.gitignore` により通常は除外済み
- 秘匿情報を含む `.env`（`.env.example` のみコミット可）

---

## 7. Issue の起票

Issue は `.github/ISSUE_TEMPLATE/` に用意されたテンプレートから作成してください。

- **バグ報告**: `bug_report.md` — 再現手順・期待動作・実際の動作・環境情報
- **機能提案**: `feature_request.md` — 動機・提案内容・代替案・影響範囲

`.github/ISSUE_TEMPLATE/config.yml` により **blank issue は無効化** されており、
テンプレートを経由しない起票はできません。

### セキュリティに関わる報告

セキュリティ問題は公開 Issue ではなく [`SECURITY.md`](./SECURITY.md) の
手順に従って報告してください（GitHub Security Advisories 経由での非公開報告を推奨）。

---

## 8. ライセンス

このリポジトリは [MIT License](./LICENSE) の下で公開されています。
コントリビュートしていただいたコード・ドキュメントは、同じ MIT License の下で
配布されることに同意したものとみなされます。

---

## 9. 質問・相談

- 使い方・仕様に関する質問: `feature_request.md` テンプレートで「質問」として起票
- コントリビュートフロー自体への改善提案: 本ファイル (`CONTRIBUTING.md`) を対象にした
  PR / Issue で歓迎します

コントリビュートありがとうございます。
