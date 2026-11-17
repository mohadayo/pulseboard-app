"""api-gateway の `/api/v1/metrics/by_hour` エンドポイントの回帰テスト。

既存の `tests/test_by_day.py` と並列の構造で、`by_hour` 固有のビニング（UTC 時間粒度）・
バリデーション・タイムゾーン正規化・登録順衝突回避を一箇所で読めるようにする。
fixture 規約 (`_reset_state` を setup で呼ぶ) は既存テスト群と揃える。
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
    時間ビニングのテストが書けないため、ストアに直接 push する。
    `setup_function` で毎回クリアされるので状態リークの心配は無い。
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


def test_by_hour_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_hours": 0, "by_hour": []}


def test_by_hour_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_hours": 0, "by_hour": []}


# ---- 基本的な UTC 時間ビニング ----


def test_by_hour_groups_by_utc_hour():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-20T10:59:59+00:00")
    _seed_metric("cpu", 30, "2026-06-20T11:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["distinct_hours"] == 2
    assert body["by_hour"] == [
        {"hour": "2026-06-20T10", "count": 2},
        {"hour": "2026-06-20T11", "count": 1},
    ]


def test_by_hour_sorted_lex_ascending_across_days():
    # 日またぎを含めて lex 昇順 = 時系列昇順になることを確認する。
    _seed_metric("m", 1, "2026-06-20T23:30:00+00:00")
    _seed_metric("m", 2, "2026-06-20T00:05:00+00:00")
    _seed_metric("m", 3, "2026-06-21T00:05:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    hours = [row["hour"] for row in resp.json()["by_hour"]]
    assert hours == ["2026-06-20T00", "2026-06-20T23", "2026-06-21T00"]


def test_by_hour_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:30:00+00:00")
    _seed_metric("disk", 30, "2026-06-20T11:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_hour"] == [
        {"hour": "2026-06-20T10", "count": 2},
        {"hour": "2026-06-20T11", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_hour_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-20T11:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_hour"] == [
        {"hour": "2026-06-20T10", "count": 1},
        {"hour": "2026-06-20T11", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_hour_filters_by_since_until():
    _seed_metric("m", 1, "2026-06-20T09:00:00+00:00")
    _seed_metric("m", 2, "2026-06-20T10:00:00+00:00")
    _seed_metric("m", 3, "2026-06-20T11:00:00+00:00")
    _seed_metric("m", 4, "2026-06-20T12:00:00+00:00")
    # `+` は URL クエリ内では空白として解釈されるため、`%2B` にエンコードして送る。
    resp = _client().get(
        "/api/v1/metrics/by_hour?"
        "since=2026-06-20T10:00:00%2B00:00&until=2026-06-20T11:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_hour"] == [
        {"hour": "2026-06-20T10", "count": 1},
        {"hour": "2026-06-20T11", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_hour_converts_non_utc_timestamps_to_utc():
    # JST 2026-06-20 18:30 → UTC 2026-06-20 09:30（9 時バケット）
    _seed_metric("m", 1, "2026-06-20T18:30:00+09:00")
    # JST 2026-06-20 19:30 → UTC 2026-06-20 10:30（10 時バケット）
    _seed_metric("m", 2, "2026-06-20T19:30:00+09:00")
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_hours"] == 2
    hours = {row["hour"]: row["count"] for row in body["by_hour"]}
    assert hours == {"2026-06-20T09": 1, "2026-06-20T10": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_hour_ignores_broken_recorded_at():
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
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_hour"] == [{"hour": "2026-06-20T10", "count": 1}]


# ---- バリデーションエラー ----


def test_by_hour_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_hour?since=not-a-date")
    assert resp.status_code == 400


def test_by_hour_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_hour?"
        "since=2026-06-20T12:00:00%2B00:00&until=2026-06-20T10:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_hour_does_not_collide_with_metric_name_route():
    """`by_hour` が `{metric_name}` にルーティングされずに by_hour handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_hour` より前に登録されると、`metric_name == "by_hour"` として
    捕捉され 404 (No metrics found for 'by_hour') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_hour")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_hour" in body
    assert "detail" not in body
