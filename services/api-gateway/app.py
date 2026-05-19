import logging
import os
import threading
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

logging.basicConfig(
    level=os.getenv("LOG_LEVEL", "INFO"),
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("api-gateway")

app = FastAPI(title="PulseBoard API Gateway", version="1.0.0")


def _parse_max_metrics() -> int:
    raw = os.getenv("MAX_METRICS_PER_NAME", "1000")
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid MAX_METRICS_PER_NAME=%r, falling back to 1000", raw)
        return 1000
    return value if value > 0 else 0


# 1 メトリクス名あたりの最大保持件数。0 以下なら無制限。
MAX_METRICS_PER_NAME = _parse_max_metrics()

metrics_store: dict[str, list[dict]] = {}
# 累積シーケンス（FIFO で古い記録を破棄しても ID が衝突しないよう、別カウンタで管理）
metrics_seq: dict[str, int] = {}
# FastAPI は def ハンドラをスレッドプールで並行実行するため、store と seq の
# read-modify-write は同一ロックで保護する。RLock にしているのは、将来同一
# スレッドで複数のヘルパが入れ子で呼ばれても安全にするため。
_store_lock = threading.RLock()


def _reset_state() -> None:
    """テスト用：内部状態を初期化する。"""
    with _store_lock:
        metrics_store.clear()
        metrics_seq.clear()


class MetricPayload(BaseModel):
    name: str = Field(..., min_length=1, max_length=128)
    value: float
    tags: Optional[dict[str, str]] = None


class MetricResponse(BaseModel):
    id: str
    name: str
    value: float
    tags: Optional[dict[str, str]]
    recorded_at: str


@app.get("/health")
def health():
    logger.debug("Health check requested")
    return {"status": "ok", "service": "api-gateway", "timestamp": datetime.now(timezone.utc).isoformat()}


@app.post("/api/v1/metrics", status_code=201)
def create_metric(payload: MetricPayload):
    now = datetime.now(timezone.utc).isoformat()
    # ID 採番〜append〜eviction を 1 つの臨界区間に閉じ込めることで、
    # 並行 POST 時にも ID は一意・件数上限は厳密に守られる。
    with _store_lock:
        seq = metrics_seq.get(payload.name, 0)
        metric_id = f"{payload.name}-{seq}"
        metrics_seq[payload.name] = seq + 1
        record = {
            "id": metric_id,
            "name": payload.name,
            "value": payload.value,
            "tags": payload.tags,
            "recorded_at": now,
        }
        entries = metrics_store.setdefault(payload.name, [])
        entries.append(record)

        if MAX_METRICS_PER_NAME > 0 and len(entries) > MAX_METRICS_PER_NAME:
            overflow = len(entries) - MAX_METRICS_PER_NAME
            del entries[:overflow]
            logger.info(
                "Evicted %d old metric(s) for '%s' (cap=%d)",
                overflow, payload.name, MAX_METRICS_PER_NAME,
            )

    logger.info("Metric recorded: %s = %s", payload.name, payload.value)
    return MetricResponse(**record)


@app.get("/api/v1/metrics")
def list_metrics(name: Optional[str] = None):
    # ロック内ではスナップショットを取るだけにし、レスポンス整形はロック外で実施する。
    with _store_lock:
        if name:
            results = list(metrics_store.get(name, []))
        else:
            results = [m for group in metrics_store.values() for m in group]
    logger.info("Listed %d metrics (filter=%s)", len(results), name)
    return {"metrics": results, "count": len(results)}


@app.get("/api/v1/metrics/{metric_name}/latest")
def get_latest_metric(metric_name: str):
    with _store_lock:
        entries = metrics_store.get(metric_name)
        latest = entries[-1] if entries else None
    if latest is None:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    return latest


@app.get("/api/v1/metrics/{metric_name}")
def get_metrics_by_name(metric_name: str):
    with _store_lock:
        entries = metrics_store.get(metric_name)
        snapshot = list(entries) if entries else []
    if not snapshot:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    logger.info("Returned %d metric(s) for '%s'", len(snapshot), metric_name)
    return {"name": metric_name, "metrics": snapshot, "count": len(snapshot)}


@app.delete("/api/v1/metrics/{metric_name}")
def delete_metrics(metric_name: str):
    # pop と seq.pop を同一ロックで実施し、削除中に走る POST と整合性が崩れないようにする。
    with _store_lock:
        if metric_name not in metrics_store:
            raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
        count = len(metrics_store.pop(metric_name))
        metrics_seq.pop(metric_name, None)
    logger.info("Deleted %d metrics for '%s'", count, metric_name)
    return {"deleted": count, "name": metric_name}
