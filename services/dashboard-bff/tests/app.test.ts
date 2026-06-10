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
  percentile,
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

describe("GET /api/v1/dashboard/metrics/:name/latest", () => {
  it("returns the most recent metric for a name", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 20 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 30 });
    // 別名のメトリクスは末尾後に投入されても影響しないこと（直近の cpu=30 を返す）
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 1024 });

    const res = await request(app).get("/api/v1/dashboard/metrics/cpu/latest");
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("cpu");
    expect(res.body.value).toBe(30);
    expect(res.body.recorded_at).toBeDefined();
  });

  it("preserves tags on the returned metric", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 50, tags: { host: "web-1", env: "prod" } });

    const res = await request(app).get("/api/v1/dashboard/metrics/cpu/latest");
    expect(res.status).toBe(200);
    expect(res.body.value).toBe(50);
    expect(res.body.tags).toEqual({ host: "web-1", env: "prod" });
  });

  it("returns 404 for unknown metric", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/unknown/latest",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("unknown");
  });

  it("returns 404 when other names exist but the requested one does not", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "mem", value: 1 });
    const res = await request(app).get("/api/v1/dashboard/metrics/cpu/latest");
    expect(res.status).toBe(404);
  });

  it("does not collide with the /:name list route", async () => {
    // 名前が "latest" のメトリクスを登録しても、/:name/latest は単一最新値を返し、
    // /:name は一覧を返す（経路が衝突しないことの確認）。
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "latest", value: 1 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "latest", value: 2 });

    const latestRes = await request(app).get(
      "/api/v1/dashboard/metrics/latest/latest",
    );
    expect(latestRes.status).toBe(200);
    expect(latestRes.body.name).toBe("latest");
    expect(latestRes.body.value).toBe(2);
    // /latest 単発は配列 (metrics) ではなく単一の DashboardMetric を返すこと
    expect(latestRes.body.metrics).toBeUndefined();
    expect(latestRes.body.total).toBeUndefined();

    const listRes = await request(app).get("/api/v1/dashboard/metrics/latest");
    expect(listRes.status).toBe(200);
    expect(Array.isArray(listRes.body.metrics)).toBe(true);
    expect(listRes.body.metrics).toHaveLength(2);
    expect(listRes.body.name).toBe("latest");
  });

  it("does not collide with the /:name/stats route", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 42 });

    const statsRes = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats",
    );
    expect(statsRes.status).toBe(200);
    // /stats は集計フィールドを持ち、value は最上位に存在しない
    expect(statsRes.body.count).toBe(1);
    expect(statsRes.body.value).toBeUndefined();

    const latestRes = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest",
    );
    expect(latestRes.status).toBe(200);
    // /latest は DashboardMetric 形状（value + recorded_at）で count を持たない
    expect(latestRes.body.value).toBe(42);
    expect(latestRes.body.count).toBeUndefined();
  });

  // ---- since/until フィルタ ----

  it("returns the latest metric inside the since/until window", async () => {
    // dashboardStore に直接 push して recorded_at をテスト時刻で固定する
    // （POST 経由だと new Date() が走り、ピンポイントの境界テストが書けない）
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
      { name: "cpu", value: 20, recorded_at: "2025-01-02T00:00:00.000Z" },
      { name: "cpu", value: 30, recorded_at: "2025-01-03T00:00:00.000Z" },
    );
    // 2025-01-01 ～ 2025-01-02 の窓 → 末尾は value=20
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest" +
        "?since=2025-01-01T00:00:00.000Z&until=2025-01-02T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toBe(20);
    expect(res.body.recorded_at).toBe("2025-01-02T00:00:00.000Z");
  });

  it("respects since boundary as inclusive", async () => {
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
      { name: "cpu", value: 20, recorded_at: "2025-01-02T00:00:00.000Z" },
    );
    // since が 2025-01-02 ピッタリなら value=20 のみが対象
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest?since=2025-01-02T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toBe(20);
  });

  it("respects until boundary as inclusive", async () => {
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
      { name: "cpu", value: 20, recorded_at: "2025-01-02T00:00:00.000Z" },
    );
    // until が 2025-01-01 ピッタリなら value=10 のみが対象
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest?until=2025-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.value).toBe(10);
  });

  it("returns 404 with in-window message when the name exists but no metric is in window", async () => {
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
    );
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest?since=2026-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("in the given window");
  });

  it("returns 404 without in-window suffix when the name itself does not exist", async () => {
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
    );
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/unknown/latest?since=2025-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).not.toContain("in the given window");
  });

  it("returns 400 when since > until", async () => {
    dashboardStore.push(
      { name: "cpu", value: 10, recorded_at: "2025-01-01T00:00:00.000Z" },
    );
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest" +
        "?since=2025-01-02T00:00:00.000Z&until=2025-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("since must be less than or equal to until");
  });

  it("returns 400 for invalid since", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest?since=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("since");
  });

  it("returns 400 for invalid until", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/latest?until=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("until");
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

  it("computes p50/p95/p99 over sorted values", () => {
    const ts = new Date().toISOString();
    // 1〜100 の連続値、rank=pct/100*(n-1)=pct/100*99 で線形補間。
    // p50: rank=49.5, sorted[49]=50, sorted[50]=51 → 50.5
    // p95: rank=94.05, sorted[94]=95, sorted[95]=96 → 95*0.95+96*0.05=95.05
    // p99: rank=98.01, sorted[98]=99, sorted[99]=100 → 99*0.99+100*0.01=99.01
    const metrics = Array.from({ length: 100 }, (_, i) => ({
      name: "cpu",
      value: i + 1,
      recorded_at: ts,
    }));
    const stats = computeStats("cpu", metrics);
    expect(stats.count).toBe(100);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    expect(stats.p50).toBeCloseTo(50.5, 4);
    expect(stats.p95).toBeCloseTo(95.05, 4);
    expect(stats.p99).toBeCloseTo(99.01, 4);
  });

  it("p50/p95/p99 equal the only value for a single record", () => {
    const ts = new Date().toISOString();
    const stats = computeStats("solo", [
      { name: "solo", value: 42, recorded_at: ts },
    ]);
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.p99).toBe(42);
  });

  it("computes percentiles correctly even when the input is unsorted", () => {
    const ts = new Date().toISOString();
    // POST 順は時系列順だが、value 自体は降順で入る想定
    const stats = computeStats("cpu", [
      { name: "cpu", value: 100, recorded_at: ts },
      { name: "cpu", value: 50, recorded_at: ts },
      { name: "cpu", value: 1, recorded_at: ts },
    ]);
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(100);
    // sorted=[1,50,100], rank(0.5*2)=1 → p50=50
    expect(stats.p50).toBe(50);
  });
});

describe("percentile helper", () => {
  it("returns 0 for empty input", () => {
    expect(percentile([], 50)).toBe(0);
    expect(percentile([], 99)).toBe(0);
  });

  it("returns the only element for single-value input", () => {
    expect(percentile([7], 50)).toBe(7);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([7], 99)).toBe(7);
  });

  it("returns min/max for pct=0/100", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });

  it("linearly interpolates between neighbors", () => {
    // sorted=[10,20,30,40], rank=0.5*3=1.5 → 20*0.5 + 30*0.5 = 25
    expect(percentile([10, 20, 30, 40], 50)).toBe(25);
  });
});

describe("GET /api/v1/dashboard/metrics/:name/stats — with since/until", () => {
  it("accepts since/until in the response window", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats?since=2000-01-01T00:00:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
  });

  it("rejects invalid since", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats?since=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("since");
  });

  it("rejects invalid until", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats?until=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("until");
  });

  it("rejects since > until", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats?since=2030-01-01T00:00:00Z&until=2020-01-01T00:00:00Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("since must be less than or equal to until");
  });

  it("returns 404 when window excludes all records", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 10 });
    // recorded_at は now 付近。`until` を遠い過去にして 0 件にする。
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/stats?until=2000-01-01T00:00:00Z",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("in the given window");
  });

  it("includes p50/p95/p99 in the response payload", async () => {
    for (const v of [10, 20, 30, 40, 50]) {
      await request(app)
        .post("/api/v1/dashboard/metrics")
        .send({ name: "cpu", value: v });
    }
    const res = await request(app).get("/api/v1/dashboard/metrics/cpu/stats");
    expect(res.status).toBe(200);
    expect(res.body.p50).toBeDefined();
    expect(res.body.p95).toBeDefined();
    expect(res.body.p99).toBeDefined();
    expect(typeof res.body.p50).toBe("number");
  });

  it("filters records by since (after newer values are recorded)", async () => {
    // 1 件記録 → 短い sleep → さらに 1 件記録。`since` を「2件目の前」に設定。
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 100 });
    await new Promise((r) => setTimeout(r, 50));
    const midpoint = new Date().toISOString();
    await new Promise((r) => setTimeout(r, 50));
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 200 });
    const res = await request(app).get(
      `/api/v1/dashboard/metrics/cpu/stats?since=${encodeURIComponent(midpoint)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.latest).toBe(200);
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

describe("DELETE /api/v1/dashboard/metrics/:name — with since/until", () => {
  function seedAt(name: string, value: number, recordedAt: string): void {
    dashboardStore.push({ name, value, recorded_at: recordedAt });
  }

  it("only deletes records whose recorded_at falls within [since, until]", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");
    seedAt("cpu", 2, "2024-06-01T00:00:00.000Z");
    seedAt("cpu", 3, "2024-12-01T00:00:00.000Z");
    seedAt("mem", 99, "2024-06-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?since=2024-03-01T00:00:00.000Z&until=2024-09-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.name).toBe("cpu");
    expect(res.body.since).toBe("2024-03-01T00:00:00.000Z");
    expect(res.body.until).toBe("2024-09-01T00:00:00.000Z");

    // value=2 のみが消え、1 と 3 と mem は残る
    const remaining = dashboardStore.map((m) => `${m.name}:${m.value}`).sort();
    expect(remaining).toEqual(["cpu:1", "cpu:3", "mem:99"]);
  });

  it("supports since-only filter (delete everything newer than the cutoff)", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");
    seedAt("cpu", 2, "2024-12-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?since=2024-06-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.since).toBe("2024-06-01T00:00:00.000Z");
    expect(res.body.until).toBeUndefined();
    expect(dashboardStore).toHaveLength(1);
    expect(dashboardStore[0].value).toBe(1);
  });

  it("supports until-only filter (purge older-than-cutoff records)", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");
    seedAt("cpu", 2, "2024-12-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?until=2024-06-01T00:00:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(1);
    expect(res.body.until).toBe("2024-06-01T00:00:00.000Z");
    expect(res.body.since).toBeUndefined();
    expect(dashboardStore).toHaveLength(1);
    expect(dashboardStore[0].value).toBe(2);
  });

  it("returns 404 with an in-window message when nothing matches the time range", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?since=2025-01-01T00:00:00.000Z",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/in the given window/i);
    // 既存レコードは温存される
    expect(dashboardStore).toHaveLength(1);
  });

  it("rejects invalid since with 400", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?since=not-a-date",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since/);
    expect(dashboardStore).toHaveLength(1);
  });

  it("rejects since > until with 400", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");

    const res = await request(app).delete(
      "/api/v1/dashboard/metrics/cpu?since=2024-06-01T00:00:00.000Z&until=2024-03-01T00:00:00.000Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since.*less than or equal to until/);
    expect(dashboardStore).toHaveLength(1);
  });

  it("preserves legacy behavior when no time filter is given (delete all matches)", async () => {
    seedAt("cpu", 1, "2024-01-01T00:00:00.000Z");
    seedAt("cpu", 2, "2024-12-01T00:00:00.000Z");
    seedAt("mem", 9, "2024-06-01T00:00:00.000Z");

    const res = await request(app).delete("/api/v1/dashboard/metrics/cpu");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(2);
    expect(res.body.since).toBeUndefined();
    expect(res.body.until).toBeUndefined();
    expect(dashboardStore).toHaveLength(1);
    expect(dashboardStore[0].name).toBe("mem");
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

describe("GET /api/v1/dashboard/metrics/names", () => {
  it("returns empty list when store is empty", async () => {
    const res = await request(app).get("/api/v1/dashboard/metrics/names");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ names: [], count: 0 });
  });

  it("lists distinct names sorted ascending with counts", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "memory", value: 1 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 50 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "cpu", value: 60 });
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "disk", value: 10 });

    const res = await request(app).get("/api/v1/dashboard/metrics/names");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(3);
    expect(res.body.names.map((n: { name: string }) => n.name)).toEqual([
      "cpu",
      "disk",
      "memory",
    ]);
    const cpu = res.body.names.find((n: { name: string }) => n.name === "cpu");
    expect(cpu.count).toBe(2);
    expect(cpu.latest_recorded_at).toBeDefined();
  });

  it("latest_recorded_at reflects the most recent record for that name", async () => {
    // 異なる recorded_at の 2 件を時間順にストアへ直接挿入する
    dashboardStore.push({
      name: "cpu",
      value: 10,
      recorded_at: "2026-01-01T00:00:00.000Z",
    });
    dashboardStore.push({
      name: "cpu",
      value: 20,
      recorded_at: "2026-06-01T12:00:00.000Z",
    });
    dashboardStore.push({
      name: "cpu",
      value: 30,
      recorded_at: "2026-03-01T00:00:00.000Z",
    });

    const res = await request(app).get("/api/v1/dashboard/metrics/names");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.names[0].name).toBe("cpu");
    expect(res.body.names[0].count).toBe(3);
    // 6 月のレコードが最新
    expect(res.body.names[0].latest_recorded_at).toBe(
      "2026-06-01T12:00:00.000Z",
    );
  });

  it("handles a single record", async () => {
    await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({ name: "only", value: 1 });
    const res = await request(app).get("/api/v1/dashboard/metrics/names");
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(1);
    expect(res.body.names[0].name).toBe("only");
    expect(res.body.names[0].count).toBe(1);
  });
});

describe("GET /api/v1/dashboard/metrics/:name/timeseries", () => {
  // recorded_at は POST 時にサーバ側で `new Date().toISOString()` がセットされる。
  // バケット境界の検証には固定タイムスタンプが必要なため、テスト中はストアに直接 push する。
  // src/index.ts が export している `dashboardStore` を直接操作することで、
  // 既存テスト（POST → GET 経由）と同じ in-memory store にバイパス挿入できる。
  function seed(name: string, value: number, isoTs: string) {
    dashboardStore.push({ name, value, recorded_at: isoTs });
  }

  it("returns 404 when the metric name does not exist", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/missing/timeseries",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("No metrics found for 'missing'");
  });

  it("returns 404 when no records fall within the since/until window", async () => {
    seed("cpu", 10, "2026-01-01T00:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?since=2027-01-01T00:00:00Z",
    );
    expect(res.status).toBe(404);
    expect(res.body.error).toContain("in the given window");
  });

  it("buckets records by the default 60s width and returns aggregates", async () => {
    // [12:00:10, 12:00:30, 12:00:50] → bucket_start 12:00:00
    // [12:01:30, 12:01:45] → bucket_start 12:01:00
    seed("cpu", 10, "2026-06-01T12:00:10.000Z");
    seed("cpu", 30, "2026-06-01T12:00:30.000Z");
    seed("cpu", 50, "2026-06-01T12:00:50.000Z");
    seed("cpu", 70, "2026-06-01T12:01:30.000Z");
    seed("cpu", 90, "2026-06-01T12:01:45.000Z");

    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries",
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("cpu");
    expect(res.body.bucket_seconds).toBe(60);
    expect(res.body.count).toBe(2);

    const b0 = res.body.buckets[0];
    expect(b0.bucket_start).toBe("2026-06-01T12:00:00.000Z");
    expect(b0.total).toBe(3);
    expect(b0.min).toBe(10);
    expect(b0.max).toBe(50);
    expect(b0.avg).toBe(30);
    expect(b0.p50).toBe(30);

    const b1 = res.body.buckets[1];
    expect(b1.bucket_start).toBe("2026-06-01T12:01:00.000Z");
    expect(b1.total).toBe(2);
    expect(b1.min).toBe(70);
    expect(b1.max).toBe(90);
    expect(b1.avg).toBe(80);
  });

  it("returns buckets sorted by bucket_start ascending even if records arrive out of order", async () => {
    seed("cpu", 1, "2026-06-01T12:02:00.000Z");
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    seed("cpu", 1, "2026-06-01T12:01:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries",
    );
    expect(res.status).toBe(200);
    const starts = res.body.buckets.map(
      (b: { bucket_start: string }) => b.bucket_start,
    );
    expect(starts).toEqual([
      "2026-06-01T12:00:00.000Z",
      "2026-06-01T12:01:00.000Z",
      "2026-06-01T12:02:00.000Z",
    ]);
  });

  it("skips empty buckets (sparse representation)", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    seed("cpu", 1, "2026-06-01T12:10:00.000Z"); // 10 分後
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries",
    );
    expect(res.status).toBe(200);
    // 観測のあるバケットだけ返る (12:00 と 12:10 の 2 つ)
    expect(res.body.count).toBe(2);
  });

  it("uses a custom bucket_seconds value", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    seed("cpu", 1, "2026-06-01T12:00:09.000Z"); // 10 秒バケット A
    seed("cpu", 1, "2026-06-01T12:00:10.000Z"); // 10 秒バケット B
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?bucket_seconds=10",
    );
    expect(res.status).toBe(200);
    expect(res.body.bucket_seconds).toBe(10);
    expect(res.body.count).toBe(2);
    expect(res.body.buckets[0].total).toBe(2);
    expect(res.body.buckets[1].total).toBe(1);
  });

  it("computes percentiles per bucket using linear interpolation", async () => {
    // 単一バケットに [10, 20, 30, 40, 50] → p50=30, p95=48, p99=49.6
    // analytics-api timeseries の percentile と同実装の回帰
    const base = "2026-06-01T12:00:00.000Z";
    seed("svc", 10, base);
    seed("svc", 20, "2026-06-01T12:00:10.000Z");
    seed("svc", 30, "2026-06-01T12:00:20.000Z");
    seed("svc", 40, "2026-06-01T12:00:30.000Z");
    seed("svc", 50, "2026-06-01T12:00:40.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/svc/timeseries",
    );
    const b = res.body.buckets[0];
    expect(b.total).toBe(5);
    expect(b.min).toBe(10);
    expect(b.max).toBe(50);
    expect(b.p50).toBe(30);
    expect(b.p95).toBeCloseTo(48, 5);
    expect(b.p99).toBeCloseTo(49.6, 5);
  });

  it("filters by since (inclusive)", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    seed("cpu", 1, "2026-06-01T12:05:00.000Z");
    seed("cpu", 1, "2026-06-01T12:10:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?since=2026-06-01T12:05:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("filters by until (inclusive)", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    seed("cpu", 1, "2026-06-01T12:05:00.000Z");
    seed("cpu", 1, "2026-06-01T12:10:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?until=2026-06-01T12:05:00Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.count).toBe(2);
  });

  it("rejects bucket_seconds < 1", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?bucket_seconds=0",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bucket_seconds");
  });

  it("rejects bucket_seconds > 86400", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?bucket_seconds=86401",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("bucket_seconds");
  });

  it("rejects non-integer bucket_seconds", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?bucket_seconds=1.5",
    );
    expect(res.status).toBe(400);
  });

  it("rejects negative bucket_seconds", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?bucket_seconds=-60",
    );
    expect(res.status).toBe(400);
  });

  it("rejects since > until", async () => {
    seed("cpu", 1, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries?since=2026-06-02T00:00:00Z&until=2026-06-01T00:00:00Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("since must be less than or equal to until");
  });

  it("ignores records of other metric names", async () => {
    seed("cpu", 10, "2026-06-01T12:00:00.000Z");
    seed("mem", 999, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/cpu/timeseries",
    );
    expect(res.status).toBe(200);
    expect(res.body.buckets[0].total).toBe(1);
    expect(res.body.buckets[0].min).toBe(10);
    expect(res.body.buckets[0].max).toBe(10);
  });

  it("does not collide with /:name route (timeseries word in URL is treated as a subroute)", async () => {
    // `/:name/timeseries` の登録順により、`timeseries` という名前のメトリクスを
    // 投入しても catch-all `/:name` ではなく timeseries エンドポイントに到達する。
    // POST 経由だと recorded_at が今の時刻になりウィンドウ判定が不安定なため、
    // ストアに直接挿入。`/:name/timeseries` ルートは "timeseries" を URL の
    // 最終セグメントとして扱うため、メトリクス名 "timeseries" でもエラーにはならず
    // バケット集計が返る点を確認する。
    seed("timeseries", 5, "2026-06-01T12:00:00.000Z");
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/timeseries/timeseries",
    );
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("timeseries");
    expect(res.body.buckets[0].total).toBe(1);
  });
});

describe("GET /api/v1/dashboard/metrics/count", () => {
  it("returns zero counts on empty store", async () => {
    const res = await request(app).get("/api/v1/dashboard/metrics/count");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(0);
    expect(res.body.by_name).toEqual({});
    expect(res.body.name).toBeNull();
    expect(res.body.since).toBeNull();
    expect(res.body.until).toBeNull();
  });

  it("aggregates total and by_name across distinct names", async () => {
    dashboardStore.push(
      { name: "cpu", value: 1, recorded_at: "2026-06-01T00:00:00.000Z" },
      { name: "cpu", value: 2, recorded_at: "2026-06-01T00:01:00.000Z" },
      { name: "mem", value: 3, recorded_at: "2026-06-01T00:02:00.000Z" },
    );
    const res = await request(app).get("/api/v1/dashboard/metrics/count");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.by_name).toEqual({ cpu: 2, mem: 1 });
    // 名前は決定論的にソートされる
    expect(Object.keys(res.body.by_name)).toEqual(["cpu", "mem"]);
  });

  it("filters by name exactly (no partial match)", async () => {
    dashboardStore.push(
      { name: "cpu", value: 1, recorded_at: "2026-06-01T00:00:00.000Z" },
      { name: "cpu-extra", value: 2, recorded_at: "2026-06-01T00:00:00.000Z" },
    );
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?name=cpu",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.name).toBe("cpu");
    expect(res.body.by_name).toEqual({ cpu: 1 });
  });

  it("filters by since/until window", async () => {
    dashboardStore.push(
      { name: "cpu", value: 1, recorded_at: "2026-06-01T00:00:00.000Z" },
      { name: "cpu", value: 2, recorded_at: "2026-06-01T01:00:00.000Z" },
      { name: "cpu", value: 3, recorded_at: "2026-06-01T02:00:00.000Z" },
    );
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?since=2026-06-01T00:30:00.000Z&until=2026-06-01T01:30:00.000Z",
    );
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.by_name).toEqual({ cpu: 1 });
    expect(res.body.since).toBe("2026-06-01T00:30:00.000Z");
    expect(res.body.until).toBe("2026-06-01T01:30:00.000Z");
  });

  it("returns 400 on invalid since", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?since=not-a-date",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid until", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?until=garbage",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 when since > until", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?since=2026-06-02T00:00:00.000Z&until=2026-06-01T00:00:00.000Z",
    );
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/since must be less than or equal to until/);
  });

  it("returns 400 on blank name", async () => {
    const res = await request(app).get(
      "/api/v1/dashboard/metrics/count?name=",
    );
    expect(res.status).toBe(400);
  });

  it("returns 400 on overlong name", async () => {
    const longName = "x".repeat(MAX_METRIC_NAME_LENGTH + 1);
    const res = await request(app).get(
      `/api/v1/dashboard/metrics/count?name=${longName}`,
    );
    expect(res.status).toBe(400);
  });

  it("does not collide with /:name route (count is treated as static)", async () => {
    // /:name の前に登録しているため、メトリクス名 "count" の詳細を取りたい場合は
    // /:name 側にマッチしないが、テストとしては count エンドポイントが優先される
    // ことを明示する（衝突しない）。
    dashboardStore.push({
      name: "count",
      value: 1,
      recorded_at: "2026-06-01T00:00:00.000Z",
    });
    const res = await request(app).get("/api/v1/dashboard/metrics/count");
    expect(res.status).toBe(200);
    // count エンドポイントなので by_name に "count" が含まれる
    expect(res.body.by_name).toEqual({ count: 1 });
    expect(res.body.total).toBe(1);
  });

  it("skips records with unparseable recorded_at when a time filter is given", async () => {
    dashboardStore.push(
      { name: "cpu", value: 1, recorded_at: "2026-06-01T00:00:00.000Z" },
      { name: "cpu", value: 2, recorded_at: "not-an-iso-string" },
    );
    const filtered = await request(app).get(
      "/api/v1/dashboard/metrics/count?since=2025-01-01T00:00:00.000Z",
    );
    expect(filtered.status).toBe(200);
    // 時間フィルタありの場合、パース不能 recorded_at は除外される
    expect(filtered.body.total).toBe(1);

    const unfiltered = await request(app).get(
      "/api/v1/dashboard/metrics/count",
    );
    expect(unfiltered.status).toBe(200);
    // 時間フィルタなしの場合は両方カウント
    expect(unfiltered.body.total).toBe(2);
  });
});
