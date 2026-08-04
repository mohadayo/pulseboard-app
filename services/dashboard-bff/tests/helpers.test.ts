import {
  parseOffsetParam,
  parseBucketSecondsParam,
  parseIsoDateTime,
  filterByRecordedAt,
  bucketByTime,
  validateTags,
  TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH,
  TAG_MAX_KEYS,
} from "../src/index";

// このファイルは `src/index.ts` から export されている純粋ヘルパー関数の
// 直接ユニットテスト。endpoint 経由の統合テスト (`app.test.ts`) では
// 網羅しきれない境界値・型防御・退化ケースをヘルパー単位でロックダウンする。
// プロダクションコードには一切変更を加えていない。

describe("parseOffsetParam", () => {
  it("returns 0 when undefined (default)", () => {
    expect(parseOffsetParam(undefined)).toBe(0);
  });

  it("returns null for empty string", () => {
    expect(parseOffsetParam("")).toBeNull();
  });

  it("accepts zero", () => {
    // parseSummaryLimit は 1 以上のみだが offset は 0 も有効値。
    expect(parseOffsetParam("0")).toBe(0);
  });

  it("parses positive integer string", () => {
    expect(parseOffsetParam("42")).toBe(42);
  });

  it("rejects negative integer string", () => {
    expect(parseOffsetParam("-1")).toBeNull();
  });

  it("rejects decimal string", () => {
    expect(parseOffsetParam("1.5")).toBeNull();
  });

  it("rejects non-numeric string", () => {
    expect(parseOffsetParam("abc")).toBeNull();
  });

  it("rejects leading whitespace (strict integer regex)", () => {
    expect(parseOffsetParam(" 10")).toBeNull();
  });

  it("rejects array input (defensive against qs parsed queries)", () => {
    expect(parseOffsetParam(["10"])).toBeNull();
  });

  it("rejects plain object input", () => {
    expect(parseOffsetParam({ v: "10" })).toBeNull();
  });

  it("accepts large positive integer", () => {
    expect(parseOffsetParam("100000")).toBe(100000);
  });
});

describe("parseBucketSecondsParam", () => {
  it("returns 60 (default) when undefined", () => {
    expect(parseBucketSecondsParam(undefined)).toBe(60);
  });

  it("returns null for empty string", () => {
    expect(parseBucketSecondsParam("")).toBeNull();
  });

  it("accepts lower boundary 1", () => {
    expect(parseBucketSecondsParam("1")).toBe(1);
  });

  it("accepts upper boundary 86400 (1 day)", () => {
    expect(parseBucketSecondsParam("86400")).toBe(86400);
  });

  it("rejects 0", () => {
    expect(parseBucketSecondsParam("0")).toBeNull();
  });

  it("rejects negative integer", () => {
    expect(parseBucketSecondsParam("-1")).toBeNull();
  });

  it("rejects above upper boundary (86401)", () => {
    expect(parseBucketSecondsParam("86401")).toBeNull();
  });

  it("rejects decimal string", () => {
    expect(parseBucketSecondsParam("1.5")).toBeNull();
  });

  it("rejects non-numeric string", () => {
    expect(parseBucketSecondsParam("abc")).toBeNull();
  });

  it("rejects array input", () => {
    expect(parseBucketSecondsParam(["60"])).toBeNull();
  });

  it("parses middle value", () => {
    expect(parseBucketSecondsParam("300")).toBe(300);
  });
});

describe("parseIsoDateTime", () => {
  it("returns {value:null,error:null} for undefined (default)", () => {
    const r = parseIsoDateTime(undefined, "since");
    expect(r.value).toBeNull();
    expect(r.error).toBeNull();
  });

  it("returns error for empty string", () => {
    const r = parseIsoDateTime("", "since");
    expect(r.value).toBeNull();
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("since");
    expect(r.error).toContain("non-empty");
  });

  it("returns error for non-string type (number)", () => {
    const r = parseIsoDateTime(1234567890, "until");
    expect(r.value).toBeNull();
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("until");
  });

  it("returns error for non-string type (object)", () => {
    const r = parseIsoDateTime({ x: 1 }, "since");
    expect(r.value).toBeNull();
    expect(r.error).not.toBeNull();
  });

  it("returns error for invalid ISO string", () => {
    const r = parseIsoDateTime("not-a-date", "since");
    expect(r.value).toBeNull();
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("since");
    expect(r.error).toContain("valid");
  });

  it("returns Date value for valid ISO8601 UTC", () => {
    const r = parseIsoDateTime("2026-06-01T00:00:00Z", "since");
    expect(r.error).toBeNull();
    expect(r.value).not.toBeNull();
    expect(r.value!.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("returns Date value for valid ISO8601 with offset", () => {
    const r = parseIsoDateTime("2026-06-01T09:00:00+09:00", "since");
    expect(r.error).toBeNull();
    expect(r.value).not.toBeNull();
    // +09:00 なので UTC では 00:00 になる。
    expect(r.value!.toISOString()).toBe("2026-06-01T00:00:00.000Z");
  });

  it("uses the provided name in the error message", () => {
    const r = parseIsoDateTime("bad", "until");
    expect(r.error).not.toBeNull();
    expect(r.error).toContain("until");
  });
});

describe("filterByRecordedAt", () => {
  const mkMetric = (name: string, value: number, recorded_at: string) => ({
    name,
    value,
    recorded_at,
  });
  const m1 = mkMetric("cpu", 10, "2026-01-01T00:00:00.000Z");
  const m2 = mkMetric("cpu", 20, "2026-01-02T00:00:00.000Z");
  const m3 = mkMetric("cpu", 30, "2026-01-03T00:00:00.000Z");
  const m4 = mkMetric("cpu", 40, "2026-01-04T00:00:00.000Z");

  it("returns the input unchanged when both since and until are null", () => {
    const input = [m1, m2, m3, m4];
    const out = filterByRecordedAt(input, null, null);
    expect(out).toEqual(input);
    // 参照同一性は保証しないが、要素順は保つ。
  });

  it("filters by since only (inclusive)", () => {
    const out = filterByRecordedAt(
      [m1, m2, m3, m4],
      new Date("2026-01-02T00:00:00.000Z"),
      null,
    );
    expect(out.map((m) => m.value)).toEqual([20, 30, 40]);
  });

  it("filters by until only (inclusive)", () => {
    const out = filterByRecordedAt(
      [m1, m2, m3, m4],
      null,
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(out.map((m) => m.value)).toEqual([10, 20, 30]);
  });

  it("filters by both since and until (inclusive on both boundaries)", () => {
    const out = filterByRecordedAt(
      [m1, m2, m3, m4],
      new Date("2026-01-02T00:00:00.000Z"),
      new Date("2026-01-03T00:00:00.000Z"),
    );
    expect(out.map((m) => m.value)).toEqual([20, 30]);
  });

  it("returns empty array when window excludes all records", () => {
    const out = filterByRecordedAt(
      [m1, m2, m3, m4],
      new Date("2030-01-01T00:00:00.000Z"),
      null,
    );
    expect(out).toEqual([]);
  });

  it("skips records with unparseable recorded_at under a time filter", () => {
    const bad = mkMetric("cpu", 99, "not-a-date");
    const out = filterByRecordedAt(
      [m1, bad, m3],
      new Date("2026-01-01T00:00:00.000Z"),
      null,
    );
    // bad は Date.parse で NaN になり、時間フィルタでは除外される。
    expect(out.map((m) => m.value)).toEqual([10, 30]);
  });

  it("keeps records with unparseable recorded_at when no time filter is applied", () => {
    const bad = mkMetric("cpu", 99, "not-a-date");
    const out = filterByRecordedAt([m1, bad, m3], null, null);
    // フィルタなしのショートサーキットで元配列を返すため bad も残る。
    expect(out.map((m) => m.value)).toEqual([10, 99, 30]);
  });

  it("handles empty input", () => {
    expect(filterByRecordedAt([], null, null)).toEqual([]);
    expect(
      filterByRecordedAt([], new Date("2026-01-01T00:00:00.000Z"), null),
    ).toEqual([]);
  });
});

describe("bucketByTime", () => {
  const mkMetric = (value: number, recorded_at: string) => ({
    name: "cpu",
    value,
    recorded_at,
  });

  it("returns an empty array for empty input", () => {
    expect(bucketByTime([], 60)).toEqual([]);
  });

  it("groups all records into a single bucket when they share a bucket window", () => {
    // 60 秒バケットで [00:00, 00:01) に 3 件を格納。
    const buckets = bucketByTime(
      [
        mkMetric(10, "2026-01-01T00:00:00.000Z"),
        mkMetric(20, "2026-01-01T00:00:30.000Z"),
        mkMetric(30, "2026-01-01T00:00:59.999Z"),
      ],
      60,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].bucket_start).toBe("2026-01-01T00:00:00.000Z");
    expect(buckets[0].total).toBe(3);
    expect(buckets[0].min).toBe(10);
    expect(buckets[0].max).toBe(30);
    expect(buckets[0].avg).toBe(20);
  });

  it("splits records into separate buckets and returns them sorted by bucket_start", () => {
    const buckets = bucketByTime(
      [
        // わざと逆順に並べても bucket_start 昇順で返るはず。
        mkMetric(20, "2026-01-01T00:02:00.000Z"),
        mkMetric(10, "2026-01-01T00:00:00.000Z"),
        mkMetric(30, "2026-01-01T00:04:00.000Z"),
      ],
      60,
    );
    expect(buckets.map((b) => b.bucket_start)).toEqual([
      "2026-01-01T00:00:00.000Z",
      "2026-01-01T00:02:00.000Z",
      "2026-01-01T00:04:00.000Z",
    ]);
    expect(buckets.map((b) => b.total)).toEqual([1, 1, 1]);
  });

  it("does not include buckets with no observations (sparse representation)", () => {
    // 00:00 と 00:05 の 2 バケットのみ返るはず。中間の 00:01〜00:04 は空。
    const buckets = bucketByTime(
      [
        mkMetric(1, "2026-01-01T00:00:00.000Z"),
        mkMetric(2, "2026-01-01T00:05:00.000Z"),
      ],
      60,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucket_start).toBe("2026-01-01T00:00:00.000Z");
    expect(buckets[1].bucket_start).toBe("2026-01-01T00:05:00.000Z");
  });

  it("skips records with unparseable recorded_at (safe-side behavior)", () => {
    const buckets = bucketByTime(
      [
        mkMetric(1, "2026-01-01T00:00:00.000Z"),
        mkMetric(999, "not-a-date"),
        mkMetric(2, "2026-01-01T00:00:30.000Z"),
      ],
      60,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].total).toBe(2);
    // 999 は集計から除外されるはず。
    expect(buckets[0].max).toBe(2);
  });

  it("computes p50/p95/p99 within a single bucket", () => {
    // 1 バケットに 5 件。p50=3, p95=4.8, p99=4.96 (線形補間、rank=(pct/100)*(n-1))。
    const buckets = bucketByTime(
      [1, 2, 3, 4, 5].map((v, i) =>
        mkMetric(v, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`),
      ),
      60,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].p50).toBe(3);
    expect(buckets[0].p95).toBeCloseTo(4.8, 10);
    expect(buckets[0].p99).toBeCloseTo(4.96, 10);
  });

  it("returns skewness=0 and kurtosis=0 for constant-value buckets (σ=0 defense)", () => {
    // 同一値のみの場合 std_dev=0 → skewness=0, kurtosis=0。
    const buckets = bucketByTime(
      [1, 2, 3].map((i) =>
        mkMetric(7, `2026-01-01T00:00:0${i}.000Z`),
      ),
      60,
    );
    expect(buckets).toHaveLength(1);
    expect(buckets[0].std_dev).toBe(0);
    expect(buckets[0].skewness).toBe(0);
    expect(buckets[0].kurtosis).toBe(0);
    expect(buckets[0].cv).toBe(0);
  });

  it("respects custom bucket_seconds granularity", () => {
    // 3600 秒バケット (1 時間) にすると 00:00 と 01:00 の 2 バケットに分かれる。
    const buckets = bucketByTime(
      [
        mkMetric(1, "2026-01-01T00:15:00.000Z"),
        mkMetric(2, "2026-01-01T00:45:00.000Z"),
        mkMetric(3, "2026-01-01T01:15:00.000Z"),
      ],
      3600,
    );
    expect(buckets).toHaveLength(2);
    expect(buckets[0].bucket_start).toBe("2026-01-01T00:00:00.000Z");
    expect(buckets[0].total).toBe(2);
    expect(buckets[1].bucket_start).toBe("2026-01-01T01:00:00.000Z");
    expect(buckets[1].total).toBe(1);
  });
});

describe("validateTags (additional cases)", () => {
  // 既存 `app.test.ts` の `describe("validateTags")` は undefined/null/空キーの
  // 3 ケースのみ。ここでは残りの失敗経路 5 種と正常系 2 種を追加する。

  it("accepts a plain object with multiple valid string→string entries", () => {
    const r = validateTags({ host: "srv-1", region: "ap-northeast-1" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({ host: "srv-1", region: "ap-northeast-1" });
    }
  });

  it("accepts an empty object (treated as no tags but still ok)", () => {
    const r = validateTags({});
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value).toEqual({});
    }
  });

  it("rejects an array (arrays are typeof 'object' but not allowed)", () => {
    const r = validateTags(["host", "srv-1"]);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("plain object");
    }
  });

  it("rejects a primitive (string)", () => {
    const r = validateTags("host=srv-1");
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("plain object");
    }
  });

  it("rejects a value with non-string type", () => {
    const r = validateTags({ host: 42 as unknown as string });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("host");
      expect(r.error).toContain("string");
    }
  });

  it("rejects when the number of keys exceeds TAG_MAX_KEYS", () => {
    const tooMany: Record<string, string> = {};
    for (let i = 0; i < TAG_MAX_KEYS + 1; i++) {
      tooMany[`k${i}`] = "v";
    }
    const r = validateTags(tooMany);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(String(TAG_MAX_KEYS));
    }
  });

  it("rejects when a key exceeds TAG_KEY_MAX_LENGTH", () => {
    const longKey = "a".repeat(TAG_KEY_MAX_LENGTH + 1);
    const r = validateTags({ [longKey]: "v" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(String(TAG_KEY_MAX_LENGTH));
    }
  });

  it("rejects when a value exceeds TAG_VALUE_MAX_LENGTH", () => {
    const longValue = "a".repeat(TAG_VALUE_MAX_LENGTH + 1);
    const r = validateTags({ host: longValue });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain(String(TAG_VALUE_MAX_LENGTH));
      expect(r.error).toContain("host");
    }
  });

  it("accepts a key of exactly TAG_KEY_MAX_LENGTH characters (boundary)", () => {
    const boundaryKey = "a".repeat(TAG_KEY_MAX_LENGTH);
    const r = validateTags({ [boundaryKey]: "v" });
    expect(r.ok).toBe(true);
  });

  it("accepts a value of exactly TAG_VALUE_MAX_LENGTH characters (boundary)", () => {
    const boundaryValue = "a".repeat(TAG_VALUE_MAX_LENGTH);
    const r = validateTags({ host: boundaryValue });
    expect(r.ok).toBe(true);
  });

  it("accepts exactly TAG_MAX_KEYS entries (boundary)", () => {
    const boundary: Record<string, string> = {};
    for (let i = 0; i < TAG_MAX_KEYS; i++) {
      boundary[`k${i}`] = "v";
    }
    const r = validateTags(boundary);
    expect(r.ok).toBe(true);
  });
});
