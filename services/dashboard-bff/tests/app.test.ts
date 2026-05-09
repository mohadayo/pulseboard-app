import request from "supertest";
import { app, dashboardStore } from "../src/index";

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
});

describe("GET /api/v1/dashboard/summary", () => {
  it("returns empty summary", async () => {
    const res = await request(app).get("/api/v1/dashboard/summary");
    expect(res.status).toBe(200);
    expect(res.body.total_metrics).toBe(0);
    expect(res.body.metrics).toEqual([]);
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
