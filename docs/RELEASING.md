# RELEASING（リリース手順）

PulseBoard のバージョンを切るための手順書です。`CHANGELOG.md` / `CITATION.cff` /
`.github/release.yml` / Git タグ / GitHub Release を**整合した状態で**進めるためのチェックリストとして使ってください。

- 対応するバージョンポリシー: [Semantic Versioning](https://semver.org/lang/ja/)
- 変更履歴フォーマット: [Keep a Changelog v1.1.0](https://keepachangelog.com/ja/1.1.0/)
- 変更履歴ファイル: [`../CHANGELOG.md`](../CHANGELOG.md)
- 自動生成ノート設定: [`../.github/release.yml`](../.github/release.yml)
- 引用メタデータ: [`../CITATION.cff`](../CITATION.cff)

---

## 1. バージョン番号の決め方（SemVer）

`vMAJOR.MINOR.PATCH` の各桁は次のいずれかの変更に対応させます。

| 桁 | 典型例 | 代表的な PR ラベル |
|----|--------|------------------|
| `MAJOR` | 公開エンドポイントの削除 / レスポンス互換を壊すスキーマ変更 / 既定ポートの変更 / 必須環境変数の追加 | `breaking-change` / `breaking` |
| `MINOR` | 新しいエンドポイント追加 / 既存エンドポイントへの任意パラメータ追加 / 新しい集計統計量の追加 | `feature` / `enhancement` / `feat` |
| `PATCH` | バグ修正 / ドキュメントのみの改善 / 依存バージョンの安全な更新 / 内部リファクタ | `bug` / `fix` / `bugfix` / `docs` / `dependencies` |

0.x 系列（現状）では「破壊的変更は MINOR を上げる」運用も一般的ですが、本リポジトリでは
**0.x 系でも破壊的変更は MAJOR 相当の扱い**にして `CHANGELOG.md` の `Breaking Changes` に明記し、
リリースノートに移行手順を書きます。1.0.0 到達後は通常の SemVer に移行します。

---

## 2. リリース前チェック

リリース作業ブランチを切る前に、以下を確認します。

- [ ] `main` の CI（`ci.yml` / `actionlint` / `codeql` / `dependency-review` / `validate-cff`）が全て緑
- [ ] 直近 merge PR に [`release.yml`](../.github/release.yml) で参照しているラベル
      （`feat` / `fix` / `docs` / `dependencies` / `breaking-change` など）が付与されている
      → 付いていない PR は `Other Changes` に落ちるため、必要なら後付けで追加
- [ ] `CHANGELOG.md` の `[Unreleased]` に当該バージョンで出す内容が揃っている
- [ ] ドキュメント（`README.md` / `docs/`）の API リファレンス表が実装と整合している
- [ ] 既知の破壊的変更がある場合、`docs/` に移行ガイドが用意されている

---

## 3. バージョン確定時の更新対象

リリース用ブランチ（命名例: `release/vX.Y.Z-20261116`）で以下を 1 コミットにまとめます。

### 3.1 `CHANGELOG.md`

`[Unreleased]` ブロックを新しいバージョンに繰り上げます。

```diff
-## [Unreleased]
+## [Unreleased]
+
+### Added
+
+### Changed
+
+### Deprecated
+
+### Removed
+
+### Fixed
+
+### Security
+
+## [X.Y.Z] - 2026-11-16
```

ページ下部の比較リンクも追加します。

```diff
-[Unreleased]: https://github.com/mohadayo/pulseboard-app/compare/v0.1.0...HEAD
+[Unreleased]: https://github.com/mohadayo/pulseboard-app/compare/vX.Y.Z...HEAD
+[X.Y.Z]: https://github.com/mohadayo/pulseboard-app/compare/v0.1.0...vX.Y.Z
```

### 3.2 `CITATION.cff`

`version` と `date-released` を更新します（`date-released` は UTC 日付・`YYYY-MM-DD`）。

```diff
-version: 0.1.0
-date-released: 2026-05-09
+version: X.Y.Z
+date-released: 2026-11-16
```

変更後は `validate-cff.yml` ワークフローがローカルで通ることを確認してください。

### 3.3 ソースコード側のバージョン定数（存在する場合のみ）

サービス内にバージョン文字列を埋め込んでいる定数がある場合はそれも更新します。
現状の 3 サービス（`api-gateway` / `metrics-worker` / `dashboard-bff`）は
実行時に SemVer 文字列を公開していないため、追加作業は不要です。
将来 `/version` エンドポイントや `X-App-Version` ヘッダを導入した場合は本節に手順を追記してください。

---

## 4. タグ発行と GitHub Release の作成

1. 上記の変更を含む PR をレビュー・squash マージ（CI 緑を確認）
2. `main` を最新化し、マージコミットに対して注釈付きタグを打つ

   ```sh
   git fetch origin
   git checkout main
   git pull --ff-only
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

3. GitHub Release を**ドラフト**で新規作成
   - Tag: `vX.Y.Z`（上で push 済み）
   - Target: `main`
   - 「Generate release notes」を実行
     → [`.github/release.yml`](../.github/release.yml) の設定に従い、
     `Breaking Changes` / `New Features` / `Bug Fixes` / `Documentation` /
     `Dependencies` / `Other Changes` の順でカテゴリ分けされる
   - 必要に応じて冒頭にハイライト（概要・移行手順リンク）を追記
4. `CHANGELOG.md` の該当バージョン節の内容と、GitHub Release ノートの
   内容に矛盾がないことを確認
5. 問題なければ Release を公開（Publish）

---

## 5. リリース後の後片付け

- [ ] リリースを告知（社内チャンネル / Discussions / 必要なら README のバッジ更新）
- [ ] `CHANGELOG.md` の `[Unreleased]` が空であることを確認
      （§3.1 の diff を適用済みなら OK）
- [ ] 次バージョンに向けた既知の Breaking Change があれば、該当 Issue にマイルストーンを設定
- [ ] Docker イメージを公開配布している場合はタグを伝搬（現状はローカル build のみなので対象外）

---

## 6. ホットフィックス運用

本番で発見された Critical バグに対する緊急修正は以下の順で進めます。

1. 直前のリリースタグから `hotfix/vX.Y.Z+1-<topic>` ブランチを切る
2. 修正とテストを追加（CI 緑を確認）
3. PR を作成し、レビュー・squash マージ後に `vX.Y.(Z+1)` を打つ
4. `main` にも cherry-pick（または merge）して差分を持ち込む
5. §4 の手順で GitHub Release を発行し、ノート冒頭に "Hotfix for …" を明記

`MINOR` を飛ばさないことで、利用者が「`PATCH` だけの差分」で安全に追従できる状態を保ちます。

---

## 7. チェックリスト（印刷用）

```
[ ] CI 緑 (ci / actionlint / codeql / dependency-review / validate-cff)
[ ] 直近 PR のラベル付与確認（release.yml のカテゴリに乗る）
[ ] CHANGELOG.md: [Unreleased] → [X.Y.Z] 繰り上げ、比較リンク追加
[ ] CITATION.cff: version / date-released 更新
[ ] リリース用 PR を作成・レビュー・squash マージ
[ ] git tag -a vX.Y.Z -m "vX.Y.Z" && git push origin vX.Y.Z
[ ] GitHub Release ドラフトを作成、Generate release notes 実行
[ ] リリースノートのハイライト追記
[ ] Publish release
[ ] CHANGELOG.md に新しい空の [Unreleased] ブロックがあることを確認
[ ] 告知
```
