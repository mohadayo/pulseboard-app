"""api-gateway の `/api/v1/metrics/by_quarter` エンドポイントの回帰テスト。

`test_by_month.py` / `test_by_year.py` と同じ構造で、四半期ビニング・
タイムゾーン正規化・四半期境界・登録順衝突回避を一箇所で読めるようにする。
fixture 規約 (`_reset_state` を setup で呼ぶ) は既存 by_* 系テストと揃える。
"""

import app as app_module
from fastapi.testclient import TestClient


def _client() -> TestClient:
    """毎回モジュール属性から現在の app を取得して TestClient を作る。"""
    return TestClient(app_module.app)


def setup_function(_func):
    app_module._reset_state()


def _seed_metric(name: str, value: float, iso_ts: str) -> None:
    """テスト用に metrics_store へ直接メトリクスを差し込むヘルパ。

    POST 経由だと recorded_at が `datetime.now(timezone.utc)` で上書きされてしまい、
    時刻ビニングのテストが書けないため、ストアに直接 push する。
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


def test_by_quarter_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_quarters": 0, "by_quarter": []}


def test_by_quarter_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_quarter?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_quarters": 0, "by_quarter": []}


# ---- 基本的な四半期ビニング ----


def test_by_quarter_groups_by_calendar_quarter():
    # 各四半期の代表月を混在させ、四半期単位で正しく集計されることを確認
    _seed_metric("cpu", 10, "2026-01-15T10:00:00+00:00")   # Q1 (1 月)
    _seed_metric("cpu", 20, "2026-03-31T23:59:59+00:00")   # Q1 (3 月末)
    _seed_metric("cpu", 30, "2026-04-01T00:00:00+00:00")   # Q2 (4 月頭)
    _seed_metric("cpu", 40, "2026-06-15T10:00:00+00:00")   # Q2
    _seed_metric("cpu", 50, "2026-07-01T00:00:00+00:00")   # Q3
    _seed_metric("cpu", 60, "2026-10-01T00:00:00+00:00")   # Q4
    _seed_metric("cpu", 70, "2026-12-31T23:59:59+00:00")   # Q4
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 7
    assert body["distinct_quarters"] == 4
    assert body["by_quarter"] == [
        {"quarter": "2026-Q1", "count": 2},
        {"quarter": "2026-Q2", "count": 2},
        {"quarter": "2026-Q3", "count": 1},
        {"quarter": "2026-Q4", "count": 2},
    ]


def test_by_quarter_all_four_quarters_have_correct_month_ranges():
    """各月がどの四半期に入るかを網羅する境界テスト（(month - 1) // 3 + 1 の検証）。"""
    # Q1: 1, 2, 3
    _seed_metric("m", 1, "2026-01-15T00:00:00+00:00")
    _seed_metric("m", 2, "2026-02-15T00:00:00+00:00")
    _seed_metric("m", 3, "2026-03-15T00:00:00+00:00")
    # Q2: 4, 5, 6
    _seed_metric("m", 4, "2026-04-15T00:00:00+00:00")
    _seed_metric("m", 5, "2026-05-15T00:00:00+00:00")
    _seed_metric("m", 6, "2026-06-15T00:00:00+00:00")
    # Q3: 7, 8, 9
    _seed_metric("m", 7, "2026-07-15T00:00:00+00:00")
    _seed_metric("m", 8, "2026-08-15T00:00:00+00:00")
    _seed_metric("m", 9, "2026-09-15T00:00:00+00:00")
    # Q4: 10, 11, 12
    _seed_metric("m", 10, "2026-10-15T00:00:00+00:00")
    _seed_metric("m", 11, "2026-11-15T00:00:00+00:00")
    _seed_metric("m", 12, "2026-12-15T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 12
    assert body["by_quarter"] == [
        {"quarter": "2026-Q1", "count": 3},
        {"quarter": "2026-Q2", "count": 3},
        {"quarter": "2026-Q3", "count": 3},
        {"quarter": "2026-Q4", "count": 3},
    ]


def test_by_quarter_sorted_lex_ascending():
    # YYYY-Qn (n=1..4) は lex 順 = カレンダー四半期順
    _seed_metric("m", 1, "2028-04-01T00:00:00+00:00")   # 2028-Q2
    _seed_metric("m", 2, "2025-11-05T00:00:00+00:00")   # 2025-Q4
    _seed_metric("m", 3, "2027-01-01T00:00:00+00:00")   # 2027-Q1
    _seed_metric("m", 4, "2026-08-20T00:00:00+00:00")   # 2026-Q3
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    quarters = [row["quarter"] for row in resp.json()["by_quarter"]]
    assert quarters == sorted(quarters)
    assert quarters == ["2025-Q4", "2026-Q3", "2027-Q1", "2028-Q2"]


def test_by_quarter_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-02-15T10:00:00+00:00")   # Q1
    _seed_metric("mem", 20, "2026-03-20T10:00:00+00:00")   # Q1
    _seed_metric("disk", 30, "2026-05-05T10:00:00+00:00")  # Q2
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_quarter"] == [
        {"quarter": "2026-Q1", "count": 2},
        {"quarter": "2026-Q2", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_quarter_filters_by_name():
    _seed_metric("cpu", 10, "2026-02-15T10:00:00+00:00")   # Q1
    _seed_metric("mem", 20, "2026-02-15T10:00:00+00:00")   # Q1
    _seed_metric("cpu", 30, "2026-07-15T10:00:00+00:00")   # Q3
    resp = _client().get("/api/v1/metrics/by_quarter?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_quarter"] == [
        {"quarter": "2026-Q1", "count": 1},
        {"quarter": "2026-Q3", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_quarter_filters_by_since_until():
    _seed_metric("m", 1, "2026-01-15T09:00:00+00:00")   # Q1
    _seed_metric("m", 2, "2026-04-15T10:00:00+00:00")   # Q2
    _seed_metric("m", 3, "2026-07-15T11:00:00+00:00")   # Q3
    _seed_metric("m", 4, "2026-10-15T12:00:00+00:00")   # Q4
    # `+` は URL クエリ内で空白扱いされるため `%2B` にエンコード
    resp = _client().get(
        "/api/v1/metrics/by_quarter?since=2026-04-01T00:00:00%2B00:00&until=2026-09-30T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_quarter"] == [
        {"quarter": "2026-Q2", "count": 1},
        {"quarter": "2026-Q3", "count": 1},
    ]


# ---- 四半期境界 ----


def test_by_quarter_handles_quarter_boundary_exactly():
    """Q1/Q2 境界 (3/31 と 4/1)、Q4/Q1 境界 (12/31 と 1/1) が別バケットになることを確認。"""
    _seed_metric("m", 1, "2026-03-31T23:59:59+00:00")   # 2026-Q1
    _seed_metric("m", 2, "2026-04-01T00:00:00+00:00")   # 2026-Q2
    _seed_metric("m", 3, "2026-12-31T23:59:59+00:00")   # 2026-Q4
    _seed_metric("m", 4, "2027-01-01T00:00:00+00:00")   # 2027-Q1
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["by_quarter"] == [
        {"quarter": "2026-Q1", "count": 1},
        {"quarter": "2026-Q2", "count": 1},
        {"quarter": "2026-Q4", "count": 1},
        {"quarter": "2027-Q1", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_quarter_converts_non_utc_timestamps_to_utc():
    # JST 2026-04-01 (水) 08:00 → UTC 2026-03-31 (火) 23:00 → 2026-Q1
    _seed_metric("m", 1, "2026-04-01T08:00:00+09:00")
    # JST 2026-04-01 (水) 09:00 → UTC 2026-04-01 (水) 00:00 → 2026-Q2
    _seed_metric("m", 2, "2026-04-01T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_quarters"] == 2
    quarters = {row["quarter"]: row["count"] for row in body["by_quarter"]}
    assert quarters == {"2026-Q1": 1, "2026-Q2": 1}


def test_by_quarter_naive_timestamps_treated_as_utc():
    # tz 情報なしの ISO 文字列は UTC として解釈される（by_month / by_year と同じ規約）
    _seed_metric("m", 1, "2026-06-15T10:00:00")
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["by_quarter"] == [{"quarter": "2026-Q2", "count": 1}]


# ---- 破損した recorded_at のスキップ ----


def test_by_quarter_ignores_broken_recorded_at():
    _seed_metric("good", 1, "2026-06-15T10:00:00+00:00")
    app_module.metrics_store.setdefault("bad", []).append({
        "id": 999,
        "name": "bad",
        "value": 0.0,
        "tags": {},
        "recorded_at": "not-a-timestamp",
    })
    app_module.metrics_store.setdefault("missing", []).append({
        "id": 888,
        "name": "missing",
        "value": 0.0,
        "tags": {},
    })
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_quarter"] == [{"quarter": "2026-Q2", "count": 1}]


# ---- バリデーションエラー ----


def test_by_quarter_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_quarter?since=not-a-date")
    assert resp.status_code == 400


def test_by_quarter_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_quarter?since=2027-01-01T00:00:00%2B00:00&until=2026-01-01T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_quarter_does_not_collide_with_metric_name_route():
    """`by_quarter` が `{metric_name}` にルーティングされずに by_quarter handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_quarter` より前に登録されると、`metric_name == "by_quarter"` として
    捕捉され 404 (No metrics found for 'by_quarter') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_quarter")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_quarter" in body
    assert "detail" not in body
