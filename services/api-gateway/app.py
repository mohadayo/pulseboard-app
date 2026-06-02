import logging
import math
import os
import threading
from datetime import datetime, timezone
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
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


def _parse_positive_int_env(key: str, default: int) -> int:
    raw = os.getenv(key, str(default))
    try:
        value = int(raw)
    except ValueError:
        logger.warning("Invalid %s=%r, falling back to %d", key, raw, default)
        return default
    return value if value > 0 else default


# GET /api/v1/metrics のページング既定値と上限。
# METRICS_DEFAULT_LIMIT < METRICS_MAX_LIMIT を満たすよう正規化する。
METRICS_DEFAULT_LIMIT = _parse_positive_int_env("METRICS_DEFAULT_LIMIT", 100)
METRICS_MAX_LIMIT = _parse_positive_int_env("METRICS_MAX_LIMIT", 1000)
if METRICS_DEFAULT_LIMIT > METRICS_MAX_LIMIT:
    METRICS_DEFAULT_LIMIT = METRICS_MAX_LIMIT


def _percentile(sorted_values: list[float], pct: float) -> float:
    """Sorted values から線形補間で pct (0-100) パーセンタイル値を返す。

    空入力は 0.0 を返す。要素 1 件ならそのまま返す。
    rank = pct/100 * (n - 1) を取り、両端 (lower/upper) の重み付き平均を返す。
    """
    if not sorted_values:
        return 0.0
    if len(sorted_values) == 1:
        return sorted_values[0]
    rank = (pct / 100.0) * (len(sorted_values) - 1)
    lower = int(math.floor(rank))
    upper = int(math.ceil(rank))
    if lower == upper:
        return sorted_values[lower]
    weight = rank - lower
    return sorted_values[lower] * (1 - weight) + sorted_values[upper] * weight


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
    # `allow_inf_nan=False` で `+Infinity` / `-Infinity` / `NaN` を拒否する。
    # JSON 仕様上、`1e500` のような桁あふれ数値は許容されるが Python では `inf`
    # として読み込まれてしまい、集計・サマリ・直近値が破壊される。
    value: float = Field(..., allow_inf_nan=False)
    tags: Optional[dict[str, str]] = None


@app.exception_handler(RequestValidationError)
async def _validation_exception_handler(_request: Request, exc: RequestValidationError):
    # 既定ハンドラはエラーレスポンスに不正値をそのまま含めるが、`+Infinity`/`NaN`
    # は strict-mode JSON で直列化できず 500 を引き起こす。安全に直列化できるよう、
    # 非有限な float 入力値は文字列化したうえで返す。
    sanitized = []
    for err in exc.errors():
        sanitized_err = dict(err)
        value = sanitized_err.get("input")
        if isinstance(value, float) and not math.isfinite(value):
            sanitized_err["input"] = str(value)
        sanitized.append(sanitized_err)
    return JSONResponse(status_code=422, content={"detail": sanitized})


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


def _parse_iso_datetime(value: str, field: str) -> datetime:
    """ISO 8601 形式の文字列を `datetime` に変換する。

    `+00:00` / `Z` 末尾どちらも受け入れる。タイムゾーン無指定（naive）の
    入力は UTC として扱う（`recorded_at` 側も UTC ISO で保存しているため）。
    パース失敗時は 400 を投げる。
    """
    raw = value.strip()
    if not raw:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must not be blank",
        )
    normalized = raw.replace("Z", "+00:00")
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"{field} must be an ISO 8601 datetime",
        )
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


@app.get("/api/v1/metrics")
def list_metrics(
    name: Optional[str] = None,
    since: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at >= since のレコードに絞り込む",
    ),
    until: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at <= until のレコードに絞り込む",
    ),
    limit: int = Query(
        default=METRICS_DEFAULT_LIMIT,
        ge=1,
        le=METRICS_MAX_LIMIT,
        description=f"返却件数上限（最大 {METRICS_MAX_LIMIT}）",
    ),
    offset: int = Query(
        default=0,
        ge=0,
        description="先頭から読み飛ばす件数",
    ),
):
    since_dt = _parse_iso_datetime(since, "since") if since is not None else None
    until_dt = _parse_iso_datetime(until, "until") if until is not None else None
    if since_dt is not None and until_dt is not None and since_dt > until_dt:
        raise HTTPException(
            status_code=400,
            detail="since must be less than or equal to until",
        )

    # ロック内ではスナップショットを取るだけにし、フィルタ/ページング整形はロック外で実施する。
    with _store_lock:
        if name:
            results = list(metrics_store.get(name, []))
        else:
            results = [m for group in metrics_store.values() for m in group]

    if since_dt is not None or until_dt is not None:
        filtered: list[dict] = []
        for m in results:
            try:
                ts = datetime.fromisoformat(m["recorded_at"])
            except ValueError:
                # POST 時に UTC ISO で書き込んでいるため通常ここには来ないが、
                # 万が一壊れた値があってもフィルタが落ちないよう除外扱いとする。
                continue
            if since_dt is not None and ts < since_dt:
                continue
            if until_dt is not None and ts > until_dt:
                continue
            filtered.append(m)
        results = filtered

    total = len(results)
    page = results[offset:offset + limit]
    logger.info(
        "Listed %d/%d metrics (filter=%s, since=%s, until=%s, limit=%d, offset=%d)",
        len(page), total, name, since, until, limit, offset,
    )
    return {
        "metrics": page,
        "count": len(page),
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.get("/api/v1/metrics/{metric_name}/latest")
def get_latest_metric(metric_name: str):
    with _store_lock:
        entries = metrics_store.get(metric_name)
        latest = entries[-1] if entries else None
    if latest is None:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    return latest


@app.get("/api/v1/metrics/{metric_name}/stats")
def get_metric_stats(metric_name: str):
    """指定メトリクス名の保持値に対する集計統計を返す。

    値は POST 時に有限値（Infinity/NaN を除く）であることが保証されているため、
    min/max/sum/avg は安全に計算できる。`latest` は最新（末尾）の記録値。
    """
    with _store_lock:
        entries = metrics_store.get(metric_name)
        snapshot = list(entries) if entries else []
    if not snapshot:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    values = [m["value"] for m in snapshot]
    total = sum(values)
    count = len(values)
    sorted_values = sorted(values)
    stats = {
        "name": metric_name,
        "count": count,
        "min": sorted_values[0],
        "max": sorted_values[-1],
        "sum": total,
        "avg": total / count,
        "p50": _percentile(sorted_values, 50),
        "p95": _percentile(sorted_values, 95),
        "p99": _percentile(sorted_values, 99),
        "latest": snapshot[-1]["value"],
        "latest_recorded_at": snapshot[-1]["recorded_at"],
        "first_recorded_at": snapshot[0]["recorded_at"],
    }
    logger.info("Computed stats for '%s' (count=%d)", metric_name, count)
    return stats


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
