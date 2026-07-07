"""api-gateway の `/api/v1/metrics/by_week` エンドポイントの回帰テスト。

既存の `tests/test_app.py` に追加するのではなく独立ファイルとして分離することで、
by_week 系の 400 バリデーション・ISO 週ビニング・タイムゾーン正規化・年跨ぎ規則・
登録順衝突回避を一箇所で読めるようにする。fixture 規約 (`_reset_state` を setup で呼ぶ) は
`test_by_day.py` / `test_by_hour_of_day.py` と揃える。
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


def test_by_week_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_weeks": 0, "by_week": []}


def test_by_week_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_week?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_weeks": 0, "by_week": []}


# ---- 基本的な ISO 週ビニング ----


def test_by_week_groups_by_iso_week():
    # 2026-06-20 (土曜) は ISO 2026-W25 に属する（月曜起点の週規則）
    # 2026-06-21 (日曜) も 2026-W25。 2026-06-22 (月曜) から 2026-W26。
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-21T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-22T10:00:00+00:00")
    _seed_metric("cpu", 40, "2026-06-28T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_weeks"] == 2
    assert body["by_week"] == [
        {"week": "2026-W25", "count": 2},
        {"week": "2026-W26", "count": 2},
    ]


def test_by_week_sorted_lex_ascending_with_zero_padding():
    # ISO 週番号は 2 桁ゼロ詰めで出力され、YYYY-Www の lex 順 = カレンダー週順
    _seed_metric("m", 1, "2026-09-20T00:00:00+00:00")  # W38
    _seed_metric("m", 2, "2026-02-05T00:00:00+00:00")  # W06
    _seed_metric("m", 3, "2026-04-01T00:00:00+00:00")  # W14
    _seed_metric("m", 4, "2026-11-20T00:00:00+00:00")  # W47
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    weeks = [row["week"] for row in resp.json()["by_week"]]
    assert weeks == sorted(weeks)
    # 2 桁ゼロ詰めであること（"W06" のような）
    assert all(len(w.split("-W")[1]) == 2 for w in weeks)


def test_by_week_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-22T10:00:00+00:00")   # W26
    _seed_metric("mem", 20, "2026-06-23T10:00:00+00:00")   # W26
    _seed_metric("disk", 30, "2026-06-29T10:00:00+00:00")  # W27
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_week"] == [
        {"week": "2026-W26", "count": 2},
        {"week": "2026-W27", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_week_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-22T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-22T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-29T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_week?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_week"] == [
        {"week": "2026-W26", "count": 1},
        {"week": "2026-W27", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_week_filters_by_since_until():
    _seed_metric("m", 1, "2026-06-15T09:00:00+00:00")  # W25
    _seed_metric("m", 2, "2026-06-22T10:00:00+00:00")  # W26
    _seed_metric("m", 3, "2026-06-29T11:00:00+00:00")  # W27
    _seed_metric("m", 4, "2026-07-06T12:00:00+00:00")  # W28
    # `+` は URL クエリ内で空白扱いされるため `%2B` にエンコード
    resp = _client().get(
        "/api/v1/metrics/by_week?since=2026-06-20T00:00:00%2B00:00&until=2026-07-01T00:00:00%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_week"] == [
        {"week": "2026-W26", "count": 1},
        {"week": "2026-W27", "count": 1},
    ]


# ---- 年跨ぎ ISO 週 ----


def test_by_week_handles_iso_year_boundary():
    """ISO 8601 週規則では、年跨ぎの週は %G (ISO 週数ベースの年) で表される。

    2026-01-01 (木曜) は ISO 2026-W01 に属する。
    一方 2027-01-01 (金曜) はカレンダー 2027 だが、ISO では 2026-W53 に属する
    (W53 は月曜が 12/28、日曜が 1/3 の週で、木曜が 2026 側の年に属するため)。
    実行環境が glibc の場合は `%G-W%V` がこの規則を正しく実装している。
    """
    _seed_metric("m", 1, "2026-01-01T00:00:00+00:00")  # ISO 2026-W01
    _seed_metric("m", 2, "2027-01-01T00:00:00+00:00")  # ISO 2026-W53
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    weeks = {row["week"]: row["count"] for row in body["by_week"]}
    # どちらも ISO 2026 年内に属する
    assert "2026-W01" in weeks
    assert "2026-W53" in weeks
    assert body["total"] == 2


# ---- タイムゾーン変換 ----


def test_by_week_converts_non_utc_timestamps_to_utc():
    # JST 2026-06-22 (月曜) 08:00 → UTC 2026-06-21 (日曜) 23:00 → W25 (日曜側)
    _seed_metric("m", 1, "2026-06-22T08:00:00+09:00")
    # JST 2026-06-22 (月曜) 09:00 → UTC 2026-06-22 (月曜) 00:00 → W26 (月曜側)
    _seed_metric("m", 2, "2026-06-22T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_weeks"] == 2
    weeks = {row["week"]: row["count"] for row in body["by_week"]}
    assert weeks == {"2026-W25": 1, "2026-W26": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_week_ignores_broken_recorded_at():
    _seed_metric("good", 1, "2026-06-22T10:00:00+00:00")
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
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_week"] == [{"week": "2026-W26", "count": 1}]


# ---- バリデーションエラー ----


def test_by_week_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_week?since=not-a-date")
    assert resp.status_code == 400


def test_by_week_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_week?since=2026-06-22T00:00:00%2B00:00&until=2026-06-20T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_week_does_not_collide_with_metric_name_route():
    """`by_week` が `{metric_name}` にルーティングされずに by_week handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_week` より前に登録されると、`metric_name == "by_week"` として
    捕捉され 404 (No metrics found for 'by_week') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_week")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_week" in body
    assert "detail" not in body
