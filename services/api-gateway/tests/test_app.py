from fastapi.testclient import TestClient

from app import app, metrics_store

client = TestClient(app)


def setup_function():
    metrics_store.clear()


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
