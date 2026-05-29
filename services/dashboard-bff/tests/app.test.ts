import request from "supertest";
import {
  app,
  dashboardStore,
  MAX_DASHBOARD_METRICS,
  MAX_METRIC_NAME_LENGTH,
  MAX_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
  TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH,
  TAG_MAX_KEYS,
  parseSummaryLimit,
  computeStats,
  validateTags,
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
    expect(res.body.total).toBe(2);
    expect(res.body.name).toBe("cpu");
  });

  it("returns 404 for unknown metric", async () => {
    const res = await request(app).get("/api/v1/dashboard/metrics/unknown");
    expect(res.status).toBe(404);
  });

  // since / until / limit / offset
  describe("filtering and pagination", () => {
    async function seed(name: string, count: number): Promise<void> {
      for (let i = 0; i < count; i++) {
        await request(app)
          .post("/api/v1/dashboard/metrics")
          .send({ name, value: i });
      }
    }

    it("applies limit and offset to the response", async () => {
      await seed("cpu", 5);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?limit=2&offset=1",
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(5);
      expect(res.body.count).toBe(2);
      expect(res.body.limit).toBe(2);
      expect(res.body.offset).toBe(1);
      expect(res.body.metrics.map((m: { value: number }) => m.value)).toEqual([1, 2]);
    });

    it("defaults limit to DEFAULT_SUMMARY_LIMIT when not specified", async () => {
      await seed("cpu", DEFAULT_SUMMARY_LIMIT + 3);
      const res = await request(app).get("/api/v1/dashboard/metrics/cpu");
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(DEFAULT_SUMMARY_LIMIT + 3);
      expect(res.body.count).toBe(DEFAULT_SUMMARY_LIMIT);
      expect(res.body.metrics).toHaveLength(DEFAULT_SUMMARY_LIMIT);
    });

    it("returns empty page when offset is beyond available count", async () => {
      await seed("cpu", 3);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?offset=10",
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(3);
      expect(res.body.count).toBe(0);
      expect(res.body.metrics).toEqual([]);
    });

    it("filters by since (inclusive)", async () => {
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 1 });
      // 確実に recorded_at が変わるよう少し待つ
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 2 });
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 3 });

      const res = await request(app).get(
        `/api/v1/dashboard/metrics/cpu?since=${encodeURIComponent(cutoff)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.metrics.map((m: { value: number }) => m.value)).toEqual([2, 3]);
    });

    it("filters by until (inclusive)", async () => {
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 1 });
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 2 });
      await new Promise((r) => setTimeout(r, 10));
      const cutoff = new Date().toISOString();
      await new Promise((r) => setTimeout(r, 10));
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: 3 });

      const res = await request(app).get(
        `/api/v1/dashboard/metrics/cpu?until=${encodeURIComponent(cutoff)}`,
      );
      expect(res.status).toBe(200);
      expect(res.body.total).toBe(2);
      expect(res.body.metrics.map((m: { value: number }) => m.value)).toEqual([1, 2]);
    });

    it("rejects invalid since ISO8601", async () => {
      await seed("cpu", 1);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?since=not-a-date",
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("since");
    });

    it("rejects invalid until ISO8601", async () => {
      await seed("cpu", 1);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?until=banana",
      );
      expect(res.status).toBe(400);
    });

    it("rejects since > until", async () => {
      await seed("cpu", 1);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?since=2024-06-01T00:00:00Z&until=2024-01-01T00:00:00Z",
      );
      expect(res.status).toBe(400);
      expect(res.body.error).toContain("since");
    });

    it("rejects negative offset", async () => {
      await seed("cpu", 1);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?offset=-1",
      );
      expect(res.status).toBe(400);
    });

    it("rejects non-integer limit", async () => {
      await seed("cpu", 1);
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/cpu?limit=abc",
      );
      expect(res.status).toBe(400);
    });

    it("returns 404 when no metrics match the name (before time filter)", async () => {
      const res = await request(app).get(
        "/api/v1/dashboard/metrics/nope?since=2024-01-01T00:00:00Z",
      );
      expect(res.status).toBe(404);
    });
  });
});

describe("GET /api/v1/dashboard/metrics/:name/stats", () => {
  it("returns aggregate stats for a name", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 50 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 65 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 75 });
    // 別名のメトリクスは集計対象に含めない
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 1024 });

    const res = await request(app).get("/api/v1/dashboard/metrics/cpu/stats");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("cpu");
    expect(res.body.count).toBe(3);
    expect(res.body.min).toBe(50);
    expect(res.body.max).toBe(75);
    expect(res.body.sum).toBe(190);
    expect(res.body.avg).toBeCloseTo(63.3333, 4);
    expect(res.body.latest).toBe(75);
    expect(res.body.latest_recorded_at).toBeDefined();
    expect(res.body.first_recorded_at).toBeDefined();
  });

  it("returns 404 for unknown metric", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/unknown/stats",
    );
    expect(res.status).toBe(404);
  });

  it("handles a single metric", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "disk", value: 42 });
    const res = await request(app).get("/api/v1/dashboard/metrics/disk/stats");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.min).toBe(42);
    expect(res.body.max).toBe(42);
    expect(res.body.avg).toBe(42);
    expect(res.body.latest).toBe(42);
  });

  it("does not collide with the /:name list route", async () => {
    // 名前が "stats" のメトリクスを登録しても、/:name/stats は集計を返し、
    // /:name は一覧を返す（経路が衝突しないことの確認）。
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "stats", value: 7 });

    const statsRes = await request(app).get(
      "/api/v1/dashboard/metrics/stats/stats",
    );
    expect(statsRes.status).toBe(200);
    expect(statsRes.body.count).toBe(1);
    expect(statsRes.body.sum).toBe(7);

    const listRes = await request(app).get("/api/v1/dashboard/metrics/stats");
    expect(listRes.status).toBe(200);
    expect(listRes.body.metrics).toHaveLength(1);
    expect(listRes.body.name).toBe("stats");
  });
});

describe("computeStats helper", () => {
  it("computes stats over provided metrics in order", () => {
    const now = new Date().toISOString();
    const later = new Date(Date.now() + 1000).toISOString();
    const stats = computeStats("cpu", [
      { name: "cpu", value: 10, recorded_at: now },
      { name: "cpu", value: 30, recorded_at: later },
    ]);
    expect(stats.count).toBe(2);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(30);
    expect(stats.sum).toBe(40);
    expect(stats.avg).toBe(20);
    expect(stats.latest).toBe(30);
    expect(stats.latest_recorded_at).toBe(later);
    expect(stats.first_recorded_at).toBe(now);
  });

  it("handles negative values", () => {
    const ts = new Date().toISOString();
    const stats = computeStats("delta", [
      { name: "delta", value: -5, recorded_at: ts },
      { name: "delta", value: 5, recorded_at: ts },
    ]);
    expect(stats.min).toBe(-5);
    expect(stats.max).toBe(5);
    expect(stats.sum).toBe(0);
    expect(stats.avg).toBe(0);
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

describe("POST /api/v1/dashboard/metrics tags validation", () => {
  it("accepts a valid string→string tags object", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: { region: "us-east-1", env: "prod" } });
    expect(res.status).toBe(201);
    expect(res.body.tags).toEqual({ region: "us-east-1", env: "prod" });
  });

  it("accepts missing tags", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0 });
    expect(res.status).toBe(201);
    expect(res.body.tags).toBeUndefined();
  });

  it("accepts explicit null tags", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: null });
    expect(res.status).toBe(201);
  });

  it("rejects an array as tags", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: ["a", "b"] });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tags must be a plain object/);
  });

  it("rejects a string as tags", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: "not-an-object" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tags must be a plain object/);
  });

  it("rejects non-string tag values", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: { region: 123 } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tags\['region'\] must be a string/);
  });

  it("rejects too many tag keys", async () => {
    const tags: Record<string, string> = {};
    for (let i = 0; i < TAG_MAX_KEYS + 1; i++) tags[`k${i}`] = "v";
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/at most.*keys/);
  });

  it("rejects tag keys that exceed the length limit", async () => {
    const longKey = "k".repeat(TAG_KEY_MAX_LENGTH + 1);
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: { [longKey]: "v" } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/tags keys must be at most/);
  });

  it("rejects tag values that exceed the length limit", async () => {
    const longValue = "v".repeat(TAG_VALUE_MAX_LENGTH + 1);
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: { region: longValue } });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/must be at most.*characters/);
  });

  it("does not write to the store when tags are invalid", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 1.0, tags: ["bad"] });
    expect(dashboardStore).toHaveLength(0);
  });
});

describe("validateTags", () => {
  it("returns undefined for undefined input", () => {
    const r = validateTags(undefined);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  it("returns undefined for null input", () => {
    const r = validateTags(null);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toBeUndefined();
  });

  it("rejects empty-string keys", () => {
    const r = validateTags({ "": "v" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/non-empty/);
  });
});
