"""api-gateway の `/api/v1/metrics/by_month` エンドポイントの回帰テスト。

既存の `tests/test_app.py` に追加するのではなく独立ファイルとして分離することで、
by_month 系の 400 バリデーション・グレゴリオ暦月ビニング・タイムゾーン正規化・
年跨ぎ規則・登録順衝突回避を一箇所で読めるようにする。fixture 規約
(`_reset_state` を setup で呼ぶ) は `test_by_day.py` / `test_by_week.py` と揃える。
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


def test_by_month_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_months": 0, "by_month": []}


def test_by_month_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_months": 0, "by_month": []}


# ---- 基本的なグレゴリオ暦月ビニング ----


def test_by_month_groups_by_calendar_month():
    # 6 月と 7 月の異なる日を混在させ、暦月単位で集計されることを確認
    _seed_metric("cpu", 10, "2026-06-01T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-15T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-30T23:59:59+00:00")
    _seed_metric("cpu", 40, "2026-07-01T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_months"] == 2
    assert body["by_month"] == [
        {"month": "2026-06", "count": 3},
        {"month": "2026-07", "count": 1},
    ]


def test_by_month_sorted_lex_ascending_with_zero_padding():
    # YYYY-MM は 2 桁ゼロ詰めで出力され、lex 順 = カレンダー月順
    _seed_metric("m", 1, "2026-09-20T00:00:00+00:00")   # 09
    _seed_metric("m", 2, "2026-02-05T00:00:00+00:00")   # 02
    _seed_metric("m", 3, "2026-04-01T00:00:00+00:00")   # 04
    _seed_metric("m", 4, "2026-11-20T00:00:00+00:00")   # 11
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    months = [row["month"] for row in resp.json()["by_month"]]
    assert months == sorted(months)
    # 2 桁ゼロ詰めであること
    assert all(len(m.split("-")[1]) == 2 for m in months)
    assert months == ["2026-02", "2026-04", "2026-09", "2026-11"]


def test_by_month_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("disk", 30, "2026-07-05T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_month"] == [
        {"month": "2026-06", "count": 2},
        {"month": "2026-07", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_month_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-15T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-07-15T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_month"] == [
        {"month": "2026-06", "count": 1},
        {"month": "2026-07", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_month_filters_by_since_until():
    _seed_metric("m", 1, "2026-05-15T09:00:00+00:00")   # 05
    _seed_metric("m", 2, "2026-06-15T10:00:00+00:00")   # 06
    _seed_metric("m", 3, "2026-07-15T11:00:00+00:00")   # 07
    _seed_metric("m", 4, "2026-08-15T12:00:00+00:00")   # 08
    # `+` は URL クエリ内で空白扱いされるため `%2B` にエンコード
    resp = _client().get(
        "/api/v1/metrics/by_month?since=2026-06-01T00:00:00%2B00:00&until=2026-07-31T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_month"] == [
        {"month": "2026-06", "count": 1},
        {"month": "2026-07", "count": 1},
    ]


# ---- 年跨ぎ ----


def test_by_month_handles_year_boundary():
    """暦月ビニングは ISO 週と違い暦年に一致する。12 月と 1 月は別月・別年になる。"""
    _seed_metric("m", 1, "2026-12-31T23:59:59+00:00")
    _seed_metric("m", 2, "2027-01-01T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_month"] == [
        {"month": "2026-12", "count": 1},
        {"month": "2027-01", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_month_converts_non_utc_timestamps_to_utc():
    # JST 2026-07-01 (火) 08:00 → UTC 2026-06-30 (月) 23:00 → 06
    _seed_metric("m", 1, "2026-07-01T08:00:00+09:00")
    # JST 2026-07-01 (火) 09:00 → UTC 2026-07-01 (火) 00:00 → 07
    _seed_metric("m", 2, "2026-07-01T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_months"] == 2
    months = {row["month"]: row["count"] for row in body["by_month"]}
    assert months == {"2026-06": 1, "2026-07": 1}


def test_by_month_naive_timestamps_treated_as_utc():
    # tz 情報なしの ISO 文字列は UTC として解釈される（by_week と同じ規約）
    _seed_metric("m", 1, "2026-06-15T10:00:00")
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["by_month"] == [{"month": "2026-06", "count": 1}]


# ---- 破損した recorded_at のスキップ ----


def test_by_month_ignores_broken_recorded_at():
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
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_month"] == [{"month": "2026-06", "count": 1}]


# ---- バリデーションエラー ----


def test_by_month_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_month?since=not-a-date")
    assert resp.status_code == 400


def test_by_month_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_month?since=2026-07-01T00:00:00%2B00:00&until=2026-06-01T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_month_does_not_collide_with_metric_name_route():
    """`by_month` が `{metric_name}` にルーティングされずに by_month handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_month` より前に登録されると、`metric_name == "by_month"` として
    捕捉され 404 (No metrics found for 'by_month') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_month")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_month" in body
    assert "detail" not in body
