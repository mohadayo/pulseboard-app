# FAQ (よくある質問)

PulseBoard (`api-gateway` / `metrics-worker` / `dashboard-bff`) の利用・
開発でよく寄せられる質問をまとめています。

- 全体構成: [architecture.md](./architecture.md)
- 個別の問題への対処: [TROUBLESHOOTING.md](./TROUBLESHOOTING.md)

## プロジェクトについて

### Q. PulseBoard とは何ですか？

複数の microservice / SaaS のメトリクスを集約してリアルタイム
ダッシュボードに表示するプラットフォームです。3 つのサービスで構成されます:

- **api-gateway** (Python): 外部リクエストの入口
- **metrics-worker** (Go): 各種メトリクスを収集・集計する非同期ワーカ
- **dashboard-bff** (TypeScript): ダッシュボード UI 用の BFF

詳細は [architecture.md](./architecture.md) を参照してください。

### Q. 対象ユーザは？

自社インフラや SaaS 群を単一ダッシュボードで俯瞰したいプロダクト開発
チーム / SRE を想定しています。認証つきの社内利用を前提としており、
一般公開 SaaS ではありません。

## セットアップについて

### Q. ローカルで起動するには？

```sh
cp .env.example .env
docker compose up -d
```

これで 3 サービスすべてが立ち上がります。UI は
`http://localhost:3000` で確認できます。
詳細な手順は [../README.md](../README.md) を参照してください。

### Q. 使用する言語バージョンは？

`.tool-versions` ファイル (`asdf` 互換) で管理しています。

```sh
asdf install
```

CI (`.github/workflows/ci.yml`) と揃えるため、必ず `.tool-versions`
記載のバージョンを使用してください。

### Q. どのポートを使いますか？

- `api-gateway`: 8000
- `metrics-worker`: 9000 (メトリクス export 用)
- `dashboard-bff`: 3000

競合したときの対処は [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) を参照。

## 開発について

### Q. どのブランチに PR を出しますか？

デフォルトブランチ (`main`) に対して PR を作成してください。
ブランチ名は以下のいずれかのプレフィックスで始めてください:

- `feat/` — 新機能
- `fix/` — バグ修正
- `docs/` — ドキュメントのみ
- `chore/` — その他の作業
- `refactor/` — 挙動を変えないリファクタ
- `test/` — テストの追加・修正

詳細は [../CONTRIBUTING.md](../CONTRIBUTING.md) を参照してください。

### Q. サービスごとのテストは？

`Makefile` にサービス横断のターゲットが用意されています。

```sh
make test           # 全サービスのテストを実行
make test-python    # api-gateway のみ
make test-go        # metrics-worker のみ
make test-ts        # dashboard-bff のみ
```

### Q. lint はどう実行しますか？

CI と同じコマンドを流してください。

- `services/api-gateway`: `flake8 --max-line-length=120`
- `services/metrics-worker`: `go vet ./...`
- `services/dashboard-bff`: `npm run lint`

`.editorconfig` / `.gitattributes` により行末・改行コードは
統一されているため、エディタ設定がこれらに準拠していれば
不要な diff は発生しません。

### Q. API リファレンスはどこにありますか？

`README.md` の "API リファレンス" 節に代表的なエンドポイントを表で
掲載しています。各エンドポイントの詳細な挙動は
`services/api-gateway/app.py` と `services/api-gateway/tests/`
の実装・テストコードを併せてご確認ください。

## セキュリティ・運用について

### Q. 脆弱性を発見したときの報告先は？

[SECURITY.md](../SECURITY.md) に記載の連絡先へ非公開でご報告ください。
GitHub の Public Issue には投稿しないでください。

### Q. 依存パッケージの更新方針は？

Dependabot を有効化しており、Python / Node.js / Go / GitHub Actions /
Docker それぞれの依存を毎週自動チェックしています。
セキュリティアップデートは即マージ、通常のマイナー更新は動作確認後に
マージする運用です。

## その他

### Q. 不具合を報告したい・機能要望を出したい

`.github/ISSUE_TEMPLATE/` の該当テンプレートを使ってご報告ください。
テンプレートに沿って再現手順・環境情報を記入いただけると調査が
スムーズです。

### Q. サポートを受けたい

[SECURITY.md](../SECURITY.md) と [CONTRIBUTING.md](../CONTRIBUTING.md)
に一次窓口の情報を記載しています。
