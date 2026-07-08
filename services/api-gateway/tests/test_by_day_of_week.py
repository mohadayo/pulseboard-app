"""api-gateway の `/api/v1/metrics/by_day_of_week` エンドポイントの回帰テスト。

`test_by_hour_of_day.py` と対称に、周期集計軸を「曜日 (ISO %u で 1=Mon 〜 7=Sun)」で
切った際の挙動を回帰する。fixture 規約 (`_reset_state` を setup で呼ぶ) は
`test_by_hour_of_day.py` / `test_by_day.py` と揃える。
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
    曜日ビニングのテストが書けないため、ストアに直接 push する。
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


def test_by_day_of_week_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    assert resp.json() == {
        "total": 0,
        "distinct_days_of_week": 0,
        "by_day_of_week": [],
    }


def test_by_day_of_week_empty_with_name_filter_returns_empty():
    # 2026-06-15 は月曜 (day="1")。他 name のみのストアに missing フィルタを掛ける。
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_day_of_week?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {
        "total": 0,
        "distinct_days_of_week": 0,
        "by_day_of_week": [],
    }


# ---- 基本的な UTC 曜日ビニング ----


def test_by_day_of_week_groups_by_iso_weekday_utc():
    # 2026-06-15 (月) と 2026-06-17 (水) を混在させ、曜日単位で集計される事を確認。
    _seed_metric("cpu", 10, "2026-06-15T00:00:00+00:00")   # Mon
    _seed_metric("cpu", 20, "2026-06-15T23:59:59+00:00")   # Mon (同日別時刻)
    _seed_metric("cpu", 30, "2026-06-22T12:00:00+00:00")   # Mon (別週の同曜日)
    _seed_metric("cpu", 40, "2026-06-17T09:00:00+00:00")   # Wed
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_days_of_week"] == 2
    assert body["by_day_of_week"] == [
        {"day": "1", "weekday_name": "Mon", "count": 3},
        {"day": "3", "weekday_name": "Wed", "count": 1},
    ]


def test_by_day_of_week_sorted_lex_ascending_matches_calendar_weekday():
    # 挿入順を「日→水→金→月」にしても、レスポンスは月→水→金→日 (ISO 1→3→5→7) の順。
    _seed_metric("m", 1, "2026-06-21T09:00:00+00:00")   # Sun (7)
    _seed_metric("m", 2, "2026-06-17T09:00:00+00:00")   # Wed (3)
    _seed_metric("m", 3, "2026-06-19T09:00:00+00:00")   # Fri (5)
    _seed_metric("m", 4, "2026-06-15T09:00:00+00:00")   # Mon (1)
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    days = [row["day"] for row in resp.json()["by_day_of_week"]]
    names = [row["weekday_name"] for row in resp.json()["by_day_of_week"]]
    assert days == ["1", "3", "5", "7"]
    assert names == ["Mon", "Wed", "Fri", "Sun"]


def test_by_day_of_week_all_seven_labels_are_correct():
    # 7 曜日全部を 1 件ずつ入れ、weekday_name の対応表 (Mon〜Sun) が
    # 全部正しく返ることを網羅的に確認する。
    _seed_metric("m", 1, "2026-06-15T09:00:00+00:00")   # Mon
    _seed_metric("m", 2, "2026-06-16T09:00:00+00:00")   # Tue
    _seed_metric("m", 3, "2026-06-17T09:00:00+00:00")   # Wed
    _seed_metric("m", 4, "2026-06-18T09:00:00+00:00")   # Thu
    _seed_metric("m", 5, "2026-06-19T09:00:00+00:00")   # Fri
    _seed_metric("m", 6, "2026-06-20T09:00:00+00:00")   # Sat
    _seed_metric("m", 7, "2026-06-21T09:00:00+00:00")   # Sun
    body = _client().get("/api/v1/metrics/by_day_of_week").json()
    assert body["distinct_days_of_week"] == 7
    labels_by_day = {r["day"]: r["weekday_name"] for r in body["by_day_of_week"]}
    assert labels_by_day == {
        "1": "Mon", "2": "Tue", "3": "Wed", "4": "Thu",
        "5": "Fri", "6": "Sat", "7": "Sun",
    }


def test_by_day_of_week_aggregates_across_metric_names():
    # 同じ曜日に異なる name のレコードが集約されること。
    _seed_metric("cpu", 10, "2026-06-15T09:00:00+00:00")   # Mon
    _seed_metric("mem", 20, "2026-06-15T10:00:00+00:00")   # Mon
    _seed_metric("disk", 30, "2026-06-17T09:00:00+00:00")  # Wed
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_day_of_week"] == [
        {"day": "1", "weekday_name": "Mon", "count": 2},
        {"day": "3", "weekday_name": "Wed", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_day_of_week_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-15T09:00:00+00:00")   # Mon
    _seed_metric("mem", 20, "2026-06-15T09:00:00+00:00")   # Mon (別 name)
    _seed_metric("cpu", 30, "2026-06-17T09:00:00+00:00")   # Wed
    resp = _client().get("/api/v1/metrics/by_day_of_week?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_day_of_week"] == [
        {"day": "1", "weekday_name": "Mon", "count": 1},
        {"day": "3", "weekday_name": "Wed", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_day_of_week_filters_by_since_until():
    # 4 日連続で 1 件ずつ入れ、真ん中 2 件のみを since/until で拾う。
    _seed_metric("m", 1, "2026-06-15T09:00:00+00:00")   # Mon
    _seed_metric("m", 2, "2026-06-16T09:00:00+00:00")   # Tue (window in)
    _seed_metric("m", 3, "2026-06-17T09:00:00+00:00")   # Wed (window in)
    _seed_metric("m", 4, "2026-06-18T09:00:00+00:00")   # Thu
    # `+` は URL クエリ内では空白として解釈されるため、`%2B` にエンコードして送る。
    resp = _client().get(
        "/api/v1/metrics/by_day_of_week"
        "?since=2026-06-16T00:00:00%2B00:00&until=2026-06-17T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_day_of_week"] == [
        {"day": "2", "weekday_name": "Tue", "count": 1},
        {"day": "3", "weekday_name": "Wed", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_day_of_week_converts_non_utc_timestamps_to_utc():
    # JST 2026-06-22 (Mon) 08:00 → UTC 2026-06-21 (Sun) 23:00 → day="7"
    _seed_metric("m", 1, "2026-06-22T08:00:00+09:00")
    # JST 2026-06-22 (Mon) 09:00 → UTC 2026-06-22 (Mon) 00:00 → day="1"
    _seed_metric("m", 2, "2026-06-22T09:00:00+09:00")
    # JST 2026-06-23 (Tue) 09:00 → UTC 2026-06-23 (Tue) 00:00 → day="2"
    _seed_metric("m", 3, "2026-06-23T09:00:00+09:00")
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_days_of_week"] == 3
    day_to_count = {row["day"]: row["count"] for row in body["by_day_of_week"]}
    assert day_to_count == {"7": 1, "1": 1, "2": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_day_of_week_ignores_broken_recorded_at():
    _seed_metric("good", 1, "2026-06-15T09:00:00+00:00")   # Mon
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
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_day_of_week"] == [
        {"day": "1", "weekday_name": "Mon", "count": 1},
    ]


# ---- バリデーションエラー ----


def test_by_day_of_week_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_day_of_week?since=not-a-date")
    assert resp.status_code == 400


def test_by_day_of_week_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_day_of_week"
        "?since=2026-06-22T00:00:00%2B00:00&until=2026-06-20T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_day_of_week_does_not_collide_with_metric_name_route():
    """`by_day_of_week` が `{metric_name}` にルーティングされずに by_day_of_week handler に
    マッチすることを確認。

    もし `/{metric_name}` が `/by_day_of_week` より前に登録されると、
    `metric_name == "by_day_of_week"` として捕捉され 404 (No metrics found for
    'by_day_of_week') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_day_of_week")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_day_of_week" in body
    assert "detail" not in body
