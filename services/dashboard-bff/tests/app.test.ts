import request from "supertest";
import {
  app,
  dashboardStore,
  MAX_DASHBOARD_METRICS,
  MAX_METRIC_NAME_LENGTH,
  MAX_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
  parseSummaryLimit,
} from "../src/index";

beforeEach(() => {
  dashboardStore.length = 0;
});

describe("GET /health", () => {
  it("returns ok status", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("ok");
    expect(res.body.service).toBe("dashboard-bff");
    expect(res.body.timestamp).toBeDefined();
    expect(res.body.upstreams).toBeDefined();
  });
});

describe("POST /api/v1/dashboard/metrics", () => {
  it("creates a metric", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 65.2 });
    expect(res.status).toBe(201);
    expect(res.body.name).toBe("cpu");
    expect(res.body.value).toBe(65.2);
    expect(res.body.recorded_at).toBeDefined();
  });

  it("creates a metric with tags", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 2048, tags: { region: "us-east" } });
    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual({ region: "us-east" });
  });

  it("rejects missing name", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ value: 10 });
    expect(res.status).toBe(400);
  });

  it("rejects missing value", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu" });
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric value", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: "high" });
    expect(res.status).toBe(400);
  });

  it("rejects non-string name (number)", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: 42, value: 1 });
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });

  it("rejects non-string name (object)", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: { evil: true }, value: 1 });
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });

  it("rejects empty string name", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "", value: 1 });
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });

  it("rejects name longer than MAX_METRIC_NAME_LENGTH", async () => {
    const tooLong = "x".repeat(MAX_METRIC_NAME_LENGTH + 1);
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: tooLong, value: 1 });
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });

  it("accepts name with exactly MAX_METRIC_NAME_LENGTH characters", async () => {
    const exact = "x".repeat(MAX_METRIC_NAME_LENGTH);
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: exact, value: 1 });
    expect(res.status).toBe(201);
  });

  it("rejects positive Infinity (1e500 parses to Infinity)", async () => {
    // JSON.parse('1e500') は Infinity を返すため、raw JSON で送る必要がある。
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send('{"name":"cpu","value":1e500}');
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });

  it("rejects negative Infinity", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send('{"name":"cpu","value":-1e500}');
    expect(res.status).toBe(400);
    expect(dashboardStore).toHaveLength(0);
  });
});

describe("GET /api/v1/dashboard/summary", () => {
  it("returns empty summary", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.total_metrics).toBe(0);
    expect(res.body.metrics).toEqual([]);
    expect(res.body.limit).toBe(DEFAULT_SUMMARY_LIMIT);
  });

  it("returns summary with metrics", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 50 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 1024 });

    const res = await request(app).get("/api/v1/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.total_metrics).toBe(2);
    expect(res.body.metrics).toHaveLength(2);
    expect(res.body.limit).toBe(DEFAULT_SUMMARY_LIMIT);
  });

  it("caps to default 50 when more than 50 metrics exist (backward compat)", async () => {
    // 既定値での挙動を回帰確認：limit 未指定なら最新 50 件だけ返す。
    for (let i = 0; i < 60; i++) {
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: i });
    }
    const res = await request(app).get("/api/v1/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.total_metrics).toBe(60);
    expect(res.body.metrics).toHaveLength(50);
    // 末尾 50 件のうち先頭は 10、末尾は 59 のはず（FIFO push）
    expect(res.body.metrics[0].value).toBe(10);
    expect(res.body.metrics[49].value).toBe(59);
  });

  it("honors ?limit= when valid", async () => {
    for (let i = 0; i < 10; i++) {
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: i });
    }
    const res = await request(app).get("/api/v1/dashboard/summary?limit=3");
    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(3);
    expect(res.body.metrics).toHaveLength(3);
    expect(res.body.metrics.map((m: { value: number }) => m.value)).toEqual([7, 8, 9]);
  });

  it("limit larger than store returns all metrics", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 2 });
    const res = await request(app).get("/api/v1/dashboard/summary?limit=100");
    expect(res.status).toBe(200);
    expect(res.body.metrics).toHaveLength(2);
  });

  it("rejects limit=0", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary?limit=0");
    expect(res.status).toBe(400);
  });

  it("rejects negative limit", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary?limit=-5");
    expect(res.status).toBe(400);
  });

  it("rejects non-integer limit", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary?limit=10.5");
    expect(res.status).toBe(400);
  });

  it("rejects non-numeric limit", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary?limit=abc");
    expect(res.status).toBe(400);
  });

  it("rejects limit above MAX_SUMMARY_LIMIT", async () => {
    const res = await request(app)
      .get(`/api/v1/dashboard/summary?limit=${MAX_SUMMARY_LIMIT + 1}`);
    expect(res.status).toBe(400);
  });
});

describe("parseSummaryLimit helper", () => {
  it("returns default when undefined", () => {
    expect(parseSummaryLimit(undefined, 50, 500)).toBe(50);
  });
  it("returns null for empty string", () => {
    expect(parseSummaryLimit("", 50, 500)).toBeNull();
  });
  it("returns null for array input (defensive)", () => {
    expect(parseSummaryLimit(["10"], 50, 500)).toBeNull();
  });
  it("parses positive integer string", () => {
    expect(parseSummaryLimit("25", 50, 500)).toBe(25);
  });
  it("rejects negative integer string", () => {
    expect(parseSummaryLimit("-1", 50, 500)).toBeNull();
  });
  it("rejects zero", () => {
    expect(parseSummaryLimit("0", 50, 500)).toBeNull();
  });
  it("rejects non-integer", () => {
    expect(parseSummaryLimit("3.5", 50, 500)).toBeNull();
  });
  it("rejects out-of-range", () => {
    expect(parseSummaryLimit("501", 50, 500)).toBeNull();
  });
  it("accepts maxLimit boundary", () => {
    expect(parseSummaryLimit("500", 50, 500)).toBe(500);
  });
});

describe("GET /api/v1/dashboard/metrics/:name", () => {
  it("returns filtered metrics", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 50 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 75 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 1024 });

    const res = await request(app).get("/api/v1/dashboard/metrics/cpu");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
    expect(res.body.name).toBe("cpu");
  });

  it("returns 404 for unknown metric", async () => {
    const res = await request(app).get("/api/v1/dashboard/metrics/unknown");
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/v1/dashboard/metrics", () => {
  it("clears all metrics", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 100 });

    const res = await request(app).delete("/api/v1/dashboard/metrics");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(dashboardStore).toHaveLength(0);
  });

  it("returns 0 deleted when store is empty", async () => {
    const res = await request(app).delete("/api/v1/dashboard/metrics");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(0);
  });
});

describe("DELETE /api/v1/dashboard/metrics/:name", () => {
  it("deletes only metrics matching the given name", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 20 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 100 });

    const res = await request(app).delete("/api/v1/dashboard/metrics/cpu");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(res.body.name).toBe("cpu");
    expect(dashboardStore).toHaveLength(1);
    expect(dashboardStore[0].name).toBe("mem");
  });

  it("returns 404 when no metrics match the name", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });

    const res = await request(app).delete("/api/v1/dashboard/metrics/missing");
    expect(res.status).toBe(404);
    // Existing metric must still be present
    expect(dashboardStore).toHaveLength(1);
  });
});

describe("Resource limits", () => {
  it("exports a positive default MAX_DASHBOARD_METRICS", () => {
    expect(MAX_DASHBOARD_METRICS).toBeGreaterThan(0);
  });

  it("evicts oldest metrics when store exceeds MAX_DASHBOARD_METRICS (FIFO)", async () => {
    // 上限ぎりぎりまで埋める
    for (let i = 0; i < MAX_DASHBOARD_METRICS; i++) {
      dashboardStore.push({
        name: "seed",
        value: i,
        recorded_at: new Date().toISOString(),
      });
    }
    expect(dashboardStore).toHaveLength(MAX_DASHBOARD_METRICS);

    // 上限を超えて 1 件追加 → 一番古い (value=0) が落ちる
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "fresh", value: 9999 });
    expect(res.status).toBe(201);
    expect(dashboardStore).toHaveLength(MAX_DASHBOARD_METRICS);
    // 一番古いエントリは消えている
    expect(dashboardStore[0]).not.toMatchObject({ name: "seed", value: 0 });
    // 末尾に新規エントリ
    expect(dashboardStore[dashboardStore.length - 1]).toMatchObject({
      name: "fresh",
      value: 9999,
    });
  });

  it("rejects request bodies larger than the JSON body limit", async () => {
    // 既定 100kb を超えるよう、value に巨大な数値配列を文字列化したものを tags に乗せる
    const big = "x".repeat(200 * 1024);
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send({ name: "cpu", value: 10, tags: { padding: big } });
    expect(res.status).toBe(413);
    expect(res.body.error).toMatch(/too large/i);
    // store には残らない
    expect(dashboardStore).toHaveLength(0);
  });
});
