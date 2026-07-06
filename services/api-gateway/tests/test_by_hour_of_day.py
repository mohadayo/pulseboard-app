"""api-gateway の `/api/v1/metrics/by_hour_of_day` エンドポイントの回帰テスト。

既存の `tests/test_app.py` に追加するのではなく独立ファイルとして分離することで、
by_hour_of_day 系の 400 バリデーション・時刻ビニング・タイムゾーン正規化・登録順衝突回避を
一箇所で読めるようにする。fixture 規約 (`_reset_state` を setup で呼ぶ) は `test_by_day.py`
と揃える。
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
    時刻ビニングのテストが書けないため、ストアに直接 push する。
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


def test_by_hour_of_day_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_hours": 0, "by_hour_of_day": []}


def test_by_hour_of_day_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {"total": 0, "distinct_hours": 0, "by_hour_of_day": []}


# ---- 基本的な UTC 時刻ビニング ----


def test_by_hour_of_day_groups_by_utc_hour():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 20, "2026-06-20T10:59:59+00:00")
    _seed_metric("cpu", 30, "2026-06-21T10:30:00+00:00")
    _seed_metric("cpu", 40, "2026-06-20T23:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_hours"] == 2
    assert body["by_hour_of_day"] == [
        {"hour": "10", "count": 3},
        {"hour": "23", "count": 1},
    ]


def test_by_hour_of_day_sorted_lex_ascending_with_zero_padding():
    # 2 桁ゼロ詰め ("01"〜"23") で lex 順 = 時間順を確認
    _seed_metric("m", 1, "2026-06-22T23:00:00+00:00")
    _seed_metric("m", 2, "2026-06-22T01:00:00+00:00")
    _seed_metric("m", 3, "2026-06-22T09:00:00+00:00")
    _seed_metric("m", 4, "2026-06-22T15:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    hours = [row["hour"] for row in resp.json()["by_hour_of_day"]]
    assert hours == ["01", "09", "15", "23"]


def test_by_hour_of_day_aggregates_across_metric_names():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("disk", 30, "2026-06-21T11:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_hour_of_day"] == [
        {"hour": "10", "count": 2},
        {"hour": "11", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_hour_of_day_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-20T10:00:00+00:00")
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")
    _seed_metric("cpu", 30, "2026-06-20T11:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_hour_of_day"] == [
        {"hour": "10", "count": 1},
        {"hour": "11", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_hour_of_day_filters_by_since_until():
    _seed_metric("m", 1, "2026-06-20T09:00:00+00:00")
    _seed_metric("m", 2, "2026-06-20T10:00:00+00:00")
    _seed_metric("m", 3, "2026-06-20T11:00:00+00:00")
    _seed_metric("m", 4, "2026-06-20T12:00:00+00:00")
    # `+` は URL クエリ内では空白として解釈されるため、`%2B` にエンコードして送る。
    resp = _client().get(
        "/api/v1/metrics/by_hour_of_day?since=2026-06-20T10:00:00%2B00:00&until=2026-06-20T11:30:00%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_hour_of_day"] == [
        {"hour": "10", "count": 1},
        {"hour": "11", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_hour_of_day_converts_non_utc_timestamps_to_utc():
    # JST 2026-06-21 08:00 → UTC 2026-06-20 23:00 (hour=23)
    _seed_metric("m", 1, "2026-06-21T08:00:00+09:00")
    # JST 2026-06-21 09:00 → UTC 2026-06-21 00:00 (hour=00)
    _seed_metric("m", 2, "2026-06-21T09:00:00+09:00")
    # JST 2026-06-21 10:00 → UTC 2026-06-21 01:00 (hour=01)
    _seed_metric("m", 3, "2026-06-21T10:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_hours"] == 3
    hours = {row["hour"]: row["count"] for row in body["by_hour_of_day"]}
    assert hours == {"23": 1, "00": 1, "01": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_hour_of_day_ignores_broken_recorded_at():
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
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_hour_of_day"] == [{"hour": "10", "count": 1}]


# ---- バリデーションエラー ----


def test_by_hour_of_day_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_hour_of_day?since=not-a-date")
    assert resp.status_code == 400


def test_by_hour_of_day_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_hour_of_day?since=2026-06-22T00:00:00%2B00:00&until=2026-06-20T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_hour_of_day_does_not_collide_with_metric_name_route():
    """`by_hour_of_day` が `{metric_name}` にルーティングされずに by_hour_of_day handler にマッチすることを確認。

    もし `/{metric_name}` が `/by_hour_of_day` より前に登録されると、`metric_name == "by_hour_of_day"` として
    捕捉され 404 (No metrics found for 'by_hour_of_day') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_hour_of_day")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_hour_of_day" in body
    assert "detail" not in body
