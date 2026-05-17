import importlib

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
