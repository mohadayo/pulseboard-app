import logging
import os
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

metrics_store: dict[str, list[dict]] = {}


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
    metric_id = f"{payload.name}-{len(metrics_store.get(payload.name, []))}"
    record = {
        "id": metric_id,
        "name": payload.name,
        "value": payload.value,
        "tags": payload.tags,
        "recorded_at": now,
    }
    metrics_store.setdefault(payload.name, []).append(record)
    logger.info("Metric recorded: %s = %s", payload.name, payload.value)
    return MetricResponse(**record)


@app.get("/api/v1/metrics")
def list_metrics(name: Optional[str] = None):
    if name:
        results = metrics_store.get(name, [])
    else:
        results = [m for group in metrics_store.values() for m in group]
    logger.info("Listed %d metrics (filter=%s)", len(results), name)
    return {"metrics": results, "count": len(results)}


@app.get("/api/v1/metrics/{metric_name}/latest")
def get_latest_metric(metric_name: str):
    entries = metrics_store.get(metric_name)
    if not entries:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    return entries[-1]


@app.delete("/api/v1/metrics/{metric_name}")
def delete_metrics(metric_name: str):
    if metric_name not in metrics_store:
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    count = len(metrics_store.pop(metric_name))
    logger.info("Deleted %d metrics for '%s'", count, metric_name)
    return {"deleted": count, "name": metric_name}
