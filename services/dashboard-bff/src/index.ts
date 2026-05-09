import express, { Request, Response, NextFunction } from "express";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8002;
const API_GATEWAY_URL =
  process.env.API_GATEWAY_URL || "http://api-gateway:8000";
const WORKER_URL = process.env.WORKER_URL || "http://metrics-worker:8001";

function log(level: string, message: string): void {
  const ts = new Date().toISOString();
  console.log(`${ts} [${level}] dashboard-bff: ${message}`);
}

interface DashboardMetric {
  name: string;
  value: number;
  recorded_at: string;
  tags?: Record<string, string>;
}

interface DashboardSummary {
  total_metrics: number;
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
  const { name, value, tags } = req.body;

  if (!name || typeof value !== "number") {
    log("WARN", `Invalid metric payload: ${JSON.stringify(req.body)}`);
    res.status(400).json({ error: "name (string) and value (number) are required" });
    return;
  }

  const metric: DashboardMetric = {
    name,
    value,
    tags,
    recorded_at: new Date().toISOString(),
  };
  dashboardStore.push(metric);
  log("INFO", `Dashboard metric added: ${name} = ${value}`);
  res.status(201).json(metric);
});

app.get("/api/v1/dashboard/summary", (_req: Request, res: Response) => {
  const summary: DashboardSummary = {
    total_metrics: dashboardStore.length,
    metrics: dashboardStore.slice(-50),
    generated_at: new Date().toISOString(),
  };
  log("INFO", `Dashboard summary generated: ${summary.total_metrics} metrics`);
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

app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
  log("ERROR", `Unhandled error: ${err.message}`);
  res.status(500).json({ error: "Internal server error" });
});

export { app, dashboardStore };

if (require.main === module) {
  app.listen(PORT, () => {
    log("INFO", `Dashboard BFF started on port ${PORT}`);
  });
}
