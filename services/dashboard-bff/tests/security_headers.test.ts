import request from "supertest";
import { app } from "../src";

/**
 * dashboard-bff の全応答に付与される最小限のセキュリティヘッダを回帰検証する。
 * - `X-Content-Type-Options: nosniff`（MIME sniffing 抑止）
 * - `X-Frame-Options: DENY`（clickjacking 抑止）
 * - `Referrer-Policy: no-referrer`（内部 URL / クエリの Referrer 漏洩抑止）
 * - `X-Powered-By` は露出しない（Express の版数情報を隠す）
 *
 * `/health` (200) と存在しないパス (404) の両方で同じ挙動を固定することで、
 * 「特定ルートだけ抜ける」リグレッションを検出する。
 */
describe("Security response headers", () => {
  it("adds nosniff / DENY / no-referrer and omits x-powered-by on /health (200)", async () => {
    const res = await request(app).get("/health");
    expect(res.status).toBe(200);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("adds the same headers to 404 responses (default handler)", async () => {
    const res = await request(app).get(
      "/definitely-not-a-real-endpoint-please",
    );
    expect(res.status).toBe(404);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("adds the same headers to a 400 (validation error) response", async () => {
    // POST /api/v1/dashboard/metrics は name/value 不足で 400 を返す。
    // エラー応答経路でもセキュリティヘッダが漏れなく付くことを確認する。
    const res = await request(app)
      .post("/api/v1/dashboard/metrics")
      .send({});
    expect(res.status).toBe(400);
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(res.headers["x-frame-options"]).toBe("DENY");
    expect(res.headers["referrer-policy"]).toBe("no-referrer");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });
});
