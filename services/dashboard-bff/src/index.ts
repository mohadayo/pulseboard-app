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

  const metric: DashboardMetric = {
    name,
    value,
    tags,
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

app.get(
  "/api/v1/dashboard/metrics/:name",
  (req: Request, res: Response) => {
    const { name } = req.params;
    const filtered = dashboardStore.filter((m) => m.name === name);
    if (filtered.length === 0) {
      log("WARN", `Metric not found: ${name}`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    log("INFO", `Found ${filtered.length} metrics for '${name}'`);
    res.json({ name, count: filtered.length, metrics: filtered });
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
app.delete(
  "/api/v1/dashboard/metrics/:name",
  (req: Request, res: Response) => {
    const { name } = req.params;
    const before = dashboardStore.length;
    // 同名分だけ in-place で除去（split + reassign は export 参照を壊すため避ける）
    for (let i = dashboardStore.length - 1; i >= 0; i--) {
      if (dashboardStore[i].name === name) {
        dashboardStore.splice(i, 1);
      }
    }
    const deleted = before - dashboardStore.length;
    if (deleted === 0) {
      log("WARN", `Delete miss: no metrics matched name='${name}'`);
      res.status(404).json({ error: `No metrics found for '${name}'` });
      return;
    }
    log("INFO", `Deleted ${deleted} metric(s) for name='${name}'`);
    res.json({ deleted, name });
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
  parseSummaryLimit,
};

if (require.main === module) {
  app.listen(PORT, () => {
    log("INFO", `Dashboard BFF started on port ${PORT}`);
  });
}
