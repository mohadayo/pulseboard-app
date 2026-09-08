import {
  parseOffsetParam,
  parseBucketSecondsParam,
  parseIsoDateTime,
  parseSummaryLimit,
  filterByRecordedAt,
  bucketByTime,
  validateTags,
  percentile,
  computeStats,
  TAG_KEY_MAX_LENGTH,
  TAG_VALUE_MAX_LENGTH,
  TAG_MAX_KEYS,
  MAX_SUMMARY_LIMIT,
  DEFAULT_SUMMARY_LIMIT,
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

describe("percentile", () => {
  // 線形補間パーセンタイル。上流 api-gateway の `_percentile` と式を統一しており、
  // 空配列 / 単一要素のショートサーキットと rank = (pct/100)*(n-1) の分岐
  // （整数落ち / 補間）を境界値でロックダウンする。
  // ここでは endpoint 経由の `app.test.ts` と重複しない、退化ケースと
  // 補間計算の直接検証に絞る。

  it("returns 0 for an empty array", () => {
    expect(percentile([], 50)).toBe(0);
  });

  it("returns 0 for an empty array regardless of pct (0 / 100)", () => {
    expect(percentile([], 0)).toBe(0);
    expect(percentile([], 100)).toBe(0);
  });

  it("returns the sole value for a single-element array", () => {
    // 単一要素のショートサーキット: pct に関わらず sortedValues[0] を返す。
    expect(percentile([42], 0)).toBe(42);
    expect(percentile([42], 50)).toBe(42);
    expect(percentile([42], 99)).toBe(42);
  });

  it("returns the exact element when rank is an integer (5 elements, p50)", () => {
    // n=5, pct=50 → rank = 0.5 * 4 = 2.0 → sortedValues[2] = 3
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
  });

  it("returns the first element for pct=0 (rank=0)", () => {
    expect(percentile([1, 2, 3, 4, 5], 0)).toBe(1);
  });

  it("returns the last element for pct=100 (rank=n-1)", () => {
    expect(percentile([1, 2, 3, 4, 5], 100)).toBe(5);
  });

  it("interpolates linearly when rank is fractional (5 elements, p95)", () => {
    // n=5, pct=95 → rank = 0.95 * 4 = 3.8
    // lower=3, upper=4, weight=0.8 → 4*(1-0.8) + 5*0.8 = 0.8 + 4.0 = 4.8
    expect(percentile([1, 2, 3, 4, 5], 95)).toBeCloseTo(4.8, 10);
  });

  it("interpolates linearly when rank is fractional (5 elements, p99)", () => {
    // n=5, pct=99 → rank = 0.99 * 4 = 3.96
    // lower=3, upper=4, weight=0.96 → 4*0.04 + 5*0.96 = 0.16 + 4.80 = 4.96
    expect(percentile([1, 2, 3, 4, 5], 99)).toBeCloseTo(4.96, 10);
  });

  it("computes p50 as the midpoint for an even-length array (linear interp)", () => {
    // n=4, pct=50 → rank = 0.5 * 3 = 1.5
    // lower=1, upper=2, weight=0.5 → 2*0.5 + 3*0.5 = 2.5
    expect(percentile([1, 2, 3, 4], 50)).toBeCloseTo(2.5, 10);
  });

  it("returns constant value for a constant-valued input at any pct", () => {
    // 定数入力ではどの pct でも同じ値を返す（min == max）。
    expect(percentile([7, 7, 7, 7], 0)).toBe(7);
    expect(percentile([7, 7, 7, 7], 50)).toBe(7);
    expect(percentile([7, 7, 7, 7], 100)).toBe(7);
  });
});

describe("computeStats", () => {
  // `computeStats` は count / min / max / sum / avg / variance / std_dev / cv /
  // skewness / kurtosis / p50/p95/p99 / latest / latest_recorded_at /
  // first_recorded_at をまとめて返す。式は上流 api-gateway (Python) と
  // metrics-worker (Go) と統一しており、退化ケースの規約
  // (`count === 1` や定数入力で variance/std_dev/cv/skewness/kurtosis が 0)
  // を直接ロックダウンする。metrics は時系列順（POST 受理順）を前提とし、
  // `latest` は末尾、`first_recorded_at` は先頭の記録時刻を採用する。

  const mkMetric = (value: number, recorded_at: string) => ({
    name: "cpu",
    value,
    recorded_at,
  });

  it("handles a single observation (count=1 → variance/std_dev/cv/skewness/kurtosis all 0)", () => {
    const stats = computeStats("cpu", [mkMetric(42, "2026-01-01T00:00:00.000Z")]);
    expect(stats.name).toBe("cpu");
    expect(stats.count).toBe(1);
    expect(stats.min).toBe(42);
    expect(stats.max).toBe(42);
    expect(stats.sum).toBe(42);
    expect(stats.avg).toBe(42);
    // count=1 では差分が 0 で variance/std_dev も 0（ゼロ除算にはならない）。
    expect(stats.variance).toBe(0);
    expect(stats.std_dev).toBe(0);
    // std_dev=0 のとき cv/skewness/kurtosis は定義不能なので 0 を返す規約。
    expect(stats.cv).toBe(0);
    expect(stats.skewness).toBe(0);
    expect(stats.kurtosis).toBe(0);
    // p50/p95/p99 は単一要素なので全て同じ値。
    expect(stats.p50).toBe(42);
    expect(stats.p95).toBe(42);
    expect(stats.p99).toBe(42);
    expect(stats.latest).toBe(42);
    expect(stats.latest_recorded_at).toBe("2026-01-01T00:00:00.000Z");
    expect(stats.first_recorded_at).toBe("2026-01-01T00:00:00.000Z");
  });

  it("handles constant-value input (variance=0, cv=0, skewness=0, kurtosis=0)", () => {
    // 定数入力では variance/std_dev/cv/skewness/kurtosis が全て 0。
    // std_dev=0 の防御が cv/skewness/kurtosis で共通に効いていることを確認する。
    const stats = computeStats("cpu", [
      mkMetric(7, "2026-01-01T00:00:00.000Z"),
      mkMetric(7, "2026-01-01T00:00:01.000Z"),
      mkMetric(7, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(stats.count).toBe(3);
    expect(stats.min).toBe(7);
    expect(stats.max).toBe(7);
    expect(stats.sum).toBe(21);
    expect(stats.avg).toBe(7);
    expect(stats.variance).toBe(0);
    expect(stats.std_dev).toBe(0);
    expect(stats.cv).toBe(0);
    expect(stats.skewness).toBe(0);
    expect(stats.kurtosis).toBe(0);
    // 定数入力なので p50/p95/p99 も全て同じ値。
    expect(stats.p50).toBe(7);
    expect(stats.p95).toBe(7);
    expect(stats.p99).toBe(7);
  });

  it("computes standard case [10, 20, 30, 40, 50] correctly (avg=30, variance=200)", () => {
    // 手計算: avg=30, Σ(x-μ)²=(400+100+0+100+400)=1000, variance=1000/5=200
    // std_dev=√200≈14.1421356, cv=std_dev/|30|≈0.4714
    // 対称分布なので skewness=0、kurtosis は分布の尖りを反映する定数
    // (m4=(160000+10000+0+10000+160000)/5=68000, kurtosis=68000/40000=1.7)
    const metrics = [10, 20, 30, 40, 50].map((v, i) =>
      mkMetric(v, `2026-01-01T00:00:${String(i).padStart(2, "0")}.000Z`)
    );
    const stats = computeStats("cpu", metrics);
    expect(stats.count).toBe(5);
    expect(stats.min).toBe(10);
    expect(stats.max).toBe(50);
    expect(stats.sum).toBe(150);
    expect(stats.avg).toBe(30);
    expect(stats.variance).toBeCloseTo(200, 10);
    expect(stats.std_dev).toBeCloseTo(Math.sqrt(200), 10);
    expect(stats.cv).toBeCloseTo(Math.sqrt(200) / 30, 10);
    // 完全対称分布なので歪度は 0（浮動小数点誤差の範囲）。
    expect(stats.skewness).toBeCloseTo(0, 10);
    expect(stats.kurtosis).toBeCloseTo(1.7, 10);
    // 線形補間: rank = (95/100)*4 = 3.8 → 40*0.2 + 50*0.8 = 48
    expect(stats.p50).toBe(30);
    expect(stats.p95).toBeCloseTo(48, 10);
    expect(stats.p99).toBeCloseTo(49.6, 10);
  });

  it("uses head record for first_recorded_at and tail for latest / latest_recorded_at", () => {
    // metrics は POST 受理順を前提とするため、末尾が最新・先頭が最古。
    // ここでは意図的に「値の大小と時系列順序が一致しない」ケースを組んで、
    // latest が「値の最大」ではなく「時系列の末尾」を指すことを明確化する。
    const stats = computeStats("cpu", [
      mkMetric(99, "2026-01-01T00:00:00.000Z"), // 先頭・値は最大
      mkMetric(50, "2026-01-01T00:00:01.000Z"),
      mkMetric(1, "2026-01-01T00:00:02.000Z"), // 末尾・値は最小
    ]);
    expect(stats.first_recorded_at).toBe("2026-01-01T00:00:00.000Z");
    expect(stats.latest).toBe(1);
    expect(stats.latest_recorded_at).toBe("2026-01-01T00:00:02.000Z");
    // min/max は値ベースなので順序に依存しない。
    expect(stats.min).toBe(1);
    expect(stats.max).toBe(99);
  });

  it("handles negative values correctly (min/max/avg reflect sign)", () => {
    // 負値を含むケース。sum/avg は符号を保持し、min は最小の負値、max は最大の正値。
    const stats = computeStats("cpu", [
      mkMetric(-10, "2026-01-01T00:00:00.000Z"),
      mkMetric(0, "2026-01-01T00:00:01.000Z"),
      mkMetric(10, "2026-01-01T00:00:02.000Z"),
    ]);
    expect(stats.min).toBe(-10);
    expect(stats.max).toBe(10);
    expect(stats.sum).toBe(0);
    expect(stats.avg).toBe(0);
    // avg=0 なので cv は定義不能 → 0 を返す規約。
    expect(stats.cv).toBe(0);
    // 対称なので skewness=0。
    expect(stats.skewness).toBeCloseTo(0, 10);
  });
});

describe("parseSummaryLimit", () => {
  // `?limit=` のバリデーション。undefined は defaultLimit、それ以外は
  // 純粋な正の整数文字列 (1〜maxLimit) のみ受理。それ以外は null を返す
  // （呼び出し側が 400 を返す責務）。非文字列型（配列・オブジェクト）と
  // 上限境界を直接ロックダウンする。

  const DEFAULT = DEFAULT_SUMMARY_LIMIT; // 50
  const MAX = MAX_SUMMARY_LIMIT; // 500

  it("returns the default when input is undefined", () => {
    expect(parseSummaryLimit(undefined, DEFAULT, MAX)).toBe(DEFAULT);
  });

  it("returns null for empty string (defaultLimit does not apply)", () => {
    // undefined と "" は明確に区別する（後者は「渡されたが空」という不正入力）。
    expect(parseSummaryLimit("", DEFAULT, MAX)).toBeNull();
  });

  it("parses a positive integer string", () => {
    expect(parseSummaryLimit("10", DEFAULT, MAX)).toBe(10);
  });

  it("accepts the lower boundary 1", () => {
    expect(parseSummaryLimit("1", DEFAULT, MAX)).toBe(1);
  });

  it("accepts the upper boundary maxLimit", () => {
    expect(parseSummaryLimit(String(MAX), DEFAULT, MAX)).toBe(MAX);
  });

  it("rejects 0 (below lower boundary)", () => {
    expect(parseSummaryLimit("0", DEFAULT, MAX)).toBeNull();
  });

  it("rejects maxLimit + 1 (above upper boundary)", () => {
    expect(parseSummaryLimit(String(MAX + 1), DEFAULT, MAX)).toBeNull();
  });

  it("rejects negative integer strings", () => {
    // 正の整数のみ受理する厳格な正規表現なので "-1" は非マッチで null。
    expect(parseSummaryLimit("-1", DEFAULT, MAX)).toBeNull();
  });

  it("rejects decimal strings like '10.5'", () => {
    expect(parseSummaryLimit("10.5", DEFAULT, MAX)).toBeNull();
  });

  it("rejects non-numeric strings", () => {
    expect(parseSummaryLimit("abc", DEFAULT, MAX)).toBeNull();
  });

  it("rejects strings with leading whitespace (strict integer regex)", () => {
    expect(parseSummaryLimit(" 10", DEFAULT, MAX)).toBeNull();
  });

  it("rejects array input (defensive against qs parsed queries)", () => {
    // express の req.query は string | string[] | qs.ParsedQs 形式のため、
    // 配列やオブジェクトが渡り得る。単一スカラのみ受理する契約を守る。
    expect(parseSummaryLimit(["10"], DEFAULT, MAX)).toBeNull();
  });

  it("rejects plain object input", () => {
    expect(parseSummaryLimit({ v: "10" }, DEFAULT, MAX)).toBeNull();
  });

  it("respects a custom defaultLimit and maxLimit pair", () => {
    // 呼び出し側が別の default/max を渡すケース（将来別 endpoint で再利用しても
    // 引数越しにパラメータ化できることを確認）。
    expect(parseSummaryLimit(undefined, 10, 100)).toBe(10);
    expect(parseSummaryLimit("100", 10, 100)).toBe(100);
    expect(parseSummaryLimit("101", 10, 100)).toBeNull();
  });
});
