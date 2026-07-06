import logging
import math
import os
import threading
import time
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


@app.middleware("http")
async def access_log_middleware(request: Request, call_next):
    """1 リクエスト 1 行のアクセスログを出力する。

    既存の各ハンドラの ``logger.info(...)`` は機能単位の出来事を記録するもので、
    すべてのリクエストにわたって「いつ・どのパスに・どの HTTP メソッドが来て・
    結果は何で・どれだけかかったか」を一貫して見渡せる軸が無かった。
    本ミドルウェアでレスポンス完了直前に method/path/status/duration_ms を
    1 行に集約することで、ハンドラ側ログを追わなくとも遅延傾向や 4xx 偏りを
    構造化ログから即座に追えるようにする。

    ``time.perf_counter()`` を採用して、システム時刻の補正に左右されない
    単調増加な計測を行う。レスポンスヘッダ ``X-Response-Time-Ms`` にも同値を
    入れ、クライアント側 (ダッシュボード等) からも応答時間が観測可能になる。
    """
    start = time.perf_counter()
    response = await call_next(request)
    duration_ms = round((time.perf_counter() - start) * 1000.0, 3)
    logger.info(
        "%s %s -> %d (%.3fms)",
        request.method,
        request.url.path,
        response.status_code,
        duration_ms,
    )
    response.headers["X-Response-Time-Ms"] = f"{duration_ms}"
    return response


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


# メトリクス名の最大長。POST 時の `MetricPayload.name` の Field(max_length=128) と一致させる。
# `_normalize_q_param` の長さ検査でも参照する。
MAX_METRIC_NAME_LENGTH = 128


def _normalize_q_param(raw: Optional[str]) -> tuple[Optional[str], Optional[str]]:
    """`q` クエリパラメータを正規化する。

    戻り値は (正規化後の値, エラーメッセージ)。
    - None → (None, None) : 未指定（フィルタしない）
    - 空文字 → (None, None) : 空指定は「未指定」扱い（`analytics-api` `_normalize_q_param` は
      trim 後空を 400 にするが、こちらは `?q=` を「指定なし」と等価に扱う先行実装との整合を優先する）
    - trim 後が空 (空白のみ) → (None, "q must not be blank") : 400 を返す対象
    - 上限超過 → (None, "q is too long ...") : 400 を返す対象
    - 正常 → (trimmed, None)

    ダッシュボードのフィルタドロップダウンで大量のメトリクス名を絞り込む用途を想定した
    サーバ側の部分一致（ケース無視）検索のためのパラメータ正規化。呼び元は
    エラーメッセージが `None` でない場合に 400 HTTPException を投げる。
    """
    if raw is None or raw == "":
        return None, None
    stripped = raw.strip()
    if not stripped:
        return None, "q must not be blank"
    if len(stripped) > MAX_METRIC_NAME_LENGTH:
        return None, f"q must be at most {MAX_METRIC_NAME_LENGTH} characters"
    return stripped, None


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
    since_dt, until_dt = _parse_since_until(since, until)

    # ロック内ではスナップショットを取るだけにし、フィルタ/ページング整形はロック外で実施する。
    with _store_lock:
        if name:
            results = list(metrics_store.get(name, []))
        else:
            results = [m for group in metrics_store.values() for m in group]

    results = _apply_time_filter(results, since_dt, until_dt)

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


def _apply_time_filter(
    records: list[dict],
    since_dt: Optional[datetime],
    until_dt: Optional[datetime],
) -> list[dict]:
    """`recorded_at` で `since`/`until` の範囲に合致するレコードに絞り込む。

    `recorded_at` は POST 時に UTC ISO で書き込んでいるため通常パース失敗は
    発生しないが、壊れた値が混入した場合は除外扱いとして安全側に倒す。
    """
    if since_dt is None and until_dt is None:
        return records
    filtered: list[dict] = []
    for m in records:
        try:
            ts = datetime.fromisoformat(m["recorded_at"])
        except (ValueError, KeyError, TypeError):
            continue
        if since_dt is not None and ts < since_dt:
            continue
        if until_dt is not None and ts > until_dt:
            continue
        filtered.append(m)
    return filtered


def _parse_since_until(
    since: Optional[str], until: Optional[str],
) -> tuple[Optional[datetime], Optional[datetime]]:
    since_dt = _parse_iso_datetime(since, "since") if since is not None else None
    until_dt = _parse_iso_datetime(until, "until") if until is not None else None
    if since_dt is not None and until_dt is not None and since_dt > until_dt:
        raise HTTPException(
            status_code=400,
            detail="since must be less than or equal to until",
        )
    return since_dt, until_dt


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
def get_metric_stats(
    metric_name: str,
    since: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at >= since のレコードに絞り込んで集計",
    ),
    until: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at <= until のレコードに絞り込んで集計",
    ),
):
    """指定メトリクス名の保持値に対する集計統計を返す。

    値は POST 時に有限値（Infinity/NaN を除く）であることが保証されているため、
    min/max/sum/avg は安全に計算できる。`latest` は集計対象（フィルタ適用後）
    の末尾の記録値。`since`/`until` で集計対象期間を絞り込める。
    """
    since_dt, until_dt = _parse_since_until(since, until)
    with _store_lock:
        entries = metrics_store.get(metric_name)
        snapshot = list(entries) if entries else []
    if not snapshot:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    snapshot = _apply_time_filter(snapshot, since_dt, until_dt)
    if not snapshot:
        logger.info(
            "No metrics in window for '%s' (since=%s until=%s)",
            metric_name, since, until,
        )
        raise HTTPException(
            status_code=404,
            detail=f"No metrics found for '{metric_name}' in the given window",
        )
    values = [m["value"] for m in snapshot]
    total = sum(values)
    count = len(values)
    sorted_values = sorted(values)
    avg = total / count
    # 母集団分散（除数 N、Bessel 補正なし）と母標準偏差をペアで露出する。
    # `metrics-worker` の `/api/v1/aggregate` と式を統一しており、下流の
    # `dashboard-bff` で「複数 worker の集計結果を合成分散の閉形式で
    # 集約する」ためのフィールドを欠落させない。`std_dev = sqrt(variance)`
    # の関係を保つ（`count == 1` は両者とも 0.0）。
    variance = sum((v - avg) ** 2 for v in values) / count
    std_dev = math.sqrt(variance)
    # 変動係数 (Coefficient of Variation): std_dev / |avg|。
    # `api-gateway` および `metrics-worker` と定義を統一する。
    # avg == 0 の場合は定義不能 (0/0) なので 0.0 を返す。
    cv = std_dev / abs(avg) if avg != 0 else 0.0
    # 母集団歪度 (population skewness): (1/n) Σ((xᵢ - μ)³) / σ³。
    # `metrics-worker` の `/api/v1/aggregate` と定義を統一する。
    # σ = 0（定数入力 / 単一観測）の場合は定義不能 (0/0) なので 0 を返す。
    if std_dev > 0:
        m3 = sum((v - avg) ** 3 for v in values) / count
        skewness = m3 / (std_dev ** 3)
    else:
        skewness = 0.0
    # 母集団尖度 (population kurtosis): (1/n) Σ((xᵢ - μ)⁴) / σ⁴。
    # `metrics-worker` の `/api/v1/aggregate` と定義を統一する。
    # σ = 0（定数入力 / 単一観測）の場合は定義不能 (0/0) なので 0 を返す。
    if std_dev > 0:
        m4 = sum((v - avg) ** 4 for v in values) / count
        kurtosis = m4 / (std_dev ** 4)
    else:
        kurtosis = 0.0
    stats = {
        "name": metric_name,
        "count": count,
        "min": sorted_values[0],
        "max": sorted_values[-1],
        "sum": total,
        "avg": avg,
        "variance": variance,
        "std_dev": std_dev,
        "cv": cv,
        "skewness": skewness,
        "kurtosis": kurtosis,
        "p50": _percentile(sorted_values, 50),
        "p95": _percentile(sorted_values, 95),
        "p99": _percentile(sorted_values, 99),
        "latest": snapshot[-1]["value"],
        "latest_recorded_at": snapshot[-1]["recorded_at"],
        "first_recorded_at": snapshot[0]["recorded_at"],
    }
    logger.info("Computed stats for '%s' (count=%d)", metric_name, count)
    return stats


@app.get("/api/v1/metrics/names")
def list_metric_names(
    q: Optional[str] = Query(
        default=None,
        description=(
            "メトリクス名に対する大文字小文字無視の部分一致検索。"
            "空文字 (`?q=`) は指定なしと同じ。空白のみ / 128 文字超は 400。"
        ),
    ),
):
    """保持中のメトリクス名一覧と件数・最終記録時刻を返す。

    `GET /api/v1/metrics?limit=最大` 経由でクライアント側集計するパターンを
    置き換えるための軽量エンドポイント。各 name について以下を返す:

    - ``name``: メトリクス名
    - ``count``: 保持中のレコード件数（FIFO eviction 後の現存数）
    - ``latest_recorded_at``: 末尾レコードの ``recorded_at``。POST 時点で
      ロック内 append しているため、エントリの末尾が常に最新。

    `?q=` を指定すると、大文字小文字無視の部分一致で name を絞り込む。
    ダッシュボードのフィルタドロップダウンで大量のメトリクス名を絞り込む用途
    （`db.*` の候補だけ populate したい等）を想定。前方一致ではなく substring
    一致に統一しており、`analytics-api` (pulseboard) の `_normalize_q_param`
    と同じ挙動を共有する。

    返却順は ``name`` 昇順。経路衝突回避のため、``/{metric_name}`` 系の
    登録より前に定義する必要がある（FastAPI は登録順で評価する）。
    """
    normalized_q, q_error = _normalize_q_param(q)
    if q_error is not None:
        raise HTTPException(status_code=400, detail=q_error)

    with _store_lock:
        # ロック内ではキー一覧と各エントリの (件数, 末尾の recorded_at) を
        # スナップショットするのみ。リスト本体は複製しない（O(N) 回避）。
        snapshot: list[tuple[str, int, Optional[str]]] = []
        for name, entries in metrics_store.items():
            if entries:
                snapshot.append((name, len(entries), entries[-1].get("recorded_at")))
            else:
                snapshot.append((name, 0, None))

    if normalized_q is not None:
        needle = normalized_q.lower()
        snapshot = [t for t in snapshot if needle in t[0].lower()]

    snapshot.sort(key=lambda t: t[0])
    names = [
        {"name": n, "count": c, "latest_recorded_at": ts}
        for (n, c, ts) in snapshot
    ]
    logger.info(
        "Listed %d distinct metric name(s) (q=%s)",
        len(names), normalized_q,
    )
    return {"names": names, "count": len(names)}


@app.get("/api/v1/metrics/count")
def count_metrics(
    since: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at >= since のレコードのみ集計",
    ),
    until: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at <= until のレコードのみ集計",
    ),
):
    """保持中メトリクスの件数のみを返す軽量エンドポイント。

    `GET /api/v1/metrics` はレコード本体を含むページング応答を返すため、UI で
    「総数バッジ」「メトリクス名ごとの件数」だけ知りたいケースには過剰。本エンドポイントは
    `total_metrics` / `distinct_names` / `by_name` の 3 つだけを返す。`by_name` は
    フィルタ後に観測されたメトリクス名のみで、観測 0 件の名前はキーに含めない（軽量化）。

    `since` / `until` で `recorded_at` 範囲を絞り込める（既存 `/api/v1/metrics` と同じ規約）。
    `/api/v1/metrics/names` の `latest_recorded_at` と違い、こちらは時間フィルタ後の
    件数集計まで踏み込むため UI の「期間内バッジ」に直接使える。

    レジストレーション位置: `/{metric_name}` ルートより前に置く必要がある
    （FastAPI は登録順マッチで、後置だと `metric_name="count"` として捕捉される）。
    """
    since_dt, until_dt = _parse_since_until(since, until)

    with _store_lock:
        snapshot: list[tuple[str, list[dict]]] = [
            (name, list(entries)) for name, entries in metrics_store.items()
        ]

    by_name: dict[str, int] = {}
    total = 0
    for name, entries in snapshot:
        filtered = _apply_time_filter(entries, since_dt, until_dt)
        if not filtered:
            # 時間フィルタ後に 0 件のメトリクス名は by_name に含めない（軽量化）。
            continue
        by_name[name] = len(filtered)
        total += len(filtered)

    logger.info(
        "Count requested: total=%d distinct_names=%d (since=%s until=%s)",
        total, len(by_name), since, until,
    )
    return {
        "total_metrics": total,
        "distinct_names": len(by_name),
        "by_name": by_name,
    }


@app.get("/api/v1/metrics/by_day")
def metrics_by_day(
    name: Optional[str] = Query(
        default=None,
        description="メトリクス名の完全一致フィルタ。未指定なら全メトリクス横断で集計",
    ),
    since: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at >= since のレコードのみ集計",
    ),
    until: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at <= until のレコードのみ集計",
    ),
):
    """保持中メトリクスを UTC 日付 (YYYY-MM-DD) でビニングし、日次時系列カウントを返す。

    `/api/v1/metrics/count` が name 別合計、`/api/v1/metrics/{name}/stats` が期間集計
    統計を返すのに対し、本エンドポイントは「いつ (どの UTC 日付に) どれだけレコードが
    書き込まれたか」という時系列推移を 1 リクエストで返す。
    ダッシュボード UI で日別トレンドグラフを描画する際、
    `GET /api/v1/metrics?limit=最大` 経由の全件取得 → クライアント集計を回避できる。

    バケットキーは `recorded_at` を UTC 正規化した `YYYY-MM-DD` 文字列。ISO 日付の
    lex 昇順 = カレンダー昇順を保つため、追加のソートキー変換は不要。
    populated-only: 母集団 0 の日は返さない（他サービスの by_day と同じ規約）。
    破損した recorded_at (パース不能) は集計対象外（`_apply_time_filter` と同じ防御）。

    レジストレーション位置: `/{metric_name}` ルートより前に置く必要がある
    (FastAPI は登録順マッチで、後置だと `metric_name="by_day"` として捕捉される)。
    既存 `/count` / `/names` と同じ規約。
    """
    since_dt, until_dt = _parse_since_until(since, until)

    with _store_lock:
        if name is not None:
            entries = metrics_store.get(name)
            snapshot: list[dict] = list(entries) if entries else []
        else:
            snapshot = []
            for _n, ents in metrics_store.items():
                snapshot.extend(ents)

    filtered = _apply_time_filter(snapshot, since_dt, until_dt)

    counts: dict[str, int] = {}
    total = 0
    for m in filtered:
        raw_ts = m.get("recorded_at")
        if not isinstance(raw_ts, str):
            continue
        try:
            dt = datetime.fromisoformat(raw_ts)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        day = dt.strftime("%Y-%m-%d")
        counts[day] = counts.get(day, 0) + 1
        total += 1

    # ISO 日付 (YYYY-MM-DD) の lex 順は時系列順と一致するため、sorted で十分。
    by_day = [{"day": d, "count": counts[d]} for d in sorted(counts.keys())]
    logger.info(
        "by_day requested: total=%d distinct_days=%d (name=%s since=%s until=%s)",
        total, len(by_day), name, since, until,
    )
    return {
        "total": total,
        "distinct_days": len(by_day),
        "by_day": by_day,
    }


@app.get("/api/v1/metrics/by_hour_of_day")
def metrics_by_hour_of_day(
    name: Optional[str] = Query(
        default=None,
        description="メトリクス名の完全一致フィルタ。未指定なら全メトリクス横断で集計",
    ),
    since: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at >= since のレコードのみ集計",
    ),
    until: Optional[str] = Query(
        default=None,
        description="ISO 8601 文字列。recorded_at <= until のレコードのみ集計",
    ),
):
    """保持中メトリクスを UTC 時刻 ("00"〜"23") でビニングし、時刻昇順の周期カウントを返す。

    `/api/v1/metrics/by_day` は「いつ」流量があったかを直線時系列で見るのに対し、
    本エンドポイントは「1 日のうちどの時間帯にレコード書き込みが集中しているか」
    という周期パターンを 1 リクエストで返す。SLO 圏内での混雑時間帯特定・
    キャパシティプランのシフト設計・cron スケジュール調整の根拠データとして
    使う想定。

    バケットキーは `recorded_at` を UTC 正規化した 2 桁ゼロ詰め時刻文字列
    (`"00"`〜`"23"`)。lex 昇順 = 時間順を保つため、追加のソートキー変換は不要。
    populated-only: 母集団 0 の時間帯は返さない（`by_day` と同じ規約）。
    破損した recorded_at (パース不能) は集計対象外（`_apply_time_filter` と同じ防御）。

    レジストレーション位置: `/{metric_name}` ルートより前に置く必要がある
    (FastAPI は登録順マッチで、後置だと `metric_name="by_hour_of_day"` として
    捕捉される)。既存 `/count` / `/names` / `/by_day` と同じ規約。
    """
    since_dt, until_dt = _parse_since_until(since, until)

    with _store_lock:
        if name is not None:
            entries = metrics_store.get(name)
            snapshot: list[dict] = list(entries) if entries else []
        else:
            snapshot = []
            for _n, ents in metrics_store.items():
                snapshot.extend(ents)

    filtered = _apply_time_filter(snapshot, since_dt, until_dt)

    counts: dict[str, int] = {}
    total = 0
    for m in filtered:
        raw_ts = m.get("recorded_at")
        if not isinstance(raw_ts, str):
            continue
        try:
            dt = datetime.fromisoformat(raw_ts)
        except ValueError:
            continue
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        else:
            dt = dt.astimezone(timezone.utc)
        hour = dt.strftime("%H")
        counts[hour] = counts.get(hour, 0) + 1
        total += 1

    # 2 桁ゼロ詰め時刻 ("00"〜"23") は lex 順 = 時間順のため sorted で十分。
    by_hour_of_day = [{"hour": h, "count": counts[h]} for h in sorted(counts.keys())]
    logger.info(
        "by_hour_of_day requested: total=%d distinct_hours=%d (name=%s since=%s until=%s)",
        total, len(by_hour_of_day), name, since, until,
    )
    return {
        "total": total,
        "distinct_hours": len(by_hour_of_day),
        "by_hour_of_day": by_hour_of_day,
    }


@app.get("/api/v1/metrics/{metric_name}")
def get_metrics_by_name(
    metric_name: str,
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
    since_dt, until_dt = _parse_since_until(since, until)
    with _store_lock:
        entries = metrics_store.get(metric_name)
        snapshot = list(entries) if entries else []
    if not snapshot:
        logger.warning("Metric not found: %s", metric_name)
        raise HTTPException(status_code=404, detail=f"No metrics found for '{metric_name}'")
    snapshot = _apply_time_filter(snapshot, since_dt, until_dt)
    total = len(snapshot)
    page = snapshot[offset:offset + limit]
    logger.info(
        "Returned %d/%d metric(s) for '%s' (since=%s until=%s limit=%d offset=%d)",
        len(page), total, metric_name, since, until, limit, offset,
    )
    return {
        "name": metric_name,
        "metrics": page,
        "count": len(page),
        "total": total,
        "limit": limit,
        "offset": offset,
    }


@app.delete("/api/v1/metrics")
def delete_all_metrics():
    with _store_lock:
        total = sum(len(v) for v in metrics_store.values())
        metrics_store.clear()
        metrics_seq.clear()
    logger.info("Deleted all %d metrics", total)
    return {"deleted": total}


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
