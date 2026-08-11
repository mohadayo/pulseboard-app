"""api-gateway の `/api/v1/metrics/by_year` エンドポイントの回帰テスト。

`test_by_month.py` / `test_by_week.py` と同じ構造で、暦年ビニング・タイムゾーン
正規化・年跨ぎ規則・登録順衝突回避を一箇所で読めるようにする。fixture 規約
(`_reset_state` を setup で呼ぶ) は既存 by_* 系テストと揃える。
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


def test_by_year_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_years": 0, "by_year": []}


def test_by_year_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_years": 0, "by_year": []}


# ---- 基本的な暦年ビニング ----


def test_by_year_groups_by_calendar_year():
    # 同一年の異なる月と、翌年の初日を混在させ、暦年単位で集計されることを確認
    _seed_metric("cpu", 10, "2026-01-01T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-15T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-12-31T23:59:59+00:00")
    _seed_metric("cpu", 40, "2027-01-01T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_years"] == 2
    assert body["by_year"] == [
        {"year": "2026", "count": 3},
        {"year": "2027", "count": 1},
    ]


def test_by_year_sorted_lex_ascending():
    # YYYY は lex 順 = カレンダー年順
    _seed_metric("m", 1, "2030-06-20T00:00:00+00:00")
    _seed_metric("m", 2, "2025-02-05T00:00:00+00:00")
    _seed_metric("m", 3, "2028-04-01T00:00:00+00:00")
    _seed_metric("m", 4, "2027-11-20T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    years = [row["year"] for row in resp.json()["by_year"]]
    assert years == sorted(years)
    assert years == ["2025", "2027", "2028", "2030"]


def test_by_year_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-08-20T10:00:00+00:00")
    _seed_metric("disk", 30, "2027-01-05T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_year"] == [
        {"year": "2026", "count": 2},
        {"year": "2027", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_year_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-15T10:00:00+00:00")
    _seed_metric("cpu", 30, "2027-07-15T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_year"] == [
        {"year": "2026", "count": 1},
        {"year": "2027", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_year_filters_by_since_until():
    _seed_metric("m", 1, "2024-05-15T09:00:00+00:00")   # 2024
    _seed_metric("m", 2, "2025-06-15T10:00:00+00:00")   # 2025
    _seed_metric("m", 3, "2026-07-15T11:00:00+00:00")   # 2026
    _seed_metric("m", 4, "2027-08-15T12:00:00+00:00")   # 2027
    # `+` は URL クエリ内で空白扱いされるため `%2B` にエンコード
    resp = _client().get(
        "/api/v1/metrics/by_year?since=2025-01-01T00:00:00%2B00:00&until=2026-12-31T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_year"] == [
        {"year": "2025", "count": 1},
        {"year": "2026", "count": 1},
    ]


# ---- 年跨ぎ ----


def test_by_year_handles_year_boundary_exactly():
    """暦年ビニングは ISO 週と違い暦年に完全一致する。12/31 と 1/1 は必ず別年になる。

    `by_week` では 12/31 が翌年の ISO 週 (W01) に吸収されることがあるが、
    `by_year` は `strftime("%Y")` を使うためグレゴリオ暦年に厳格に従う。
    """
    _seed_metric("m", 1, "2026-12-31T23:59:59+00:00")
    _seed_metric("m", 2, "2027-01-01T00:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_year"] == [
        {"year": "2026", "count": 1},
        {"year": "2027", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_year_converts_non_utc_timestamps_to_utc():
    # JST 2027-01-01 (金) 08:00 → UTC 2026-12-31 (木) 23:00 → 2026
    _seed_metric("m", 1, "2027-01-01T08:00:00+09:00")
    # JST 2027-01-01 (金) 09:00 → UTC 2027-01-01 (金) 00:00 → 2027
    _seed_metric("m", 2, "2027-01-01T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_years"] == 2
    years = {row["year"]: row["count"] for row in body["by_year"]}
    assert years == {"2026": 1, "2027": 1}


def test_by_year_naive_timestamps_treated_as_utc():
    # tz 情報なしの ISO 文字列は UTC として解釈される（by_month / by_week と同じ規約）
    _seed_metric("m", 1, "2026-06-15T10:00:00")
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["by_year"] == [{"year": "2026", "count": 1}]


# ---- 破損した recorded_at のスキップ ----


def test_by_year_ignores_broken_recorded_at():
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
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_year"] == [{"year": "2026", "count": 1}]


# ---- バリデーションエラー ----


def test_by_year_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_year?since=not-a-date")
    assert resp.status_code == 400


def test_by_year_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_year?since=2027-01-01T00:00:00%2B00:00&until=2026-01-01T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_year_does_not_collide_with_metric_name_route():
    """`by_year` が `{metric_name}` にルーティングされずに by_year handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_year` より前に登録されると、`metric_name == "by_year"` として
    捕捉され 404 (No metrics found for 'by_year') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_year")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_year" in body
    assert "detail" not in body
