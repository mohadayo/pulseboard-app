"""api-gateway の `/api/v1/metrics/by_day` エンドポイントの回帰テスト。

既存の `tests/test_app.py` に追加するのではなく独立ファイルとして分離することで、
by_day 系の 400 バリデーション・時系列ビニング・タイムゾーン正規化・登録順衝突回避を
一箇所で読めるようにする。fixture 規約 (`_reset_state` を setup で呼ぶ) は既存と揃える。
"""

import app as app_module
from fastapi.testclient import TestClient


def _client() -> TestClient:
    """毎回モジュール属性から現在の app を取得して TestClient を作る。

    `test_app.py` の一部テストが `importlib.reload(app_module)` で app モジュールを
    再ロードするため、モジュール import 時の `client = TestClient(app)` を掴んで
    しまうと再ロード後は旧 app 上でテストが走って状態が食い違う。関数ごとに新規
    TestClient を作ることで、直近の app 参照を必ず使うようにする。
    """
    return TestClient(app_module.app)


def setup_function(_func):
    app_module._reset_state()


def _seed_metric(name: str, value: float, iso_ts: str) -> None:
    """テスト用に metrics_store へ直接メトリクスを差し込むヘルパ。

    POST 経由だと recorded_at が `datetime.now(timezone.utc)` で上書きされてしまい、
    日付ビニングのテストが書けないため、ストアに直接 push する。
    `setup_function` で毎回クリアされるので状態リークの心配は無い。
    `_client()` と同じ理由で毎回 `app_module.metrics_store` を再取得する。
    """
    store = app_module.metrics_store
    store.setdefault(name, []).append({
        "id": len(store.get(name, [])) + 1,
        "name": name,
        "value": value,
        "tags": {},
        "recorded_at": iso_ts,
    })


# ---- 空ストア ----


def test_by_day_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_days": 0, "by_day": []}


def test_by_day_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_days": 0, "by_day": []}


# ---- 基本的な UTC 日付ビニング ----


def test_by_day_groups_by_utc_date():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-20T23:59:59+00:00")
    _seed_metric("cpu", 30, "2026-06-21T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["distinct_days"] == 2
    assert body["by_day"] == [
        {"day": "2026-06-20", "count": 2},
        {"day": "2026-06-21", "count": 1},
    ]


def test_by_day_sorted_lex_ascending():
    _seed_metric("m", 1, "2026-06-22T05:00:00+00:00")
    _seed_metric("m", 2, "2026-06-01T05:00:00+00:00")
    _seed_metric("m", 3, "2026-06-15T05:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    days = [row["day"] for row in resp.json()["by_day"]]
    assert days == ["2026-06-01", "2026-06-15", "2026-06-22"]


def test_by_day_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("disk", 30, "2026-06-21T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_day"] == [
        {"day": "2026-06-20", "count": 2},
        {"day": "2026-06-21", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_day_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-21T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_day"] == [
        {"day": "2026-06-20", "count": 1},
        {"day": "2026-06-21", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_day_filters_by_since_until():
    _seed_metric("m", 1, "2026-06-19T00:00:00+00:00")
    _seed_metric("m", 2, "2026-06-20T00:00:00+00:00")
    _seed_metric("m", 3, "2026-06-21T00:00:00+00:00")
    _seed_metric("m", 4, "2026-06-22T00:00:00+00:00")
    # `+` は URL クエリ内では空白として解釈されるため、`%2B` にエンコードして送る。
    resp = _client().get(
        "/api/v1/metrics/by_day?since=2026-06-20T00:00:00%2B00:00&until=2026-06-21T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_day"] == [
        {"day": "2026-06-20", "count": 1},
        {"day": "2026-06-21", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_day_converts_non_utc_timestamps_to_utc():
    # JST 2026-06-21 08:00 → UTC 2026-06-20 23:00（前日になる）
    _seed_metric("m", 1, "2026-06-21T08:00:00+09:00")
    # JST 2026-06-21 09:00 → UTC 2026-06-21 00:00（同日）
    _seed_metric("m", 2, "2026-06-21T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_days"] == 2
    days = {row["day"]: row["count"] for row in body["by_day"]}
    assert days == {"2026-06-20": 1, "2026-06-21": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_day_ignores_broken_recorded_at():
    _seed_metric("good", 1, "2026-06-20T10:00:00+00:00")
    # recorded_at が壊れているレコードを直接注入
    app_module.metrics_store.setdefault("bad", []).append({
        "id": 999,
        "name": "bad",
        "value": 0.0,
        "tags": {},
        "recorded_at": "not-a-timestamp",
    })
    # recorded_at 欠落レコード
    app_module.metrics_store.setdefault("missing", []).append({
        "id": 888,
        "name": "missing",
        "value": 0.0,
        "tags": {},
    })
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_day"] == [{"day": "2026-06-20", "count": 1}]


# ---- バリデーションエラー ----


def test_by_day_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_day?since=not-a-date")
    assert resp.status_code == 400


def test_by_day_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_day?since=2026-06-22T00:00:00%2B00:00&until=2026-06-20T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_day_does_not_collide_with_metric_name_route():
    """`by_day` が `{metric_name}` にルーティングされずに by_day handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_day` より前に登録されると、`metric_name == "by_day"` として
    捕捉され 404 (No metrics found for 'by_day') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_day")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_day" in body
    assert "detail" not in body
