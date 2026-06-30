import request from "supertest";
import { app, dashboardStore } from "../src/index";

// `entity.too.large` (413) と並列の 400 JSON エラー応答の回帰テスト。
// 上流 pulseboard #107 と同じく、構文不正な JSON は 400 + JSON エラーで返す。
// 既定の 500 ハンドラに落ちると "Internal server error" となり、SRE の
// 5xx アラートが誤発火するため、専用の SyntaxError ハンドラで捕まえている。
describe("Malformed JSON body", () => {
  beforeEach(() => {
    dashboardStore.length = 0;
  });

  it("returns 400 with JSON error on invalid JSON to POST /api/v1/dashboard/metrics", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send("{not-valid-json");
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("invalid JSON body");
    // store にも残らない（パース失敗で route handler に到達しない）
    expect(dashboardStore).toHaveLength(0);
  });

  it("returns 400 with JSON error on truncated JSON object", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send('{"name":"cpu","value":');
    expect(res.status).toBe(400);
    expect(res.headers["content-type"]).toMatch(/application\/json/);
    expect(res.body.error).toBe("invalid JSON body");
    expect(dashboardStore).toHaveLength(0);
  });

  it("returns 400 with JSON error on completely non-JSON body with JSON content-type", async () => {
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .set("Content-Type", "application/json")
      .send("not json at all");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("invalid JSON body");
    expect(dashboardStore).toHaveLength(0);
  });
});
