import importlib
import math
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

import app as app_module
from app import app, _reset_state

client = TestClient(app)


def setup_function():
    _reset_state()


def test_health():
    resp = client.get("/health")
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "ok"
    assert data["service"] == "api-gateway"
    assert "timestamp" in data


def test_access_log_middleware_sets_response_time_header():
    # access_log_middleware が全レスポンスに X-Response-Time-Ms を付与すること。
    # 値は perf_counter() ベースで非負の浮動小数（ミリ秒）。
    resp = client.get("/health")
    assert resp.status_code == 200
    header = resp.headers.get("X-Response-Time-Ms")
    assert header is not None, "middleware should attach X-Response-Time-Ms"
    value = float(header)
    assert value >= 0.0


def test_access_log_middleware_runs_on_404():
    # 4xx 応答（未登録パス）に対しても middleware が実行されること。
    resp = client.get("/api/v1/metrics/__nonexistent__/latest")
    assert resp.status_code == 404
    assert "X-Response-Time-Ms" in resp.headers


def test_create_metric():
    resp = client.post("/api/v1/metrics", json={"name": "cpu_usage", "value": 72.5})
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "cpu_usage"
    assert data["value"] == 72.5
    assert "recorded_at" in data


def test_create_metric_with_tags():
    resp = client.post(
        "/api/v1/metrics",
        json={"name": "memory", "value": 4096, "tags": {"host": "srv-1"}},
    )
    assert resp.status_code == 201
    assert resp.json()["tags"] == {"host": "srv-1"}


def test_create_metric_invalid_name():
    resp = client.post("/api/v1/metrics", json={"name": "", "value": 1.0})
    assert resp.status_code == 422


def test_create_metric_rejects_positive_infinity():
    # JSON は 1e500 を許可するが、Python では +Infinity に解釈される。
    # サマリ等の数値出力を汚染しないよう 422 で拒否すること。
    resp = client.post(
        "/api/v1/metrics",
        content=b'{"name":"cpu","value":1e500}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 422


def test_create_metric_rejects_negative_infinity():
    resp = client.post(
        "/api/v1/metrics",
        content=b'{"name":"cpu","value":-1e500}',
        headers={"content-type": "application/json"},
    )
    assert resp.status_code == 422


def test_create_metric_rejects_nan_string():
    # Pydantic は `"NaN"` 等の文字列もパースしようとする可能性があるため、
    # 念のため明示的に拒否されることを確認する。
    resp = client.post(
        "/api/v1/metrics",
        json={"name": "cpu", "value": "NaN"},
    )
    assert resp.status_code == 422


def test_list_metrics_empty():
    resp = client.get("/api/v1/metrics")
    assert resp.status_code == 200
    assert resp.json()["count"] == 0


def test_list_metrics_with_filter():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 10})
    client.post("/api/v1/metrics", json={"name": "mem", "value": 20})
    resp = client.get("/api/v1/metrics?name=cpu")
    assert resp.json()["count"] == 1
    assert resp.json()["metrics"][0]["name"] == "cpu"


def test_list_metrics_response_includes_pagination_fields():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 10})
    resp = client.get("/api/v1/metrics")
    data = resp.json()
    assert "total" in data
    assert "limit" in data
    assert "offset" in data
    assert data["total"] == 1
    assert data["offset"] == 0
    # 既定の limit は 100 以上である（環境変数で上書き可だが、デフォルトは 100）
    assert data["limit"] >= 1


def test_list_metrics_limit_offset_paginates():
    for v in range(5):
        client.post("/api/v1/metrics", json={"name": "cpu", "value": float(v)})
    resp = client.get("/api/v1/metrics?limit=2&offset=1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert data["limit"] == 2
    assert data["offset"] == 1
    assert data["total"] == 5
    assert [m["value"] for m in data["metrics"]] == [1.0, 2.0]


def test_list_metrics_limit_zero_is_rejected():
    resp = client.get("/api/v1/metrics?limit=0")
    assert resp.status_code == 422


def test_list_metrics_negative_offset_is_rejected():
    resp = client.get("/api/v1/metrics?offset=-1")
    assert resp.status_code == 422


def test_list_metrics_limit_over_max_is_rejected():
    # 既定の上限は 1000。それを超えるリクエストは 422。
    resp = client.get("/api/v1/metrics?limit=1001")
    assert resp.status_code == 422


def test_list_metrics_since_filter():
    # 事前に 1 件投入し、その後の `recorded_at` を since に使う
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1})
    boundary = client.get("/api/v1/metrics").json()["metrics"][0]["recorded_at"]
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 2})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 3})

    # `params=` を使って httpx に URL エンコードを任せる
    # （`+00:00` のような ISO 文字列を URL に直書きすると `+` が空白として解釈される）。
    resp = client.get("/api/v1/metrics", params={"since": boundary})
    assert resp.status_code == 200
    data = resp.json()
    # since 境界は >= なので 1（境界そのもの）も含む
    assert data["total"] == 3


def test_list_metrics_until_filter():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1})
    boundary = client.get("/api/v1/metrics").json()["metrics"][0]["recorded_at"]
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 2})

    resp = client.get("/api/v1/metrics", params={"until": boundary})
    assert resp.status_code == 200
    data = resp.json()
    # until 境界は <= なので 1（境界そのもの）のみが対象
    assert data["total"] == 1


def test_list_metrics_since_greater_than_until_is_rejected():
    resp = client.get(
        "/api/v1/metrics?since=2030-01-02T00:00:00Z&until=2030-01-01T00:00:00Z"
    )
    assert resp.status_code == 400


def test_list_metrics_invalid_since_is_rejected():
    resp = client.get("/api/v1/metrics?since=not-a-date")
    assert resp.status_code == 400


def test_list_metrics_blank_since_is_rejected():
    resp = client.get("/api/v1/metrics?since=%20%20")
    assert resp.status_code == 400


def test_list_metrics_accepts_zulu_suffix():
    # 'Z' 末尾は ISO 8601 標準の UTC 表記。`fromisoformat` は Python 3.11+ で
    # 直接 'Z' を解釈できるが、明示的な動作確認として残しておく。
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1})
    resp = client.get("/api/v1/metrics?since=1970-01-01T00:00:00Z")
    assert resp.status_code == 200
    assert resp.json()["total"] == 1


def test_get_latest_metric():
    client.post("/api/v1/metrics", json={"name": "disk", "value": 50})
    client.post("/api/v1/metrics", json={"name": "disk", "value": 75})
    resp = client.get("/api/v1/metrics/disk/latest")
    assert resp.status_code == 200
    assert resp.json()["value"] == 75


def test_get_latest_metric_not_found():
    resp = client.get("/api/v1/metrics/nonexistent/latest")
    assert resp.status_code == 404


def test_delete_metrics():
    client.post("/api/v1/metrics", json={"name": "temp", "value": 36})
    resp = client.delete("/api/v1/metrics/temp")
    assert resp.status_code == 200
    assert resp.json()["deleted"] == 1


def test_delete_metrics_not_found():
    resp = client.delete("/api/v1/metrics/nonexistent")
    assert resp.status_code == 404


def test_get_metrics_by_name_returns_all_entries():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 10})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 20})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 30})
    resp = client.get("/api/v1/metrics/cpu")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "cpu"
    assert data["count"] == 3
    assert [m["value"] for m in data["metrics"]] == [10, 20, 30]


def test_get_metrics_by_name_not_found():
    resp = client.get("/api/v1/metrics/nonexistent")
    assert resp.status_code == 404


def test_get_metrics_by_name_does_not_shadow_latest():
    """`{metric_name}` ルートが `{metric_name}/latest` を奪わないことを確認。"""
    client.post("/api/v1/metrics", json={"name": "disk", "value": 1})
    client.post("/api/v1/metrics", json={"name": "disk", "value": 2})

    resp_all = client.get("/api/v1/metrics/disk")
    assert resp_all.status_code == 200
    assert resp_all.json()["count"] == 2

    resp_latest = client.get("/api/v1/metrics/disk/latest")
    assert resp_latest.status_code == 200
    assert resp_latest.json()["value"] == 2


def test_max_metrics_eviction(monkeypatch):
    """MAX_METRICS_PER_NAME を超えた古い記録が FIFO で破棄されることを確認。"""
    monkeypatch.setenv("MAX_METRICS_PER_NAME", "3")
    importlib.reload(app_module)
    new_client = TestClient(app_module.app)

    for v in [1, 2, 3, 4, 5]:
        new_client.post("/api/v1/metrics", json={"name": "cpu", "value": v})

    resp = new_client.get("/api/v1/metrics/cpu")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 3
    assert [m["value"] for m in data["metrics"]] == [3, 4, 5]

    # ID は累積カウンタで生成されるため、破棄後も新しい ID は衝突しない
    ids = [m["id"] for m in data["metrics"]]
    assert ids == ["cpu-2", "cpu-3", "cpu-4"]

    # 後始末：環境変数を戻して app モジュールを再ロード
    monkeypatch.delenv("MAX_METRICS_PER_NAME", raising=False)
    importlib.reload(app_module)


def test_max_metrics_disabled(monkeypatch):
    """MAX_METRICS_PER_NAME=0 を指定すると上限を無効化できる。"""
    monkeypatch.setenv("MAX_METRICS_PER_NAME", "0")
    importlib.reload(app_module)
    new_client = TestClient(app_module.app)

    for v in range(10):
        new_client.post("/api/v1/metrics", json={"name": "mem", "value": v})

    resp = new_client.get("/api/v1/metrics/mem")
    assert resp.json()["count"] == 10

    monkeypatch.delenv("MAX_METRICS_PER_NAME", raising=False)
    importlib.reload(app_module)


def test_metric_ids_are_unique_across_evictions(monkeypatch):
    """FIFO 削除後も `id` が衝突しないことを確認。"""
    monkeypatch.setenv("MAX_METRICS_PER_NAME", "2")
    importlib.reload(app_module)
    new_client = TestClient(app_module.app)

    seen_ids: set[str] = set()
    for v in range(5):
        resp = new_client.post("/api/v1/metrics", json={"name": "io", "value": v})
        new_id = resp.json()["id"]
        assert new_id not in seen_ids, f"duplicate id: {new_id}"
        seen_ids.add(new_id)

    monkeypatch.delenv("MAX_METRICS_PER_NAME", raising=False)
    importlib.reload(app_module)


def test_concurrent_post_assigns_unique_ids():
    """複数スレッドが同一 name へ並行 POST しても ID が一意であることを確認。

    FastAPI は def ハンドラをスレッドプールで実行するため、_store_lock が
    無いと `seq` の read-modify-write がレースし、ID が重複しうる。
    """
    total = 200

    def post_one(i: int) -> str:
        resp = client.post("/api/v1/metrics", json={"name": "race", "value": i})
        assert resp.status_code == 201, resp.text
        return resp.json()["id"]

    with ThreadPoolExecutor(max_workers=16) as pool:
        ids = list(pool.map(post_one, range(total)))

    assert len(ids) == total
    assert len(set(ids)) == total, f"duplicate id detected: {len(ids) - len(set(ids))} dup"

    # 投入順序に関わらず ID は 0..total-1 のセットになっている
    suffixes = sorted(int(i.rsplit("-", 1)[1]) for i in ids)
    assert suffixes == list(range(total))


def test_concurrent_post_respects_max_per_name(monkeypatch):
    """並行 POST 時にも MAX_METRICS_PER_NAME の上限が破られないことを確認。"""
    monkeypatch.setenv("MAX_METRICS_PER_NAME", "20")
    importlib.reload(app_module)
    new_client = TestClient(app_module.app)
    total = 200

    def post_one(i: int) -> int:
        resp = new_client.post("/api/v1/metrics", json={"name": "capped", "value": i})
        assert resp.status_code == 201, resp.text
        return resp.status_code

    with ThreadPoolExecutor(max_workers=16) as pool:
        list(pool.map(post_one, range(total)))

    resp = new_client.get("/api/v1/metrics/capped")
    assert resp.status_code == 200
    data = resp.json()
    # 上限ぴったり保持され、超過しない
    assert data["count"] == 20
    # ID は累積カウンタ由来なので、保持されているのは最も新しい 20 件
    suffixes = sorted(int(m["id"].rsplit("-", 1)[1]) for m in data["metrics"])
    assert suffixes == list(range(total - 20, total))

    monkeypatch.delenv("MAX_METRICS_PER_NAME", raising=False)
    importlib.reload(app_module)


def test_concurrent_delete_and_post_keeps_state_consistent():
    """DELETE と POST が並行しても、内部状態（store と seq）が整合する。

    DELETE が store と seq を別々に pop していると、間に走った POST が
    新しい entry を作り、seq だけが残るような不整合が起きる可能性があった。
    """
    # 事前に 10 件入れておく
    for v in range(10):
        client.post("/api/v1/metrics", json={"name": "shared", "value": v})

    # DELETE と POST を並行
    def do_delete() -> int:
        return client.delete("/api/v1/metrics/shared").status_code

    def do_post(i: int) -> int:
        return client.post("/api/v1/metrics", json={"name": "shared", "value": i}).status_code

    with ThreadPoolExecutor(max_workers=8) as pool:
        delete_future = pool.submit(do_delete)
        post_futures = [pool.submit(do_post, i) for i in range(100, 130)]
        delete_future.result()
        for f in post_futures:
            f.result()

    # 並行アクセスの後でも、最終状態の ID は重複しない
    resp = client.get("/api/v1/metrics/shared")
    if resp.status_code == 200:
        ids = [m["id"] for m in resp.json()["metrics"]]
        assert len(ids) == len(set(ids)), "ids must remain unique after concurrent delete/post"


def test_get_metric_stats():
    for v in [10.0, 20.0, 30.0, 40.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    resp = client.get("/api/v1/metrics/cpu/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "cpu"
    assert data["count"] == 4
    assert data["min"] == 10.0
    assert data["max"] == 40.0
    assert data["sum"] == 100.0
    assert data["avg"] == 25.0
    assert data["latest"] == 40.0
    assert "latest_recorded_at" in data
    assert "first_recorded_at" in data
    # 線形補間: rank=0.5*3=1.5 → (20+30)/2 = 25.0
    assert data["p50"] == 25.0


def test_get_metric_stats_single_value():
    client.post("/api/v1/metrics", json={"name": "mem", "value": 512.0})
    resp = client.get("/api/v1/metrics/mem/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["min"] == data["max"] == data["avg"] == data["latest"] == 512.0
    # 単一値の場合、全パーセンタイルはその値と等しい
    assert data["p50"] == data["p95"] == data["p99"] == 512.0


def test_get_metric_stats_not_found():
    resp = client.get("/api/v1/metrics/nonexistent/stats")
    assert resp.status_code == 404


def test_get_metric_stats_does_not_shadow_other_routes():
    """`{metric_name}/stats` ルートが `{metric_name}` / `{metric_name}/latest` と衝突しないことを確認。"""
    client.post("/api/v1/metrics", json={"name": "disk", "value": 1})
    client.post("/api/v1/metrics", json={"name": "disk", "value": 2})

    assert client.get("/api/v1/metrics/disk").json()["count"] == 2
    assert client.get("/api/v1/metrics/disk/latest").json()["value"] == 2

    stats = client.get("/api/v1/metrics/disk/stats").json()
    assert stats["count"] == 2
    assert stats["latest"] == 2


def test_get_metric_stats_percentiles_five_values():
    # 1..5 をソート済みとして与えるとき:
    #   p50: rank = 0.5*4 = 2  → values[2] = 3.0
    #   p95: rank = 0.95*4 = 3.8 → values[3]*(1-0.8) + values[4]*0.8 = 4*0.2 + 5*0.8 = 4.8
    #   p99: rank = 0.99*4 = 3.96 → 4*0.04 + 5*0.96 = 4.96
    for v in [3.0, 1.0, 5.0, 2.0, 4.0]:  # 順不同で投入
        client.post("/api/v1/metrics", json={"name": "lat", "value": v})
    data = client.get("/api/v1/metrics/lat/stats").json()
    assert data["count"] == 5
    assert data["p50"] == 3.0
    assert data["p95"] == pytest.approx(4.8)
    assert data["p99"] == pytest.approx(4.96)


def test_get_metric_stats_percentiles_monotonic():
    # 同一値が並ぶ場合、全パーセンタイルは同値になる
    for _ in range(10):
        client.post("/api/v1/metrics", json={"name": "flat", "value": 42.0})
    data = client.get("/api/v1/metrics/flat/stats").json()
    assert data["p50"] == data["p95"] == data["p99"] == 42.0
    assert data["min"] == data["max"] == 42.0


def test_get_metric_stats_std_dev_single_value_is_zero():
    # 観測 1 件は平均と等しいため、母標準偏差は 0 になる（ゼロ除算ではない）。
    client.post("/api/v1/metrics", json={"name": "mem", "value": 512.0})
    data = client.get("/api/v1/metrics/mem/stats").json()
    assert data["std_dev"] == 0.0


def test_get_metric_stats_variance_single_value_is_zero():
    # 観測 1 件のときの分散も 0。
    client.post("/api/v1/metrics", json={"name": "mem", "value": 512.0})
    data = client.get("/api/v1/metrics/mem/stats").json()
    assert data["variance"] == 0.0


def test_get_metric_stats_variance_population_definition():
    # 母集団分散の既知値で確認する。values=[10,20,30,40] のとき
    #   variance = ((10-25)^2 + (20-25)^2 + (30-25)^2 + (40-25)^2) / 4
    #            = (225 + 25 + 25 + 225) / 4 = 125
    for v in [10.0, 20.0, 30.0, 40.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    data = client.get("/api/v1/metrics/cpu/stats").json()
    assert data["variance"] == pytest.approx(125.0)
    # std_dev = sqrt(variance) の関係も保たれる（metrics-worker と同じ式）。
    assert data["std_dev"] == pytest.approx(math.sqrt(data["variance"]))


def test_get_metric_stats_std_dev_identical_values_is_zero():
    # 全て同じ値だけが入っている場合、ばらつきはなく std_dev は 0。
    for _ in range(5):
        client.post("/api/v1/metrics", json={"name": "flat", "value": 7.5})
    data = client.get("/api/v1/metrics/flat/stats").json()
    assert data["std_dev"] == 0.0


def test_get_metric_stats_std_dev_population_definition():
    # 母標準偏差の既知値で確認する。values=[10,20,30,40] のとき
    #   avg = 25
    #   variance = ((10-25)^2 + (20-25)^2 + (30-25)^2 + (40-25)^2) / 4
    #            = (225 + 25 + 25 + 225) / 4 = 125
    #   std_dev = sqrt(125) ≈ 11.18033989
    for v in [10.0, 20.0, 30.0, 40.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    data = client.get("/api/v1/metrics/cpu/stats").json()
    assert data["std_dev"] == pytest.approx(math.sqrt(125.0))


def test_get_metric_stats_std_dev_respects_time_filter():
    # since/until でフィルタした後の値だけで std_dev を再計算する。
    # b の recorded_at を `until` に渡すと a/b の 2 件が対象になり、
    # それらの母標準偏差で再計算されることを確認する。
    from urllib.parse import quote
    a = client.post("/api/v1/metrics", json={"name": "lat", "value": 10.0}).json()
    b = client.post("/api/v1/metrics", json={"name": "lat", "value": 20.0}).json()
    client.post("/api/v1/metrics", json={"name": "lat", "value": 30.0})
    b_ts = quote(b["recorded_at"], safe="")
    data = client.get(f"/api/v1/metrics/lat/stats?until={b_ts}").json()
    assert data["count"] == 2
    # values=[10,20], avg=15, variance=((10-15)^2 + (20-15)^2)/2 = 25, std_dev=5
    assert data["std_dev"] == pytest.approx(5.0)
    # a 単独でフィルタすると std_dev=0
    from urllib.parse import quote as q
    a_ts = q(a["recorded_at"], safe="")
    data_a = client.get(f"/api/v1/metrics/lat/stats?until={a_ts}").json()
    assert data_a["count"] == 1
    assert data_a["std_dev"] == 0.0


def test_get_metric_stats_includes_cv_field():
    # レスポンス JSON に cv フィールドが含まれることを確認（消費側 API の保証）。
    for v in [10.0, 20.0, 30.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    data = client.get("/api/v1/metrics/cpu/stats").json()
    assert "cv" in data


def test_get_metric_stats_cv_population_definition():
    # values=[8,9,10,11,12]: avg=10, variance=((−2)^2+(−1)^2+0+1^2+2^2)/5=2
    # std_dev=sqrt(2), cv=sqrt(2)/10
    for v in [8.0, 9.0, 10.0, 11.0, 12.0]:
        client.post("/api/v1/metrics", json={"name": "rtt", "value": v})
    data = client.get("/api/v1/metrics/rtt/stats").json()
    expected_cv = math.sqrt(2) / 10
    assert data["cv"] == pytest.approx(expected_cv, rel=1e-9)


def test_get_metric_stats_cv_zero_when_avg_is_zero():
    # avg = 0 のときは 0/0 不定なので cv = 0.0 を返す。
    for v in [-5.0, 0.0, 5.0]:
        client.post("/api/v1/metrics", json={"name": "delta", "value": v})
    data = client.get("/api/v1/metrics/delta/stats").json()
    assert data["avg"] == 0.0
    assert data["cv"] == 0.0


def test_get_metric_stats_cv_zero_for_constant_values():
    # 定数入力は std_dev=0 なので cv=0。
    for _ in range(5):
        client.post("/api/v1/metrics", json={"name": "flat", "value": 42.0})
    data = client.get("/api/v1/metrics/flat/stats").json()
    assert data["cv"] == 0.0


def test_get_metric_stats_cv_positive_for_negative_avg():
    # avg < 0 でも |avg| を使うため cv は非負になる。
    for v in [-12.0, -10.0, -8.0]:
        client.post("/api/v1/metrics", json={"name": "neg", "value": v})
    data = client.get("/api/v1/metrics/neg/stats").json()
    # avg = -10, variance = (4+0+4)/3 = 8/3, std_dev = sqrt(8/3)
    # cv = sqrt(8/3) / 10
    expected_cv = math.sqrt(8.0 / 3.0) / 10
    assert data["cv"] == pytest.approx(expected_cv, rel=1e-9)
    assert data["cv"] >= 0


def test_get_metric_stats_includes_skewness_field():
    # レスポンス JSON に skewness フィールドが含まれることを確認（消費側 API の保証）。
    for v in [10.0, 20.0, 30.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    data = client.get("/api/v1/metrics/cpu/stats").json()
    assert "skewness" in data


def test_get_metric_stats_skewness_symmetric_distribution_is_zero():
    # 対称分布 {1,2,3,4,5}: avg=3, Σ(x-μ)³ = -8 -1 +0 +1 +8 = 0 → skewness=0
    for v in [1.0, 2.0, 3.0, 4.0, 5.0]:
        client.post("/api/v1/metrics", json={"name": "sym", "value": v})
    data = client.get("/api/v1/metrics/sym/stats").json()
    assert data["skewness"] == pytest.approx(0.0, abs=1e-12)


def test_get_metric_stats_skewness_right_tailed_is_positive():
    # 右裾分布 {1,1,1,1,10}: 大きな値が少数で離れている → 正の歪度
    for v in [1.0, 1.0, 1.0, 1.0, 10.0]:
        client.post("/api/v1/metrics", json={"name": "right", "value": v})
    data = client.get("/api/v1/metrics/right/stats").json()
    assert data["skewness"] > 0


def test_get_metric_stats_skewness_left_tailed_is_negative():
    # 左裾分布 {1,10,10,10,10}: 小さな値が少数で離れている → 負の歪度
    for v in [1.0, 10.0, 10.0, 10.0, 10.0]:
        client.post("/api/v1/metrics", json={"name": "left", "value": v})
    data = client.get("/api/v1/metrics/left/stats").json()
    assert data["skewness"] < 0


def test_get_metric_stats_skewness_constant_input_is_zero():
    # 定数入力は std_dev=0 で歪度は定義不能なので 0 を返す（cv の avg=0 と同じ規約）。
    for _ in range(5):
        client.post("/api/v1/metrics", json={"name": "flat", "value": 42.0})
    data = client.get("/api/v1/metrics/flat/stats").json()
    assert data["skewness"] == 0.0


def test_get_metric_stats_skewness_single_value_is_zero():
    # 単一観測は std_dev=0 なので 0 を返す。
    client.post("/api/v1/metrics", json={"name": "one", "value": 7.0})
    data = client.get("/api/v1/metrics/one/stats").json()
    assert data["skewness"] == 0.0


def test_get_metric_stats_skewness_exact_value():
    # 既知厳密値で検証する。values=[1,2,3,4,10]:
    #   avg = 4
    #   Σ(x-μ)² = 9 + 4 + 1 + 0 + 36 = 50 → variance = 10, std_dev = sqrt(10)
    #   Σ(x-μ)³ = -27 - 8 - 1 + 0 + 216 = 180 → m3 = 36
    #   skewness = 36 / (sqrt(10))³ = 36 / (10 * sqrt(10)) = 3.6 / sqrt(10)
    for v in [1.0, 2.0, 3.0, 4.0, 10.0]:
        client.post("/api/v1/metrics", json={"name": "rsk", "value": v})
    data = client.get("/api/v1/metrics/rsk/stats").json()
    expected = 3.6 / math.sqrt(10.0)
    assert data["skewness"] == pytest.approx(expected, rel=1e-9)


def test_get_metric_stats_skewness_sign_inverts_when_reflected():
    # 入力を反転 (v → 2*avg - v) させると skewness の符号も反転する。
    # right の {1,1,1,1,10} を avg=2.8 で反転: {4.6,4.6,4.6,4.6,-4.4}
    for v in [1.0, 1.0, 1.0, 1.0, 10.0]:
        client.post("/api/v1/metrics", json={"name": "r", "value": v})
    right = client.get("/api/v1/metrics/r/stats").json()["skewness"]

    avg_r = 2.8  # = (1+1+1+1+10)/5
    for v in [1.0, 1.0, 1.0, 1.0, 10.0]:
        client.post("/api/v1/metrics", json={"name": "l", "value": 2 * avg_r - v})
    left = client.get("/api/v1/metrics/l/stats").json()["skewness"]

    assert right == pytest.approx(-left, rel=1e-9)


def test_get_metric_stats_includes_kurtosis_field():
    # レスポンス JSON に kurtosis フィールドが含まれることを確認（消費側 API の保証）。
    for v in [10.0, 20.0, 30.0]:
        client.post("/api/v1/metrics", json={"name": "cpu", "value": v})
    data = client.get("/api/v1/metrics/cpu/stats").json()
    assert "kurtosis" in data


def test_get_metric_stats_kurtosis_constant_input_is_zero():
    # 定数入力は std_dev=0 で kurtosis は定義不能なので 0 を返す（skewness の σ=0 と同じ規約）。
    for _ in range(5):
        client.post("/api/v1/metrics", json={"name": "flat", "value": 42.0})
    data = client.get("/api/v1/metrics/flat/stats").json()
    assert data["kurtosis"] == 0.0


def test_get_metric_stats_kurtosis_single_value_is_zero():
    # 単一観測は std_dev=0 なので 0 を返す。
    client.post("/api/v1/metrics", json={"name": "one", "value": 7.0})
    data = client.get("/api/v1/metrics/one/stats").json()
    assert data["kurtosis"] == 0.0


def test_get_metric_stats_kurtosis_heavy_tail_is_above_three():
    # heavy-tail 分布: 平均近傍に集中しつつ大きな外れ値が出るケース → kurtosis > 3。
    for _ in range(9):
        client.post("/api/v1/metrics", json={"name": "heavy", "value": 0.0})
    client.post("/api/v1/metrics", json={"name": "heavy", "value": 100.0})
    data = client.get("/api/v1/metrics/heavy/stats").json()
    assert data["kurtosis"] > 3.0


def test_get_metric_stats_kurtosis_exact_value_two_point_distribution():
    # 2 値分布 {-1, 1}: avg=0, σ²=1, σ=1, Σ(x-0)⁴ = 2, m4 = 1, kurtosis = 1。
    # 2 値分布は kurtosis の理論最小値 1 を取る。
    for v in [-1.0, 1.0]:
        client.post("/api/v1/metrics", json={"name": "two", "value": v})
    data = client.get("/api/v1/metrics/two/stats").json()
    assert data["kurtosis"] == pytest.approx(1.0, abs=1e-9)


def test_get_metric_stats_kurtosis_is_shift_invariant():
    # kurtosis は中心化モーメントの比なので、入力に定数を加えても変わらない。
    for v in [1.0, 2.0, 3.0, 4.0, 5.0]:
        client.post("/api/v1/metrics", json={"name": "a", "value": v})
    for v in [1.0, 2.0, 3.0, 4.0, 5.0]:
        client.post("/api/v1/metrics", json={"name": "b", "value": v + 1000.0})
    ka = client.get("/api/v1/metrics/a/stats").json()["kurtosis"]
    kb = client.get("/api/v1/metrics/b/stats").json()["kurtosis"]
    assert ka == pytest.approx(kb, rel=1e-9)


def test_get_metric_stats_kurtosis_is_non_negative():
    # kurtosis は定義上 Σ(x-μ)⁴ >= 0 なので常に非負。
    for v in [1.0, 2.0, 3.0, 4.0, 5.0]:
        client.post("/api/v1/metrics", json={"name": "nn", "value": v})
    data = client.get("/api/v1/metrics/nn/stats").json()
    assert data["kurtosis"] >= 0


def test_get_metrics_by_name_pagination():
    for v in range(5):
        client.post("/api/v1/metrics", json={"name": "load", "value": float(v)})
    resp = client.get("/api/v1/metrics/load?limit=2&offset=1")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "load"
    assert data["total"] == 5
    assert data["count"] == 2
    assert data["limit"] == 2
    assert data["offset"] == 1
    assert [m["value"] for m in data["metrics"]] == [1.0, 2.0]


def test_get_metrics_by_name_pagination_offset_beyond_total():
    client.post("/api/v1/metrics", json={"name": "load", "value": 1.0})
    resp = client.get("/api/v1/metrics/load?offset=99")
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 1
    assert data["count"] == 0
    assert data["metrics"] == []


def test_get_metrics_by_name_limit_zero_is_rejected():
    client.post("/api/v1/metrics", json={"name": "load", "value": 1.0})
    resp = client.get("/api/v1/metrics/load?limit=0")
    assert resp.status_code == 422


def test_get_metrics_by_name_since_until_filter():
    from urllib.parse import quote
    # 3 件 POST し、その時刻スタンプを使って範囲フィルタを検証する。
    a = client.post("/api/v1/metrics", json={"name": "io", "value": 1.0}).json()
    b = client.post("/api/v1/metrics", json={"name": "io", "value": 2.0}).json()
    c = client.post("/api/v1/metrics", json={"name": "io", "value": 3.0}).json()
    # recorded_at は `+00:00` を含むため、クエリ文字列に渡す際は URL エンコードする。
    a_ts = quote(a["recorded_at"], safe="")
    b_ts = quote(b["recorded_at"], safe="")
    c_ts = quote(c["recorded_at"], safe="")
    # since=b の時刻 以降 → b, c の 2 件
    resp = client.get(f"/api/v1/metrics/io?since={b_ts}")
    assert resp.status_code == 200
    assert resp.json()["count"] == 2
    # until=b の時刻 まで → a, b の 2 件
    resp = client.get(f"/api/v1/metrics/io?until={b_ts}")
    assert resp.status_code == 200
    assert resp.json()["count"] == 2
    # since=a, until=c は全件
    resp = client.get(f"/api/v1/metrics/io?since={a_ts}&until={c_ts}")
    assert resp.status_code == 200
    assert resp.json()["count"] == 3


def test_get_metrics_by_name_since_greater_than_until_rejected():
    client.post("/api/v1/metrics", json={"name": "io", "value": 1.0})
    resp = client.get(
        "/api/v1/metrics/io?since=2026-01-01T00:00:00Z&until=2024-01-01T00:00:00Z"
    )
    assert resp.status_code == 400


def test_get_metrics_by_name_invalid_since_rejected():
    client.post("/api/v1/metrics", json={"name": "io", "value": 1.0})
    resp = client.get("/api/v1/metrics/io?since=not-a-date")
    assert resp.status_code == 400


def test_get_metric_stats_since_until_filter():
    from urllib.parse import quote
    a = client.post("/api/v1/metrics", json={"name": "lat", "value": 10.0}).json()
    b = client.post("/api/v1/metrics", json={"name": "lat", "value": 20.0}).json()
    c = client.post("/api/v1/metrics", json={"name": "lat", "value": 30.0}).json()
    a_ts = quote(a["recorded_at"], safe="")
    b_ts = quote(b["recorded_at"], safe="")
    c_ts = quote(c["recorded_at"], safe="")
    # 全期間
    resp = client.get("/api/v1/metrics/lat/stats")
    assert resp.status_code == 200
    assert resp.json()["count"] == 3
    # since=b 以降
    resp = client.get(f"/api/v1/metrics/lat/stats?since={b_ts}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 2
    assert data["min"] == 20.0
    assert data["max"] == 30.0
    assert data["avg"] == 25.0
    # until=a まで
    resp = client.get(f"/api/v1/metrics/lat/stats?until={a_ts}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 1
    assert data["min"] == 10.0
    assert data["max"] == 10.0
    # since=a, until=c は全件
    resp = client.get(f"/api/v1/metrics/lat/stats?since={a_ts}&until={c_ts}")
    assert resp.status_code == 200
    assert resp.json()["count"] == 3


def test_get_metric_stats_empty_window_returns_404():
    # データはあるが範囲指定で 0 件のときは 404
    client.post("/api/v1/metrics", json={"name": "lat", "value": 1.0})
    resp = client.get("/api/v1/metrics/lat/stats?since=2099-01-01T00:00:00Z")
    assert resp.status_code == 404


def test_get_metric_stats_invalid_since_rejected():
    client.post("/api/v1/metrics", json={"name": "lat", "value": 1.0})
    resp = client.get("/api/v1/metrics/lat/stats?since=not-a-date")
    assert resp.status_code == 400


# --- GET /api/v1/metrics/names ---

def test_list_metric_names_empty():
    resp = client.get("/api/v1/metrics/names")
    assert resp.status_code == 200
    data = resp.json()
    assert data == {"names": [], "count": 0}


def test_list_metric_names_returns_distinct_names_sorted():
    # 投入順は cpu→mem→cpu→disk だが、レスポンスは name 昇順 (cpu, disk, mem)。
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "mem", "value": 2.0})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 3.0})
    client.post("/api/v1/metrics", json={"name": "disk", "value": 4.0})
    resp = client.get("/api/v1/metrics/names")
    assert resp.status_code == 200
    data = resp.json()
    assert data["count"] == 3
    names = data["names"]
    assert [n["name"] for n in names] == ["cpu", "disk", "mem"]
    cpu = next(n for n in names if n["name"] == "cpu")
    assert cpu["count"] == 2
    disk = next(n for n in names if n["name"] == "disk")
    assert disk["count"] == 1
    mem = next(n for n in names if n["name"] == "mem")
    assert mem["count"] == 1
    # 各 name に latest_recorded_at が含まれる
    assert cpu["latest_recorded_at"] is not None
    assert disk["latest_recorded_at"] is not None
    assert mem["latest_recorded_at"] is not None


def test_list_metric_names_latest_recorded_at_is_last_post():
    # POST 順 == ロック内 append 順なので、末尾の recorded_at が latest になる。
    r1 = client.post("/api/v1/metrics", json={"name": "lat", "value": 1.0})
    r2 = client.post("/api/v1/metrics", json={"name": "lat", "value": 2.0})
    first_at = r1.json()["recorded_at"]
    second_at = r2.json()["recorded_at"]
    resp = client.get("/api/v1/metrics/names")
    assert resp.status_code == 200
    lat = next(n for n in resp.json()["names"] if n["name"] == "lat")
    assert lat["count"] == 2
    assert lat["latest_recorded_at"] == second_at
    assert lat["latest_recorded_at"] != first_at or second_at == first_at


def test_list_metric_names_does_not_collide_with_path_param():
    # `/api/v1/metrics/names` が `/api/v1/metrics/{metric_name}` (metric_name="names")
    # に誤マッチしないこと。誤マッチした場合は格納されていないため 404 になるが、
    # 本エンドポイントは静的セグメントを先に登録しているため 200 を返す。
    resp = client.get("/api/v1/metrics/names")
    assert resp.status_code == 200
    assert resp.json() == {"names": [], "count": 0}


def test_list_metric_names_excludes_deleted_metrics():
    client.post("/api/v1/metrics", json={"name": "tmp", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "keep", "value": 2.0})
    # tmp を削除すると names には現れない
    del_resp = client.delete("/api/v1/metrics/tmp")
    assert del_resp.status_code == 200
    resp = client.get("/api/v1/metrics/names")
    assert resp.status_code == 200
    assert [n["name"] for n in resp.json()["names"]] == ["keep"]


# ---- /api/v1/metrics/count ----

def test_count_metrics_empty_store():
    resp = client.get("/api/v1/metrics/count")
    assert resp.status_code == 200
    body = resp.json()
    assert body == {"total_metrics": 0, "distinct_names": 0, "by_name": {}}


def test_count_metrics_basic():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 2.0})
    client.post("/api/v1/metrics", json={"name": "mem", "value": 100.0})
    resp = client.get("/api/v1/metrics/count")
    body = resp.json()
    assert body["total_metrics"] == 3
    assert body["distinct_names"] == 2
    assert body["by_name"] == {"cpu": 2, "mem": 1}


def test_count_metrics_omits_empty_after_delete():
    # /count は時間フィルタ後 0 件の name を by_name に含めない設計。
    # delete で全削除した name は store からも消えるが、念のため一致する挙動か確認。
    client.post("/api/v1/metrics", json={"name": "doomed", "value": 1.0})
    client.delete("/api/v1/metrics/doomed")
    client.post("/api/v1/metrics", json={"name": "kept", "value": 2.0})
    resp = client.get("/api/v1/metrics/count")
    body = resp.json()
    assert body == {"total_metrics": 1, "distinct_names": 1, "by_name": {"kept": 1}}


def test_count_metrics_since_filter():
    # 過去・未来の境界が動かないよう、固定の ISO 文字列を使った時間境界をテスト
    client.post("/api/v1/metrics", json={"name": "a", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "b", "value": 2.0})
    # since が現在より十分未来なら 0 件
    resp = client.get("/api/v1/metrics/count?since=2999-01-01T00:00:00Z")
    body = resp.json()
    assert body == {"total_metrics": 0, "distinct_names": 0, "by_name": {}}


def test_count_metrics_until_filter():
    client.post("/api/v1/metrics", json={"name": "a", "value": 1.0})
    # until が十分過去なら 0 件
    resp = client.get("/api/v1/metrics/count?until=2000-01-01T00:00:00Z")
    body = resp.json()
    assert body["total_metrics"] == 0
    assert body["by_name"] == {}


def test_count_metrics_since_includes_recent():
    # since=過去 なら全件含まれる
    client.post("/api/v1/metrics", json={"name": "a", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "a", "value": 2.0})
    resp = client.get("/api/v1/metrics/count?since=2000-01-01T00:00:00Z")
    body = resp.json()
    assert body["total_metrics"] == 2
    assert body["by_name"] == {"a": 2}


def test_count_metrics_rejects_invalid_since():
    resp = client.get("/api/v1/metrics/count?since=not-a-date")
    assert resp.status_code == 400


def test_count_metrics_rejects_blank_since():
    resp = client.get("/api/v1/metrics/count?since=%20")
    assert resp.status_code == 400


def test_count_metrics_rejects_since_after_until():
    resp = client.get(
        "/api/v1/metrics/count?since=2026-12-01T00:00:00Z&until=2026-01-01T00:00:00Z"
    )
    assert resp.status_code == 400


def test_count_metrics_does_not_collide_with_path_param():
    # /api/v1/metrics/count は /api/v1/metrics/{metric_name} と URL 形が似ているが、
    # FastAPI は登録順で /count を先に評価するため、metric_name="count" として
    # 解釈されないことを保証する。
    client.post("/api/v1/metrics", json={"name": "x", "value": 1.0})
    resp = client.get("/api/v1/metrics/count")
    assert resp.status_code == 200
    body = resp.json()
    assert "total_metrics" in body
    # かつ /{metric_name} 経由で count という名前のメトリクスが定義されていれば
    # 当然 404 になる（事故防止のための明示テスト）。
    resp_path = client.get("/api/v1/metrics/count_no_such_metric")
    assert resp_path.status_code == 404


# --- DELETE /api/v1/metrics (全メトリクス一括削除) ---

def test_delete_all_metrics_empty_store_returns_zero():
    resp = client.delete("/api/v1/metrics")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 0}


def test_delete_all_metrics_removes_all():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "mem", "value": 2.0})
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 3.0})

    resp = client.delete("/api/v1/metrics")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 3}

    assert client.get("/api/v1/metrics").json()["total"] == 0
    assert client.get("/api/v1/metrics/names").json()["count"] == 0


def test_delete_all_metrics_allows_fresh_posts_from_seq_zero():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1.0})
    client.delete("/api/v1/metrics")

    resp = client.post("/api/v1/metrics", json={"name": "cpu", "value": 2.0})
    assert resp.status_code == 201
    assert resp.json()["id"] == "cpu-0"


def test_delete_all_metrics_does_not_shadow_by_name_delete():
    client.post("/api/v1/metrics", json={"name": "cpu", "value": 1.0})
    client.post("/api/v1/metrics", json={"name": "mem", "value": 2.0})

    resp_by_name = client.delete("/api/v1/metrics/cpu")
    assert resp_by_name.status_code == 200
    assert resp_by_name.json()["deleted"] == 1

    # mem はまだ残っている
    assert client.get("/api/v1/metrics/mem").json()["count"] == 1

    resp_all = client.delete("/api/v1/metrics")
    assert resp_all.status_code == 200
    assert resp_all.json()["deleted"] == 1

    # 削除後は 0 件
    assert client.get("/api/v1/metrics").json()["total"] == 0


def test_delete_all_metrics_idempotent():
    client.post("/api/v1/metrics", json={"name": "x", "value": 1.0})

    resp1 = client.delete("/api/v1/metrics")
    assert resp1.status_code == 200
    assert resp1.json()["deleted"] == 1

    resp2 = client.delete("/api/v1/metrics")
    assert resp2.status_code == 200
    assert resp2.json()["deleted"] == 0


def test_delete_all_metrics_count_reflects_multiple_names():
    for v in range(3):
        client.post("/api/v1/metrics", json={"name": "a", "value": float(v)})
    for v in range(5):
        client.post("/api/v1/metrics", json={"name": "b", "value": float(v)})

    resp = client.delete("/api/v1/metrics")
    assert resp.status_code == 200
    assert resp.json() == {"deleted": 8}
