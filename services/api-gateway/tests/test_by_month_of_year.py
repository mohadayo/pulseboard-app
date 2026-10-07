"""api-gateway の `/api/v1/metrics/by_month_of_year` エンドポイントの回帰テスト。

`test_by_hour_of_day.py` / `test_by_day_of_week.py` と対称に、周期集計軸を
「月 (ISO %m で "01"=Jan 〜 "12"=Dec)」で切った際の挙動を回帰する。fixture 規約
(`_reset_state` を setup で呼ぶ) は既存の cyclic テストと揃える。
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
    月ビニングのテストが書けないため、ストアに直接 push する。
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


def test_by_month_of_year_empty_store_returns_empty():
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    assert resp.json() == {
        "total": 0,
        "distinct_months_of_year": 0,
        "by_month_of_year": [],
    }


def test_by_month_of_year_empty_with_name_filter_returns_empty():
    _seed_metric("cpu", 10, "2026-06-15T10:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month_of_year?name=missing_name")
    assert resp.status_code == 200
    assert resp.json() == {
        "total": 0,
        "distinct_months_of_year": 0,
        "by_month_of_year": [],
    }


# ---- 基本的な UTC 月ビニング ----


def test_by_month_of_year_groups_by_calendar_month_utc():
    # 2026-06 と 2027-06 (別年の同月) と 2026-11 を混在させ、月単位で集約されることを確認。
    _seed_metric("cpu", 10, "2026-06-01T00:00:00+00:00")   # Jun
    _seed_metric("cpu", 20, "2026-06-30T23:59:59+00:00")   # Jun (同月別日)
    _seed_metric("cpu", 30, "2027-06-15T12:00:00+00:00")   # Jun (別年同月)
    _seed_metric("cpu", 40, "2026-11-01T09:00:00+00:00")   # Nov
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 4
    assert body["distinct_months_of_year"] == 2
    assert body["by_month_of_year"] == [
        {"month": "06", "month_name": "Jun", "count": 3},
        {"month": "11", "month_name": "Nov", "count": 1},
    ]


def test_by_month_of_year_sorted_lex_ascending_matches_calendar_month():
    # 挿入順を「Dec→Mar→Oct→Jan」にしても、レスポンスは Jan→Mar→Oct→Dec の順。
    _seed_metric("m", 1, "2026-12-15T09:00:00+00:00")   # Dec (12)
    _seed_metric("m", 2, "2026-03-15T09:00:00+00:00")   # Mar (03)
    _seed_metric("m", 3, "2026-10-15T09:00:00+00:00")   # Oct (10)
    _seed_metric("m", 4, "2026-01-15T09:00:00+00:00")   # Jan (01)
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    months = [row["month"] for row in resp.json()["by_month_of_year"]]
    names = [row["month_name"] for row in resp.json()["by_month_of_year"]]
    assert months == ["01", "03", "10", "12"]
    assert names == ["Jan", "Mar", "Oct", "Dec"]


def test_by_month_of_year_all_twelve_labels_are_correct():
    # 12 ヶ月全部を 1 件ずつ入れ、month_name の対応表 (Jan〜Dec) が
    # 全部正しく返ることを網羅的に確認する。
    _seed_metric("m", 1, "2026-01-15T09:00:00+00:00")   # Jan
    _seed_metric("m", 2, "2026-02-15T09:00:00+00:00")   # Feb
    _seed_metric("m", 3, "2026-03-15T09:00:00+00:00")   # Mar
    _seed_metric("m", 4, "2026-04-15T09:00:00+00:00")   # Apr
    _seed_metric("m", 5, "2026-05-15T09:00:00+00:00")   # May
    _seed_metric("m", 6, "2026-06-15T09:00:00+00:00")   # Jun
    _seed_metric("m", 7, "2026-07-15T09:00:00+00:00")   # Jul
    _seed_metric("m", 8, "2026-08-15T09:00:00+00:00")   # Aug
    _seed_metric("m", 9, "2026-09-15T09:00:00+00:00")   # Sep
    _seed_metric("m", 10, "2026-10-15T09:00:00+00:00")  # Oct
    _seed_metric("m", 11, "2026-11-15T09:00:00+00:00")  # Nov
    _seed_metric("m", 12, "2026-12-15T09:00:00+00:00")  # Dec
    body = _client().get("/api/v1/metrics/by_month_of_year").json()
    assert body["distinct_months_of_year"] == 12
    labels_by_month = {r["month"]: r["month_name"] for r in body["by_month_of_year"]}
    assert labels_by_month == {
        "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
        "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
        "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
    }


def test_by_month_of_year_aggregates_across_metric_names():
    # 同じ月に異なる name のレコードが集約されること。
    _seed_metric("cpu", 10, "2026-06-15T09:00:00+00:00")   # Jun
    _seed_metric("mem", 20, "2026-06-20T10:00:00+00:00")   # Jun
    _seed_metric("disk", 30, "2026-11-01T09:00:00+00:00")  # Nov
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 3
    assert body["by_month_of_year"] == [
        {"month": "06", "month_name": "Jun", "count": 2},
        {"month": "11", "month_name": "Nov", "count": 1},
    ]


# ---- name フィルタ ----


def test_by_month_of_year_filters_by_name():
    _seed_metric("cpu", 10, "2026-06-15T09:00:00+00:00")   # Jun
    _seed_metric("mem", 20, "2026-06-15T09:00:00+00:00")   # Jun (別 name)
    _seed_metric("cpu", 30, "2026-11-15T09:00:00+00:00")   # Nov
    resp = _client().get("/api/v1/metrics/by_month_of_year?name=cpu")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_month_of_year"] == [
        {"month": "06", "month_name": "Jun", "count": 1},
        {"month": "11", "month_name": "Nov", "count": 1},
    ]


# ---- since / until フィルタ ----


def test_by_month_of_year_filters_by_since_until():
    _seed_metric("m", 1, "2026-05-15T09:00:00+00:00")   # May
    _seed_metric("m", 2, "2026-06-15T09:00:00+00:00")   # Jun (window in)
    _seed_metric("m", 3, "2026-07-15T09:00:00+00:00")   # Jul (window in)
    _seed_metric("m", 4, "2026-08-15T09:00:00+00:00")   # Aug
    # `+` は URL クエリ内では空白として解釈されるため、`%2B` にエンコードして送る。
    resp = _client().get(
        "/api/v1/metrics/by_month_of_year"
        "?since=2026-06-01T00:00:00%2B00:00&until=2026-07-31T23:59:59%2B00:00"
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert body["by_month_of_year"] == [
        {"month": "06", "month_name": "Jun", "count": 1},
        {"month": "07", "month_name": "Jul", "count": 1},
    ]


# ---- タイムゾーン変換 ----


def test_by_month_of_year_converts_non_utc_timestamps_to_utc():
    # JST 2026-07-01 08:00 → UTC 2026-06-30 23:00 → month="06"
    _seed_metric("m", 1, "2026-07-01T08:00:00+09:00")
    # JST 2026-07-01 09:00 → UTC 2026-07-01 00:00 → month="07"
    _seed_metric("m", 2, "2026-07-01T09:00:00+09:00")
    # UTC 2026-02-15 → month="02"
    _seed_metric("m", 3, "2026-02-15T09:00:00+00:00")
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["distinct_months_of_year"] == 3
    month_to_count = {row["month"]: row["count"] for row in body["by_month_of_year"]}
    assert month_to_count == {"02": 1, "06": 1, "07": 1}


# ---- 破損した recorded_at のスキップ ----


def test_by_month_of_year_ignores_broken_recorded_at():
    _seed_metric("good", 1, "2026-06-15T09:00:00+00:00")   # Jun
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
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["by_month_of_year"] == [
        {"month": "06", "month_name": "Jun", "count": 1},
    ]


# ---- バリデーションエラー ----


def test_by_month_of_year_invalid_since_returns_400():
    resp = _client().get("/api/v1/metrics/by_month_of_year?since=not-a-date")
    assert resp.status_code == 400


def test_by_month_of_year_since_greater_than_until_returns_400():
    resp = _client().get(
        "/api/v1/metrics/by_month_of_year"
        "?since=2026-07-01T00:00:00%2B00:00&until=2026-06-01T00:00:00%2B00:00"
    )
    assert resp.status_code == 400


# ---- 登録順衝突回避回帰防止 ----


def test_by_month_of_year_does_not_collide_with_metric_name_route():
    """`by_month_of_year` が `{metric_name}` にルーティングされずに by_month_of_year handler に
    マッチすることを確認。

    もし `/{metric_name}` が `/by_month_of_year` より前に登録されると、
    `metric_name == "by_month_of_year"` として捕捉され 404 (No metrics found for
    'by_month_of_year') が返るはずなので、そこを検証する。
    """
    resp = _client().get("/api/v1/metrics/by_month_of_year")
    assert resp.status_code == 200
    body = resp.json()
    assert "by_month_of_year" in body
    assert "detail" not in body
