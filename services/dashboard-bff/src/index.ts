import express, { Request, Response, NextFunction } from "express";

const app = express();

// JSON ペイロードの最大サイズ。express.json のデフォルトは 100kb だが
// 環境変数で明示・上書きできるようにする。
const MAX_REQUEST_BODY = process.env.MAX_REQUEST_BODY || "100kb";
app.use(express.json({ limit: MAX_REQUEST_BODY }));

const PORT = process.env.PORT || 8002;
const API_GATEWAY_URL =
  process.env.API_GATEWAY_URL || "http://api-gateway:8000";
const WORKER_URL = process.env.WORKER_URL || "http://metrics-worker:8001";

// dashboardStore の保持件数上限。0 以下なら無制限。
// 既定値は他サービス（api-gateway の MAX_METRICS_PER_NAME=1000）より
// 大きめの 10000 にしている（dashboard-bff は名前ごとではなく合算で保持するため）。
function parseMaxDashboardMetrics(): number {
  const raw = process.env.MAX_DASHBOARD_METRICS;
  if (raw === undefined || raw === "") {
    return 10000;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed)) {
    log("WARN", `Invalid MAX_DASHBOARD_METRICS=${raw}, falling back to 10000`);
    return 10000;
  }
  return parsed;
}

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level}] dashboard-bff: ${message}`);
}

const MAX_DASHBOARD_METRICS = parseMaxDashboardMetrics();

// メトリクス名の最大文字数。上流の api-gateway (Python) と揃える。
const MAX_METRIC_NAME_LENGTH = 128;

// /api/v1/dashboard/summary の limit 既定値と上限。
const DEFAULT_SUMMARY_LIMIT = 50;

function parseMaxSummaryLimit(): number {
  const raw = process.env.MAX_SUMMARY_LIMIT;
  if (raw === undefined || raw === "") {
    return 500;
  }
  const parsed = parseInt(raw, 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    log("WARN", `Invalid MAX_SUMMARY_LIMIT=${raw}, falling back to 500`);
    return 500;
  }
  return parsed;
}

const MAX_SUMMARY_LIMIT = parseMaxSummaryLimit();

// POST /api/v1/dashboard/metrics の `tags` バリデーション上限。
// プレーンオブジェクト以外は弾き、各キー・値・要素数に上限を設けて
// 不正な型や過大なペイロードを店子コードまで通さない。
function parseTagsLimit(envKey: string, fallback: number): number {
  const raw = process.env[envKey];
  if (raw === undefined || raw === "") return fallback;
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    log("WARN", `Invalid ${envKey}=${raw}, falling back to ${fallback}`);
    return fallback;
  }
  return n;
}

const TAG_KEY_MAX_LENGTH = parseTagsLimit("TAG_KEY_MAX_LENGTH", 64);
const TAG_VALUE_MAX_LENGTH = parseTagsLimit("TAG_VALUE_MAX_LENGTH", 256);
const TAG_MAX_KEYS = parseTagsLimit("TAG_MAX_KEYS", 16);

// `tags` の実行時バリデーション。型注釈 `Record<string, string>` は
// 実行時には強制されないため、明示的にチェックする。
// 戻り値:
//   - `{ ok: true, value: ...|undefined }` … 受け入れ
//   - `{ ok: false, error: "..." }` … 400 を返す対象
function validateTags(
  raw: unknown,
):
  | { ok: true; value: Record<string, string> | undefined }
  | { ok: false; error: string } {
  if (raw === undefined || raw === null) {
    return { ok: true, value: undefined };
  }
  // 配列は object 扱いだが許可しない。
  if (typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, error: "tags must be a plain object of string → string" };
  }
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > TAG_MAX_KEYS) {
    return {
      ok: false,
      error: `tags must have at most ${TAG_MAX_KEYS} keys (got ${entries.length})`,
    };
  }
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    if (typeof k !== "string" || k.length === 0) {
      return { ok: false, error: "tags keys must be non-empty strings" };
    }
    if (k.length > TAG_KEY_MAX_LENGTH) {
      return {
        ok: false,
        error: `tags keys must be at most ${TAG_KEY_MAX_LENGTH} characters`,
      };
    }
    if (typeof v !== "string") {
      return { ok: false, error: `tags['${k}'] must be a string` };
    }
    if (v.length > TAG_VALUE_MAX_LENGTH) {
      return {
        ok: false,
        error: `tags['${k}'] must be at most ${TAG_VALUE_MAX_LENGTH} characters`,
      };
    }
    out[k] = v;
  }
  return { ok: true, value: out };
}

// `?limit=` の入力をバリデーションして整数化する。
// - 未指定: defaultLimit を返す
// - 1〜maxLimit の整数文字列のみ受理（"10.5" / "abc" / "-5" / "0" は無効）
// - 無効値の場合は null を返す（呼び出し側が 400 を返す責務）
function parseSummaryLimit(
  raw: unknown,
  defaultLimit: number,
  maxLimit: number,
): number | null {
  if (raw === undefined) {
    return defaultLimit;
  }
  // express の req.query は string | string[] | qs.ParsedQs 形式。
  // limit は単一スカラのみ受け付ける（配列・オブジェクトは無効）。
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  // "10.5" や "  10" を弾くため、純粋な整数表記のみ通す（正の整数）。
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > maxLimit) {
    return null;
  }
  return parsed;
}

// offset クエリパラメータをパースする。
// - 未指定: 0 を返す
// - 0 以上の整数文字列のみ受理（"abc" / "-1" / "1.5" は無効）
// - 無効値の場合は null を返す（呼び出し側が 400 を返す責務）
function parseOffsetParam(raw: unknown): number | null {
  if (raw === undefined) {
    return 0;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
}

interface DashboardMetric {
  name: string;
  value: number;
  recorded_at: string;
  tags?: Record<string, string>;
}

interface DashboardSummary {
  total_metrics: number;
  limit: number;
  metrics: DashboardMetric[];
  generated_at: string;
}

interface DashboardStats {
  name: string;
  count: number;
  min: number;
  max: number;
  sum: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  latest: number;
  latest_recorded_at: string;
  first_recorded_at: string;
}

// 線形補間パーセンタイル。`sortedValues` は昇順、`pct` は 0〜100。
// 空入力は 0、要素 1 件はそのまま返す。上流 api-gateway の `_percentile` と
// 同じロジックで揃えて、BFF と直接 api-gateway の集計結果がズレないようにする。
function percentile(sortedValues: number[], pct: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const rank = (pct / 100) * (sortedValues.length - 1);
  const lower = Math.floor(rank);
  const upper = Math.ceil(rank);
  if (lower === upper) {
    return sortedValues[lower];
  }
  const weight = rank - lower;
  return sortedValues[lower] * (1 - weight) + sortedValues[upper] * weight;
}

// 指定メトリクス名の保持値に対する集計統計を計算する。
// metrics は時系列順（FIFO push）であることを前提とし、
// latest は末尾・first_recorded_at は先頭の記録時刻を採用する。
// 値は POST 時に有限値（Infinity/NaN を除く）が保証されているため、
// min/max/sum/avg は安全に計算できる。空配列は呼び出し側で 404 にする想定。
// `since` / `until` を ISO8601 として解釈する。
// 戻り値は `{ value: Date | null, error: string | null }`：
// - 未指定: value=null, error=null
// - パース不能: value=null, error="..."
// - 正常: value=Date, error=null
function parseIsoDateTime(
  raw: unknown,
  name: string,
): { value: Date | null; error: string | null } {
  if (raw === undefined) {
    return { value: null, error: null };
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return { value: null, error: `${name} must be a non-empty ISO8601 string` };
  }
  // ISO8601 を Date.parse でパース。NaN なら無効。
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) {
    return { value: null, error: `${name} must be a valid ISO8601 datetime` };
  }
  return { value: new Date(ms), error: null };
}

function filterByRecordedAt(
  metrics: DashboardMetric[],
  since: Date | null,
  until: Date | null,
): DashboardMetric[] {
  if (since === null && until === null) {
    return metrics;
  }
  return metrics.filter((m) => {
    const ts = Date.parse(m.recorded_at);
    if (Number.isNaN(ts)) {
      return false;
    }
    if (since !== null && ts < since.getTime()) {
      return false;
    }
    if (until !== null && ts > until.getTime()) {
      return false;
    }
    return true;
  });
}

// bucket_seconds クエリパラメータをパースする。
// - 未指定: 60 を返す（既定 1 分バケット。analytics-api と揃える）
// - 1〜86400 の整数文字列のみ受理（"1.5" / "abc" / "0" / "-1" は無効）
// - 無効値の場合は null を返す（呼び出し側が 400 を返す責務）
function parseBucketSecondsParam(raw: unknown): number | null {
  if (raw === undefined) {
    return 60;
  }
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (!/^[0-9]+$/.test(raw)) {
    return null;
  }
  const parsed = parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1 || parsed > 86400) {
    return null;
  }
  return parsed;
}

interface TimeseriesBucket {
  bucket_start: string; // ISO8601 文字列
  total: number;
  min: number;
  max: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

// recorded_at を `bucketSeconds` 秒幅の半開区間バケットにビニングして集約する。
// 観測のないバケットは結果に含めない（スパース表現）。並び順は bucket_start 昇順。
// recorded_at がパース不能なレコードはスキップする（filterByRecordedAt と同じ
// 「安全側」の振る舞いに揃える）。analytics-api の timeseries と percentile 計算
// （線形補間）を共有するため、`percentile` ヘルパをそのまま使う。
function bucketByTime(
  metrics: DashboardMetric[],
  bucketSeconds: number,
): TimeseriesBucket[] {
  const bucketMs = bucketSeconds * 1000;
  const buckets = new Map<number, number[]>();
  for (const m of metrics) {
    const ts = Date.parse(m.recorded_at);
    if (Number.isNaN(ts)) {
      continue;
    }
    const bucketStart = Math.floor(ts / bucketMs) * bucketMs;
    let arr = buckets.get(bucketStart);
    if (arr === undefined) {
      arr = [];
      buckets.set(bucketStart, arr);
    }
    arr.push(m.value);
  }
  const result: TimeseriesBucket[] = [];
  const sortedStarts = Array.from(buckets.keys()).sort((a, b) => a - b);
  for (const bucketStart of sortedStarts) {
    const values = buckets.get(bucketStart)!;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = values.reduce((acc, v) => acc + v, 0);
    result.push({
      bucket_start: new Date(bucketStart).toISOString(),
      total: values.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      avg: sum / values.length,
      p50: percentile(sorted, 50),
      p95: percentile(sorted, 95),
      p99: percentile(sorted, 99),
    });
  }
  return result;
}

function computeStats(name: string, metrics: DashboardMetric[]): DashboardStats {
  const values = metrics.map((m) => m.value);
  const count = values.length;
  const sum = values.reduce((acc, v) => acc + v, 0);
  // `Math.min(...arr)` / `Math.max(...arr)` は要素数が多いとスタック上限
  // に達する処理系がある（V8 でも引数数に上限）。reduce ベースで安全に評価する。
  const sorted = [...values].sort((a, b) => a - b);
  return {
    name,
    count,
    min: sorted[0],
    max: sorted[count - 1],
    sum,
    avg: sum / count,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    latest: metrics[count - 1].value,
    latest_recorded_at: metrics[count - 1].recorded_at,
    first_recorded_at: metrics[0].recorded_at,
  };
}

app.get("/health", (_req: Request, res: Response) => {
  log("DEBUG", "Health check requested");
  res.json({
    status: "ok",
    service: "dashboard-bff",
    timestamp: new Date().toISOString(),
    upstreams: {
      api_gateway: API_GATEWAY_URL,
      metrics_worker: WORKER_URL,
    },
  });
});

const dashboardStore: DashboardMetric[] = [];

app.post("/api/v1/dashboard/metrics", (req: Request, res: Response) => {
  const { name, value, tags } = req.body ?? {};

  // name は string でなければ受け付けない。
  // (truthy チェックだけだと数値/オブジェクト等も通り抜けてしまう)
  if (typeof name !== "string" || name.length === 0) {
    log("WARN", `Invalid metric payload: ${JSON.stringify(req.body)}`);
    res
      .status(400)
      .json({ error: "name (non-empty string) and value (finite number) are required" });
    return;
  }
  if (name.length > MAX_METRIC_NAME_LENGTH) {
    log("WARN", `Metric name too long: length=${name.length}`);
    res.status(400).json({
      error: `name must be at most ${MAX_METRIC_NAME_LENGTH} characters`,
    });
    return;
  }
  // value は number 型で、かつ有限値（Infinity / -Infinity / NaN を除く）でなければならない。
  // JSON.parse('1e500') は Infinity を返すため、typeof チェックだけでは抜けてしまう。
  if (typeof value !== "number" || !Number.isFinite(value)) {
    log("WARN", `Invalid metric payload: ${JSON.stringify(req.body)}`);
    res
      .status(400)
      .json({ error: "name (non-empty string) and value (finite number) are required" });
    return;
  }

  // tags は型注釈だけでは実行時に強制されないため、明示的にバリデーションする。
  const tagsResult = validateTags(tags);
  if (!tagsResult.ok) {
    log("WARN", `Invalid metric tags: ${tagsResult.error}`);
    res.status(400).json({ error: tagsResult.error });
    return;
  }

  const metric: DashboardMetric = {
    name,
    value,
    tags: tagsResult.value,
    recorded_at: new Date().toISOString(),
  };
  dashboardStore.push(metric);

  // 保持件数上限を超えたら FIFO で古いものから破棄する。
  if (MAX_DASHBOARD_METRICS > 0 && dashboardStore.length > MAX_DASHBOARD_METRICS) {
    const overflow = dashboardStore.length - MAX_DASHBOARD_METRICS;
    dashboardStore.splice(0, overflow);
    log(
      "INFO",
      `Evicted ${overflow} old metric(s) (cap=${MAX_DASHBOARD_METRICS})`
    );
  }

  log("INFO", `Dashboard metric added: ${name} = ${value}`);
  res.status(201).json(metric);
});

app.get("/api/v1/dashboard/summary", (req: Request, res: Response) => {
  const limit = parseSummaryLimit(
    req.query.limit,
    DEFAULT_SUMMARY_LIMIT,
    MAX_SUMMARY_LIMIT,
  );
  if (limit === null) {
    log("WARN", `Invalid limit param: ${JSON.stringify(req.query.limit)}`);
    res.status(400).json({
      error: `limit must be a positive integer between 1 and ${MAX_SUMMARY_LIMIT}`,
    });
    return;
  }
  const summary: DashboardSummary = {
    total_metrics: dashboardStore.length,
    limit,
    metrics: dashboardStore.slice(-limit),
    generated_at: new Date().toISOString(),
  };
  log(
    "INFO",
    `Dashboard summary generated: ${summary.total_metrics} metrics (limit=${limit})`,
  );
  res.json(summary);
});

// 保持中のメトリクス名と件数・最終記録時刻を一覧で返す。
// UI のドロップダウン構築や運用調査用途で、`summary?limit=最大` で全件取得
// → クライアント側で抽出するパターンを置き換える。
// `/:name` パターンの前に登録する（`names` が `:name` にマッチしないよう、
// 静的セグメントを先に評価させるため）。
app.get("/api/v1/dashboard/metrics/names", (req: Request, res: Response) => {
  // `?since=` / `?until=` (ISO8601) が指定されると `recorded_at` が範囲内の
  // 観測のみを集計する。`/count` や `/:name/stats` の窓フィルタと整合する。
  const sinceParsed = parseIsoDateTime(req.query.since, "since");
  if (sinceParsed.error !== null) {
    log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
    res.status(400).json({ error: sinceParsed.error });
    return;
  }
  const untilParsed = parseIsoDateTime(req.query.until, "until");
  if (untilParsed.error !== null) {
    log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
    res.status(400).json({ error: untilParsed.error });
    return;
  }
  if (
    sinceParsed.value !== null &&
    untilParsed.value !== null &&
    sinceParsed.value.getTime() > untilParsed.value.getTime()
  ) {
    log(
      "WARN",
      `Invalid range: since=${req.query.since} > until=${req.query.until}`,
    );
    res
      .status(400)
      .json({ error: "since must be less than or equal to until" });
    return;
  }

  const hasTimeFilter =
    sinceParsed.value !== null || untilParsed.value !== null;
  const sinceMs = sinceParsed.value !== null ? sinceParsed.value.getTime() : null;
  const untilMs = untilParsed.value !== null ? untilParsed.value.getTime() : null;

  // 1 回のスキャンで {count, latest_recorded_at_ms} を集計する。
  // recorded_at は ISO8601 文字列なので Date.parse で比較する。
  const summary = new Map<
    string,
    { count: number; latestMs: number; latestRecordedAt: string }
  >();
  for (const m of dashboardStore) {
    const ts = Date.parse(m.recorded_at);
    if (hasTimeFilter) {
      // パース不能な値は時間フィルタ下では集計対象外とする（窓内/窓外を判定できないため）。
      // 窓フィルタなしの場合は従来通り全件を集計対象に含める。
      if (Number.isNaN(ts)) {
        continue;
      }
      if (sinceMs !== null && ts < sinceMs) {
        continue;
      }
      if (untilMs !== null && ts > untilMs) {
        continue;
      }
    }
    const existing = summary.get(m.name);
    if (existing === undefined) {
      // パース不能な値が万一混入していたら、ms は -Infinity として扱い、
      // 以降の比較で常に上書きされるようにする（クライアントには文字列を返す）。
      summary.set(m.name, {
        count: 1,
        latestMs: Number.isNaN(ts) ? Number.NEGATIVE_INFINITY : ts,
        latestRecordedAt: m.recorded_at,
      });
      continue;
    }
    existing.count += 1;
    if (!Number.isNaN(ts) && ts >= existing.latestMs) {
      existing.latestMs = ts;
      existing.latestRecordedAt = m.recorded_at;
    }
  }
  const names = Array.from(summary.entries())
    .map(([name, v]) => ({
      name,
      count: v.count,
      latest_recorded_at: v.latestRecordedAt,
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const sinceIso =
    sinceParsed.value !== null ? sinceParsed.value.toISOString() : null;
  const untilIso =
    untilParsed.value !== null ? untilParsed.value.toISOString() : null;
  log(
    "INFO",
    `Listed metric names: ${names.length} distinct name(s)` +
      ` since=${sinceIso ?? ""} until=${untilIso ?? ""}`,
  );
  res.json({ names, count: names.length, since: sinceIso, until: untilIso });
});

// 保持中メトリクスの件数のみを返す軽量エンドポイント。
// `summary?limit=1` のようにレコード本体を取得しなくても件数だけ知りたい UI
// （バッジ表示・ヘッダ集計・ページャ初期化等）向け。
// `?name=` で完全一致絞り込み、`?since=` / `?until=` (ISO8601) で時間範囲を絞り込める。
// `by_name` は観測実績のある名前のみを返し、count 0 の名前は埋めない（軽量化）。
// `/:name` より前に登録して経路の衝突を避ける。
app.get("/api/v1/dashboard/metrics/count", (req: Request, res: Response) => {
  const sinceParsed = parseIsoDateTime(req.query.since, "since");
  if (sinceParsed.error !== null) {
    log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
    res.status(400).json({ error: sinceParsed.error });
    return;
  }
  const untilParsed = parseIsoDateTime(req.query.until, "until");
  if (untilParsed.error !== null) {
    log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
    res.status(400).json({ error: untilParsed.error });
    return;
  }
  if (
    sinceParsed.value !== null &&
    untilParsed.value !== null &&
    sinceParsed.value.getTime() > untilParsed.value.getTime()
  ) {
    log(
      "WARN",
      `Invalid range: since=${req.query.since} > until=${req.query.until}`,
    );
    res
      .status(400)
      .json({ error: "since must be less than or equal to until" });
    return;
  }

  // `name` クエリは未指定 / 単一文字列のみ受理。配列や空文字は 400。
  let nameFilter: string | null = null;
  if (req.query.name !== undefined) {
    if (typeof req.query.name !== "string" || req.query.name.length === 0) {
      log("WARN", `Invalid name param: ${JSON.stringify(req.query.name)}`);
      res.status(400).json({ error: "name must be a non-empty string" });
      return;
    }
    if (req.query.name.length > MAX_METRIC_NAME_LENGTH) {
      log(
        "WARN",
        `Name param too long: ${req.query.name.length} > ${MAX_METRIC_NAME_LENGTH}`,
      );
      res.status(400).json({
        error: `name must be at most ${MAX_METRIC_NAME_LENGTH} characters`,
      });
      return;
    }
    nameFilter = req.query.name;
  }

  const sinceIso =
    sinceParsed.value !== null ? sinceParsed.value.toISOString() : null;
  const untilIso =
    untilParsed.value !== null ? untilParsed.value.toISOString() : null;

  let total = 0;
  const byName = new Map<string, number>();
  for (const m of dashboardStore) {
    if (nameFilter !== null && m.name !== nameFilter) {
      continue;
    }
    if (sinceParsed.value !== null || untilParsed.value !== null) {
      const ts = Date.parse(m.recorded_at);
      if (Number.isNaN(ts)) {
        continue;
      }
      if (sinceParsed.value !== null && ts < sinceParsed.value.getTime()) {
        continue;
      }
      if (untilParsed.value !== null && ts > untilParsed.value.getTime()) {
        continue;
      }
    }
    total += 1;
    byName.set(m.name, (byName.get(m.name) ?? 0) + 1);
  }

  const by_name: Record<string, number> = {};
  // 名前のソートは決定論的にする（クライアントが diff を取りやすいように）。
  const sortedNames = Array.from(byName.keys()).sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  for (const n of sortedNames) {
    by_name[n] = byName.get(n) ?? 0;
  }

  log(
    "INFO",
    `Dashboard count: total=${total} distinct_names=${sortedNames.length}` +
      ` name=${nameFilter ?? ""} since=${sinceIso ?? ""} until=${untilIso ?? ""}`,
  );
  res.json({
    total,
    by_name,
    name: nameFilter,
    since: sinceIso,
    until: untilIso,
  });
});

// 指定メトリクス名の集計統計を返す。api-gateway の
// /api/v1/metrics/{name}/stats とレスポンス形状・受け付けクエリを揃える。
// `?since=` / `?until=` (ISO8601) で集計対象期間を絞り込める。
// `/:name` より前に登録して経路の衝突を避ける。
app.get(
  "/api/v1/dashboard/metrics/:name/stats",
  (req: Request, res: Response) => {
    // Express のルートパラメータは実行時には常に string。
    const name = String(req.params.name);

    const sinceParsed = parseIsoDateTime(req.query.since, "since");
    if (sinceParsed.error !== null) {
      log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
      res.status(400).json({ error: sinceParsed.error });
      return;
    }
    const untilParsed = parseIsoDateTime(req.query.until, "until");
    if (untilParsed.error !== null) {
      log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
      res.status(400).json({ error: untilParsed.error });
      return;
    }
    if (
      sinceParsed.value !== null &&
      untilParsed.value !== null &&
      sinceParsed.value.getTime() > untilParsed.value.getTime()
    ) {
      log(
        "WARN",
        `Invalid range: since=${req.query.since} > until=${req.query.until}`,
      );
      res
        .status(400)
        .json({ error: "since must be less than or equal to until" });
      return;
    }

    const filteredByName = dashboardStore.filter((m) => m.name === name);
    if (filteredByName.length === 0) {
      log("WARN", `Metric not found: ${name}`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    const filtered = filterByRecordedAt(
      filteredByName,
      sinceParsed.value,
      untilParsed.value,
    );
    if (filtered.length === 0) {
      log(
        "INFO",
        `No metrics in window for '${name}' (since=${req.query.since} until=${req.query.until})`,
      );
      res.status(404).json({
        error: `No metrics found for '${name}' in the given window`,
      });
      return;
    }
    const stats = computeStats(name, filtered);
    log("INFO", `Computed stats for '${name}' (count=${stats.count})`);
    res.json(stats);
  }
);

// 指定メトリクス名の最新 1 件だけを返す。
// 一覧 (`/:name`) と集計 (`/:name/stats`) と並んで、リアルタイム表示・状態バッジ等で
// 「いま最新の値だけ知りたい」ケース向けの軽量エンドポイント。dashboardStore は
// POST 受理順に push されており、name で filter した配列の末尾が常に最新となる。
// `?since=` / `?until=`（ISO 8601）が指定されると、`recorded_at` が窓内にある
// 観測のうち最新を返す（`/stats` の窓フィルタと整合）。
// 経路衝突回避のため `/:name` より前に登録する（Express は登録順で評価する）。
app.get(
  "/api/v1/dashboard/metrics/:name/latest",
  (req: Request, res: Response) => {
    const name = String(req.params.name);

    const sinceParsed = parseIsoDateTime(req.query.since, "since");
    if (sinceParsed.error !== null) {
      log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
      res.status(400).json({ error: sinceParsed.error });
      return;
    }
    const untilParsed = parseIsoDateTime(req.query.until, "until");
    if (untilParsed.error !== null) {
      log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
      res.status(400).json({ error: untilParsed.error });
      return;
    }
    if (
      sinceParsed.value !== null &&
      untilParsed.value !== null &&
      sinceParsed.value.getTime() > untilParsed.value.getTime()
    ) {
      log(
        "WARN",
        `Invalid range: since=${req.query.since} > until=${req.query.until}`,
      );
      res
        .status(400)
        .json({ error: "since must be less than or equal to until" });
      return;
    }

    const hasTimeFilter =
      sinceParsed.value !== null || untilParsed.value !== null;

    let latest: DashboardMetric | null = null;
    let nameSeen = false;
    for (const m of dashboardStore) {
      if (m.name !== name) {
        continue;
      }
      nameSeen = true;
      if (hasTimeFilter) {
        const ts = Date.parse(m.recorded_at);
        if (Number.isNaN(ts)) {
          continue;
        }
        if (
          sinceParsed.value !== null &&
          ts < sinceParsed.value.getTime()
        ) {
          continue;
        }
        if (
          untilParsed.value !== null &&
          ts > untilParsed.value.getTime()
        ) {
          continue;
        }
      }
      latest = m;
    }
    if (latest === null) {
      if (hasTimeFilter && nameSeen) {
        log(
          "INFO",
          `No metrics in window for '${name}' (since=${req.query.since} until=${req.query.until})`,
        );
        res.status(404).json({
          error: `No metrics found for '${name}' in the given window`,
        });
        return;
      }
      log("WARN", `Metric not found: ${name}`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    log("INFO", `Returned latest metric for '${name}' (value=${latest.value})`);
    res.json(latest);
  }
);

// 指定メトリクス名を時系列バケットに集約して返す。
// `bucket_seconds` 幅の半開区間 [bucket_start, bucket_start + bucket_seconds) で
// recorded_at をビニングし、各バケットで count / min / max / avg / p50 / p95 / p99 を返す。
// 観測のないバケットは結果に含めない（スパース表現）。
// `?since=` / `?until=` (ISO8601) で集計対象期間を絞り込める。
// `/:name` より前に登録して経路の衝突を避ける（`names` / `stats` / `latest` と同じ理由）。
app.get(
  "/api/v1/dashboard/metrics/:name/timeseries",
  (req: Request, res: Response) => {
    const name = String(req.params.name);

    const sinceParsed = parseIsoDateTime(req.query.since, "since");
    if (sinceParsed.error !== null) {
      log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
      res.status(400).json({ error: sinceParsed.error });
      return;
    }
    const untilParsed = parseIsoDateTime(req.query.until, "until");
    if (untilParsed.error !== null) {
      log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
      res.status(400).json({ error: untilParsed.error });
      return;
    }
    if (
      sinceParsed.value !== null &&
      untilParsed.value !== null &&
      sinceParsed.value.getTime() > untilParsed.value.getTime()
    ) {
      log(
        "WARN",
        `Invalid range: since=${req.query.since} > until=${req.query.until}`,
      );
      res
        .status(400)
        .json({ error: "since must be less than or equal to until" });
      return;
    }

    // bucket_seconds は 1〜86400 (1 日) の整数のみ受理。analytics-api と同範囲。
    const bucketSeconds = parseBucketSecondsParam(req.query.bucket_seconds);
    if (bucketSeconds === null) {
      log(
        "WARN",
        `Invalid bucket_seconds param: ${JSON.stringify(req.query.bucket_seconds)}`,
      );
      res.status(400).json({
        error:
          "bucket_seconds must be a positive integer between 1 and 86400",
      });
      return;
    }

    const filteredByName = dashboardStore.filter((m) => m.name === name);
    if (filteredByName.length === 0) {
      log("WARN", `Metric not found: ${name}`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    const filtered = filterByRecordedAt(
      filteredByName,
      sinceParsed.value,
      untilParsed.value,
    );
    if (filtered.length === 0) {
      log(
        "INFO",
        `No metrics in window for '${name}' (since=${req.query.since} until=${req.query.until})`,
      );
      res.status(404).json({
        error: `No metrics found for '${name}' in the given window`,
      });
      return;
    }

    const buckets = bucketByTime(filtered, bucketSeconds);
    log(
      "INFO",
      `Computed timeseries for '${name}' (count=${buckets.length}, bucket_seconds=${bucketSeconds})`,
    );
    res.json({
      name,
      bucket_seconds: bucketSeconds,
      count: buckets.length,
      buckets,
    });
  }
);

app.get(
  "/api/v1/dashboard/metrics/:name",
  (req: Request, res: Response) => {
    const { name } = req.params;

    // since / until は ISO8601 文字列。未指定なら null。
    const sinceParsed = parseIsoDateTime(req.query.since, "since");
    if (sinceParsed.error !== null) {
      log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
      res.status(400).json({ error: sinceParsed.error });
      return;
    }
    const untilParsed = parseIsoDateTime(req.query.until, "until");
    if (untilParsed.error !== null) {
      log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
      res.status(400).json({ error: untilParsed.error });
      return;
    }
    if (
      sinceParsed.value !== null &&
      untilParsed.value !== null &&
      sinceParsed.value.getTime() > untilParsed.value.getTime()
    ) {
      log(
        "WARN",
        `Invalid range: since=${req.query.since} > until=${req.query.until}`,
      );
      res
        .status(400)
        .json({ error: "since must be less than or equal to until" });
      return;
    }

    const limit = parseSummaryLimit(
      req.query.limit,
      DEFAULT_SUMMARY_LIMIT,
      MAX_SUMMARY_LIMIT,
    );
    if (limit === null) {
      log("WARN", `Invalid limit param: ${JSON.stringify(req.query.limit)}`);
      res.status(400).json({
        error: `limit must be a positive integer between 1 and ${MAX_SUMMARY_LIMIT}`,
      });
      return;
    }
    // offset は 0 以上。parseSummaryLimit は最小 1 のため別関数で扱う。
    const offset = parseOffsetParam(req.query.offset);
    if (offset === null) {
      log("WARN", `Invalid offset param: ${JSON.stringify(req.query.offset)}`);
      res.status(400).json({ error: "offset must be a non-negative integer" });
      return;
    }

    const filteredByName = dashboardStore.filter((m) => m.name === name);
    if (filteredByName.length === 0) {
      log("WARN", `Metric not found: ${name}`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    const filtered = filterByRecordedAt(
      filteredByName,
      sinceParsed.value,
      untilParsed.value,
    );

    const total = filtered.length;
    const page = filtered.slice(offset, offset + limit);
    log(
      "INFO",
      `Found ${total} metrics for '${name}' (returning ${page.length}, limit=${limit}, offset=${offset})`,
    );
    res.json({
      name,
      count: page.length,
      total,
      limit,
      offset,
      metrics: page,
    });
  }
);

// 全メトリクスを破棄する。運用時の掃除手段として用意する。
app.delete("/api/v1/dashboard/metrics", (_req: Request, res: Response) => {
  const deleted = dashboardStore.length;
  dashboardStore.length = 0;
  log("INFO", `Deleted ${deleted} dashboard metric(s) (all)`);
  res.json({ deleted });
});

// 名前指定で破棄する。存在しない名前は 404。
// `?since=` / `?until=` (ISO8601) を指定すると `recorded_at` が範囲内の
// レコードのみが削除対象になる（age-based cleanup 用途）。
app.delete(
  "/api/v1/dashboard/metrics/:name",
  (req: Request, res: Response) => {
    const name = String(req.params.name);

    const sinceParsed = parseIsoDateTime(req.query.since, "since");
    if (sinceParsed.error !== null) {
      log("WARN", `Invalid since param: ${JSON.stringify(req.query.since)}`);
      res.status(400).json({ error: sinceParsed.error });
      return;
    }
    const untilParsed = parseIsoDateTime(req.query.until, "until");
    if (untilParsed.error !== null) {
      log("WARN", `Invalid until param: ${JSON.stringify(req.query.until)}`);
      res.status(400).json({ error: untilParsed.error });
      return;
    }
    if (
      sinceParsed.value !== null &&
      untilParsed.value !== null &&
      sinceParsed.value.getTime() > untilParsed.value.getTime()
    ) {
      log(
        "WARN",
        `Invalid range: since=${req.query.since} > until=${req.query.until}`,
      );
      res
        .status(400)
        .json({ error: "since must be less than or equal to until" });
      return;
    }

    const hasTimeFilter =
      sinceParsed.value !== null || untilParsed.value !== null;
    const sinceMs =
      sinceParsed.value !== null ? sinceParsed.value.getTime() : null;
    const untilMs =
      untilParsed.value !== null ? untilParsed.value.getTime() : null;

    const before = dashboardStore.length;
    // 同名分だけ in-place で除去（split + reassign は export 参照を壊すため避ける）
    for (let i = dashboardStore.length - 1; i >= 0; i--) {
      const m = dashboardStore[i];
      if (m.name !== name) {
        continue;
      }
      if (hasTimeFilter) {
        const ts = Date.parse(m.recorded_at);
        if (Number.isNaN(ts)) {
          // 壊れた recorded_at は時間フィルタ指定時には削除対象から外す
          // (filterByRecordedAt と同じ「安全側」の振る舞いに揃える)
          continue;
        }
        if (sinceMs !== null && ts < sinceMs) continue;
        if (untilMs !== null && ts > untilMs) continue;
      }
      dashboardStore.splice(i, 1);
    }
    const deleted = before - dashboardStore.length;
    if (deleted === 0) {
      log(
        "WARN",
        `Delete miss: no metrics matched name='${name}'` +
          (hasTimeFilter
            ? ` in window since=${req.query.since} until=${req.query.until}`
            : ""),
      );
      const errMsg = hasTimeFilter
        ? `No metrics found for '${name}' in the given window`
        : `No metrics found for '${name}'`;
      res.status(404).json({ error: errMsg });
      return;
    }
    log(
      "INFO",
      `Deleted ${deleted} metric(s) for name='${name}'` +
        (hasTimeFilter
          ? ` (since=${req.query.since}, until=${req.query.until})`
          : ""),
    );
    const responseBody: {
      deleted: number;
      name: string;
      since?: string;
      until?: string;
    } = { deleted, name };
    if (typeof req.query.since === "string" && req.query.since.length > 0) {
      responseBody.since = req.query.since;
    }
    if (typeof req.query.until === "string" && req.query.until.length > 0) {
      responseBody.until = req.query.until;
    }
    res.json(responseBody);
  }
);

// express.json の limit 超過は SyntaxError ではなく entity.too.large になる。
// 専用のエラーハンドラを置いて 413 を返す（既存の 500 ハンドラの前段）。
app.use(
  (err: Error & { type?: string; status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (err && (err.type === "entity.too.large" || err.status === 413)) {
      log("WARN", `Request body too large (limit=${MAX_REQUEST_BODY})`);
      res.status(413).json({ error: "request body too large" });
      return;
    }
    next(err);
  }
);

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log("ERROR", `Unhandled error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

export {
  app,
  dashboardStore,
  MAX_DASHBOARD_METRICS,
  MAX_REQUEST_BODY,
  MAX_METRIC_NAME_LENGTH,
  MAX_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
  TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH,
  TAG_MAX_KEYS,
  parseSummaryLimit,
  parseOffsetParam,
  parseIsoDateTime,
  parseBucketSecondsParam,
  filterByRecordedAt,
  computeStats,
  percentile,
  bucketByTime,
  validateTags,
};

if (require.main === module) {
  app.listen(PORT, () => {
    log("INFO", `Dashboard BFF started on port ${PORT}`);
  });
}
