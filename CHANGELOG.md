# Changelog

このプロジェクトの主な変更点を記録するファイルです。

フォーマットは [Keep a Changelog v1.1.0](https://keepachangelog.com/ja/1.1.0/) に、
バージョン番号は [Semantic Versioning](https://semver.org/lang/ja/) に準拠します。

## [Unreleased]

### Added

- （次回リリースで追加する機能をここに記載）

### Changed

- （挙動の変更をここに記載）

### Deprecated

- （非推奨になった機能をここに記載）

### Removed

- （削除された機能をここに記載）

### Fixed

- （バグ修正をここに記載）

### Security

- （セキュリティ関連の修正をここに記載）

## [0.1.0] - 2026-05-09

初回リリース。PulseBoard の Baseline 実装（Python API / Go worker /
TypeScript BFF の 3 サービス構成）を記録します。

### Added

- **Python API (`services/`)**: メトリクス収集・永続化 API。
- **Go worker (`services/`)**: バックグラウンドでのメトリクス集計・アラート判定処理。
- **TypeScript BFF (`services/`)**: フロントエンド向けの統合 API と
  リアルタイム更新の中継。
- ローカル開発用の `docker-compose.yml` による 3 サービスの一括起動。
- 共通タスクを集約する `Makefile`。
- リポジトリ運用ドキュメント: `README.md` / `CONTRIBUTING.md` /
  `CODE_OF_CONDUCT.md` / `SECURITY.md` / `LICENSE` /
  `.github/` 配下の CODEOWNERS / PR テンプレート / Issue テンプレート等。
- 開発補助ファイル: `.gitattributes` / `.gitignore` / `.env.example` /
  `.tool-versions`。
- CI ワークフロー (`.github/workflows/`) による lint / test の自動実行。

[Unreleased]: https://github.com/mohadayo/pulseboard-app/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mohadayo/pulseboard-app/releases/tag/v0.1.0
