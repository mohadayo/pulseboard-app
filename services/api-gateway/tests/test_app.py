import importlib
from concurrent.futures import ThreadPoolExecutor

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
