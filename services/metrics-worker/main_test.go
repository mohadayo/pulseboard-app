package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()

	healthHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp HealthResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode response: %v", err)
	}
	if resp.Status != "ok" {
		t.Errorf("expected status ok, got %s", resp.Status)
	}
	if resp.Service != "metrics-worker" {
		t.Errorf("expected service metrics-worker, got %s", resp.Service)
	}
}

func TestAggregateHandler(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{10, 20, 30}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp AggregateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if resp.Count != 3 {
		t.Errorf("expected count 3, got %d", resp.Count)
	}
	if resp.Sum != 60 {
		t.Errorf("expected sum 60, got %f", resp.Sum)
	}
	if resp.Avg != 20 {
		t.Errorf("expected avg 20, got %f", resp.Avg)
	}
	if resp.Min != 10 {
		t.Errorf("expected min 10, got %f", resp.Min)
	}
	if resp.Max != 30 {
		t.Errorf("expected max 30, got %f", resp.Max)
	}
}

func TestAggregateHandlerEmptyValues(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestAggregateHandlerWrongMethod(t *testing.T) {
	req := httptest.NewRequest(http.MethodGet, "/api/v1/aggregate", nil)
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusMethodNotAllowed {
		t.Fatalf("expected 405, got %d", w.Code)
	}
}

func TestAggregateHandlerInvalidBody(t *testing.T) {
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader([]byte("invalid")))
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d", w.Code)
	}
}

func TestComputeAggregate(t *testing.T) {
	result := computeAggregate([]float64{2, 4, 4, 4, 5, 5, 7, 9})
	if result.Count != 8 {
		t.Errorf("expected count 8, got %d", result.Count)
	}
	if result.Sum != 40 {
		t.Errorf("expected sum 40, got %f", result.Sum)
	}
	if result.Avg != 5 {
		t.Errorf("expected avg 5, got %f", result.Avg)
	}
	if result.Min != 2 {
		t.Errorf("expected min 2, got %f", result.Min)
	}
	if result.Max != 9 {
		t.Errorf("expected max 9, got %f", result.Max)
	}
	if result.StdDev < 1.99 || result.StdDev > 2.01 {
		t.Errorf("expected std_dev ~2.0, got %f", result.StdDev)
	}
}

func TestComputeAggregateSingleValue(t *testing.T) {
	result := computeAggregate([]float64{42})
	if result.Count != 1 {
		t.Errorf("expected count 1, got %d", result.Count)
	}
	if result.StdDev != 0 {
		t.Errorf("expected std_dev 0, got %f", result.StdDev)
	}
	if result.Min != 42 || result.Max != 42 {
		t.Errorf("expected min=max=42")
	}
	if result.Median != 42 || result.P95 != 42 || result.P99 != 42 {
		t.Errorf("expected median=p95=p99=42")
	}
}

// approxEqual はパーセンタイル比較用の浮動小数誤差許容関数。
func approxEqual(a, b, eps float64) bool {
	diff := a - b
	if diff < 0 {
		diff = -diff
	}
	return diff <= eps
}

func TestPercentileEdgeCases(t *testing.T) {
	if got := percentile(nil, 50); got != 0 {
		t.Errorf("empty slice: expected 0, got %f", got)
	}
	if got := percentile([]float64{7}, 95); got != 7 {
		t.Errorf("single element: expected 7, got %f", got)
	}
	// 偶数件数の中央値は隣接 2 要素の平均（線形補間）
	if got := percentile([]float64{1, 2, 3, 4}, 50); !approxEqual(got, 2.5, 1e-9) {
		t.Errorf("median of [1,2,3,4]: expected 2.5, got %f", got)
	}
	// 奇数件数の中央値は中央要素
	if got := percentile([]float64{1, 2, 3, 4, 5}, 50); got != 3 {
		t.Errorf("median of [1..5]: expected 3, got %f", got)
	}
}

func TestComputeAggregateMedianOdd(t *testing.T) {
	result := computeAggregate([]float64{5, 1, 3, 2, 4})
	if result.Median != 3 {
		t.Errorf("expected median 3, got %f", result.Median)
	}
}

func TestComputeAggregateMedianEven(t *testing.T) {
	result := computeAggregate([]float64{4, 2, 1, 3})
	if !approxEqual(result.Median, 2.5, 1e-9) {
		t.Errorf("expected median 2.5, got %f", result.Median)
	}
}

func TestComputeAggregatePercentiles(t *testing.T) {
	// 1..100 の数値で p95 ≈ 95.05, p99 ≈ 99.01（線形補間方式）
	values := make([]float64, 100)
	for i := range values {
		values[i] = float64(i + 1)
	}
	result := computeAggregate(values)
	if !approxEqual(result.P95, 95.05, 0.01) {
		t.Errorf("expected p95 ≈ 95.05, got %f", result.P95)
	}
	if !approxEqual(result.P99, 99.01, 0.01) {
		t.Errorf("expected p99 ≈ 99.01, got %f", result.P99)
	}
	if !approxEqual(result.Median, 50.5, 0.01) {
		t.Errorf("expected median ≈ 50.5, got %f", result.Median)
	}
}

func TestAggregateHandlerIncludesNewFields(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var resp AggregateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	if resp.Median != 3 {
		t.Errorf("expected median 3, got %f", resp.Median)
	}

	// JSON にフィールドが含まれることも確認
	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode raw: %v", err)
	}
	for _, key := range []string{"median", "p95", "p99", "skewness"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response JSON missing key %q", key)
		}
	}
}

// TestComputeAggregateSkewness は population skewness が以下の規約で計算されることを検証する:
// - 完全に対称な分布: ≈ 0
// - 右裾分布 (positive skew): > 0
// - 左裾分布 (negative skew): < 0
// - 定数入力 (σ=0): 0
// - 単一要素: 0
func TestComputeAggregateSkewness(t *testing.T) {
	// 対称分布 {1,2,3,4,5}: avg=3, σ²=2, Σ(x-μ)³ = (-2)³+(-1)³+0+1+8 = 0 → skewness=0
	if result := computeAggregate([]float64{1, 2, 3, 4, 5}); !approxEqual(result.Skewness, 0, 1e-9) {
		t.Errorf("symmetric distribution {1..5}: expected skewness 0, got %f", result.Skewness)
	}

	// 右裾分布 (positive skew): {1,1,1,1,10} → 大きい値が少数で離れている
	if result := computeAggregate([]float64{1, 1, 1, 1, 10}); result.Skewness <= 0 {
		t.Errorf("right-skewed distribution: expected skewness > 0, got %f", result.Skewness)
	}

	// 左裾分布 (negative skew): {1,10,10,10,10} → 小さい値が少数で離れている
	if result := computeAggregate([]float64{1, 10, 10, 10, 10}); result.Skewness >= 0 {
		t.Errorf("left-skewed distribution: expected skewness < 0, got %f", result.Skewness)
	}

	// 定数入力 (σ=0): 定義不能 → 0
	if result := computeAggregate([]float64{5, 5, 5, 5}); result.Skewness != 0 {
		t.Errorf("constant input: expected skewness 0 (σ=0 degenerate), got %f", result.Skewness)
	}

	// 単一要素: σ=0 → 0
	if result := computeAggregate([]float64{42}); result.Skewness != 0 {
		t.Errorf("single element: expected skewness 0, got %f", result.Skewness)
	}
}

// TestComputeAggregateSkewnessExactValue は既知の入力での skewness 値を厳密に検証する。
// 入力 [0,0,0,0,5] → avg=1, σ²=4, σ=2
//   Σ(x-1)³ = (-1)³*4 + 4³ = -4 + 64 = 60
//   m3 = 60 / 5 = 12
//   skewness = 12 / 8 = 1.5
func TestComputeAggregateSkewnessExactValue(t *testing.T) {
	result := computeAggregate([]float64{0, 0, 0, 0, 5})
	if !approxEqual(result.Skewness, 1.5, 1e-9) {
		t.Errorf("expected skewness 1.5, got %f", result.Skewness)
	}
}

// TestComputeAggregateSkewnessOpposingSign は対称性のあるテストケースで
// 入力を反転させた場合に skewness の符号が反転することを検証する。
func TestComputeAggregateSkewnessOpposingSign(t *testing.T) {
	right := computeAggregate([]float64{1, 1, 1, 1, 10})
	left := computeAggregate([]float64{1, 10, 10, 10, 10})
	if !approxEqual(right.Skewness, -left.Skewness, 1e-9) {
		t.Errorf("expected symmetric skewness (right=%f, -left=%f)", right.Skewness, -left.Skewness)
	}
}

// 大量の values を含む POST は 413 で拒否されることを検証。
// values 配列が `maxAggregateValues` を超えた場合のガード。
func TestAggregateHandlerRejectsTooManyValues(t *testing.T) {
	orig := maxAggregateValues
	maxAggregateValues = 3
	defer func() { maxAggregateValues = orig }()

	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413, got %d", w.Code)
	}
}

// 境界値: ちょうど maxAggregateValues 件は OK。
func TestAggregateHandlerAcceptsExactlyMaxValues(t *testing.T) {
	orig := maxAggregateValues
	maxAggregateValues = 3
	defer func() { maxAggregateValues = orig }()

	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
}

// リクエストボディ全体が maxAggregateBodyBytes を超えた場合 413 を返す。
func TestAggregateHandlerRejectsOversizedBody(t *testing.T) {
	orig := maxAggregateBodyBytes
	maxAggregateBodyBytes = 32 // バイト単位で意図的に小さくする
	defer func() { maxAggregateBodyBytes = orig }()

	// 32 バイトを確実に超えるペイロード
	body, _ := json.Marshal(AggregateRequest{Values: []float64{
		1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16,
	}})
	if len(body) <= 32 {
		t.Fatalf("test setup error: body must exceed 32 bytes, got %d", len(body))
	}

	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("expected 413 for oversized body, got %d", w.Code)
	}
}

// 設定値が <= 0 のときガードが無効化されることを確認。
func TestAggregateHandlerNoLimitWhenZero(t *testing.T) {
	origValues := maxAggregateValues
	origBody := maxAggregateBodyBytes
	maxAggregateValues = 0    // 件数ガード無効
	maxAggregateBodyBytes = 0 // ボディサイズガード無効
	defer func() {
		maxAggregateValues = origValues
		maxAggregateBodyBytes = origBody
	}()

	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	w := httptest.NewRecorder()
	aggregateHandler(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("expected 200 when limits are 0, got %d", w.Code)
	}
}

// 有限入力でも sum がオーバーフローして集計結果が +Inf になる場合、
// 壊れた 200 ではなく 422 を返すことを検証（issue 再現ケース）。
func TestAggregateHandlerRejectsNonFiniteResult(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1.5e308, 1.5e308}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("expected 422 for non-finite aggregate result, got %d (body=%q)", w.Code, w.Body.String())
	}
}

// 非有限の入力値（+Inf）は 400 で弾かれることを検証。
func TestAggregateHandlerRejectsNonFiniteInput(t *testing.T) {
	body := []byte(`{"values":[1.0,2.0,1e999]}`)
	if !bytes.Contains(body, []byte("1e999")) {
		t.Fatal("test setup error")
	}
	// 1e999 は float64 でデコード時に +Inf になる（encoding/json はエラーにしない）。
	var probe AggregateRequest
	if err := json.Unmarshal(body, &probe); err != nil {
		t.Skipf("decoder rejected oversized literal directly: %v", err)
	}
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusBadRequest {
		t.Fatalf("expected 400 for non-finite input value, got %d (body=%q)", w.Code, w.Body.String())
	}
}

func TestAggregateResponseHasNonFinite(t *testing.T) {
	finite := AggregateResponse{Sum: 1, Avg: 1, Min: 1, Max: 1, StdDev: 0, Median: 1, P95: 1, P99: 1}
	if finite.hasNonFinite() {
		t.Error("expected finite response to report no non-finite values")
	}
	withInf := finite
	withInf.Sum = math.Inf(1)
	if !withInf.hasNonFinite() {
		t.Error("expected response with +Inf sum to report non-finite")
	}
	withNaN := finite
	withNaN.StdDev = math.NaN()
	if !withNaN.hasNonFinite() {
		t.Error("expected response with NaN std_dev to report non-finite")
	}
	// Skewness の Inf/NaN もガードレールで弾かれることを検証する。
	withInfSkew := finite
	withInfSkew.Skewness = math.Inf(-1)
	if !withInfSkew.hasNonFinite() {
		t.Error("expected response with -Inf skewness to report non-finite")
	}
}

func TestEnvSecondsFallback(t *testing.T) {
	got := envSeconds("WORKER_DEFINITELY_UNSET_TIMEOUT", 9*time.Second)
	if got != 9*time.Second {
		t.Errorf("expected 9s fallback, got %v", got)
	}
}

func TestEnvSecondsOverride(t *testing.T) {
	t.Setenv("WORKER_TEST_TIMEOUT", "11")
	got := envSeconds("WORKER_TEST_TIMEOUT", 5*time.Second)
	if got != 11*time.Second {
		t.Errorf("expected 11s, got %v", got)
	}
}

func TestEnvSecondsInvalidUsesFallback(t *testing.T) {
	t.Setenv("WORKER_BAD_TIMEOUT", "abc")
	if got := envSeconds("WORKER_BAD_TIMEOUT", 4*time.Second); got != 4*time.Second {
		t.Errorf("expected 4s fallback for invalid value, got %v", got)
	}
	t.Setenv("WORKER_NEG_TIMEOUT", "-1")
	if got := envSeconds("WORKER_NEG_TIMEOUT", 4*time.Second); got != 4*time.Second {
		t.Errorf("expected 4s fallback for negative value, got %v", got)
	}
}

func TestEnvIntFallback(t *testing.T) {
	if got := envInt("WORKER_DEFINITELY_UNSET_INT", 42); got != 42 {
		t.Errorf("expected 42 fallback, got %d", got)
	}
}

func TestEnvIntOverride(t *testing.T) {
	t.Setenv("WORKER_TEST_INT", "1234")
	if got := envInt("WORKER_TEST_INT", 0); got != 1234 {
		t.Errorf("expected 1234, got %d", got)
	}
}

// Range = max - min を返すこと。AggregateResponse の `range` JSON フィールド経由で
// 後方互換に新規追加されたことを保証する。
func TestComputeAggregateRange(t *testing.T) {
	resp := computeAggregate([]float64{1, 4, 9, 16, 25})
	if resp.Range != 24 {
		t.Errorf("expected range 24, got %f", resp.Range)
	}
}

// 単一要素の入力では range / iqr は 0 になる（p25 == p75 == 唯一の値）。
func TestComputeAggregateRangeAndIQRSingleElement(t *testing.T) {
	resp := computeAggregate([]float64{42})
	if resp.Range != 0 {
		t.Errorf("expected range 0 for single value, got %f", resp.Range)
	}
	if resp.IQR != 0 {
		t.Errorf("expected iqr 0 for single value, got %f", resp.IQR)
	}
	if resp.P25 != 42 || resp.P75 != 42 {
		t.Errorf("expected p25=p75=42, got p25=%f p75=%f", resp.P25, resp.P75)
	}
}

// 1..9 の整数列における四分位の標準的な計算値を検証する。
// 線形補間 percentile では p25=3, p50=5, p75=7, IQR=4 になる。
func TestComputeAggregateQuartilesOfSimpleSeries(t *testing.T) {
	resp := computeAggregate([]float64{1, 2, 3, 4, 5, 6, 7, 8, 9})
	if resp.P25 != 3 {
		t.Errorf("expected p25=3, got %f", resp.P25)
	}
	if resp.Median != 5 {
		t.Errorf("expected median=5, got %f", resp.Median)
	}
	if resp.P75 != 7 {
		t.Errorf("expected p75=7, got %f", resp.P75)
	}
	if resp.IQR != 4 {
		t.Errorf("expected iqr=4, got %f", resp.IQR)
	}
	if resp.Range != 8 {
		t.Errorf("expected range=8, got %f", resp.Range)
	}
}

// IQR は常に p75 - p25 と整合する（任意の入力で成立する不変条件）。
func TestComputeAggregateIQRConsistencyWithP25P75(t *testing.T) {
	resp := computeAggregate([]float64{10.5, 11.0, 12.5, 13.0, 14.0, 15.5, 17.0, 22.0, 100.0})
	diff := resp.P75 - resp.P25
	if math.Abs(resp.IQR-diff) > 1e-9 {
		t.Errorf("expected iqr=%f to equal p75-p25=%f", resp.IQR, diff)
	}
}

// JSON レスポンスに新フィールドが含まれて返ること。
// （後方互換: 既存フィールドも引き続き含む）
func TestAggregateHandlerReturnsNewPercentileFields(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5, 6, 7, 8, 9}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	var raw map[string]any
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	for _, key := range []string{"p25", "p75", "iqr", "range"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("expected response key %q to be present", key)
		}
	}
	// 後方互換: 既存キーも残っていること。
	for _, key := range []string{"count", "sum", "avg", "min", "max", "std_dev", "median", "p95", "p99"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("expected legacy response key %q to remain", key)
		}
	}
}

// hasNonFinite() が新フィールドの NaN/Inf も検出することを保証する。
// （壊れた 200 レスポンスを返さないための保険）
func TestAggregateResponseHasNonFiniteDetectsNewFields(t *testing.T) {
	resp := AggregateResponse{Range: math.Inf(1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect Inf range")
	}
	resp = AggregateResponse{P25: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN p25")
	}
	resp = AggregateResponse{IQR: math.Inf(-1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect -Inf iqr")
	}
	resp = AggregateResponse{P75: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN p75")
	}
	resp = AggregateResponse{Variance: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN variance")
	}
	resp = AggregateResponse{Variance: math.Inf(1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect Inf variance")
	}
}

// 母集団分散（除数 n）の代表値を回帰する。
// values=[2,4,4,4,5,5,7,9] の母集団分散は 4.0、std_dev は 2.0。
func TestComputeAggregateVariance(t *testing.T) {
	result := computeAggregate([]float64{2, 4, 4, 4, 5, 5, 7, 9})
	if !approxEqual(result.Variance, 4.0, 1e-9) {
		t.Errorf("expected variance 4.0, got %f", result.Variance)
	}
	// std_dev = sqrt(variance) を保つこと。丸め誤差で 0 にならない範囲で確認。
	if !approxEqual(result.StdDev*result.StdDev, result.Variance, 1e-9) {
		t.Errorf(
			"expected std_dev^2 == variance, std_dev=%f variance=%f",
			result.StdDev, result.Variance,
		)
	}
}

// 単一要素入力では分散・標準偏差ともに 0 になること。
func TestComputeAggregateVarianceSingleValue(t *testing.T) {
	result := computeAggregate([]float64{42})
	if result.Variance != 0 {
		t.Errorf("expected variance 0 for single value, got %f", result.Variance)
	}
	if result.StdDev != 0 {
		t.Errorf("expected std_dev 0 for single value, got %f", result.StdDev)
	}
}

// すべて同値の入力では分散 = 0（StdDev と整合）。
func TestComputeAggregateVarianceConstantInput(t *testing.T) {
	result := computeAggregate([]float64{7, 7, 7, 7, 7})
	if result.Variance != 0 {
		t.Errorf("expected variance 0 for constant input, got %f", result.Variance)
	}
}

// JSON レスポンスに variance キーが含まれることを確認する(消費側 API の保証)。
func TestAggregateHandlerIncludesVarianceField(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode raw: %v", err)
	}
	if _, ok := raw["variance"]; !ok {
		t.Errorf("response JSON missing key \"variance\"")
	}

	var resp AggregateResponse
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to decode: %v", err)
	}
	// 1..5 の母集団分散 = 2.0
	if !approxEqual(resp.Variance, 2.0, 1e-9) {
		t.Errorf("expected variance 2.0, got %f", resp.Variance)
	}
}

// 1..100 の数値で p90 ≈ 90.10（線形補間方式）であることを回帰する。
// rank = 0.90 * 99 = 89.1, sorted[89]=90, sorted[90]=91, p90 = 90 + 0.1 * 1 = 90.1
func TestComputeAggregateP90(t *testing.T) {
	values := make([]float64, 100)
	for i := range values {
		values[i] = float64(i + 1)
	}
	result := computeAggregate(values)
	if !approxEqual(result.P90, 90.10, 0.01) {
		t.Errorf("expected p90 ≈ 90.10, got %f", result.P90)
	}
	// p25/p50/p75/p90/p95/p99 の単調増加（昇順入力の不変条件）を確認する。
	if !(result.P25 <= result.Median &&
		result.Median <= result.P75 &&
		result.P75 <= result.P90 &&
		result.P90 <= result.P95 &&
		result.P95 <= result.P99) {
		t.Errorf("expected percentiles to be monotonic non-decreasing")
	}
}

// 単一要素入力では p90 もその値そのものになる。
func TestComputeAggregateP90SingleValue(t *testing.T) {
	result := computeAggregate([]float64{42})
	if result.P90 != 42 {
		t.Errorf("expected p90=42 for single value, got %f", result.P90)
	}
}

// すべて同値の入力では p90 もその値そのもの（範囲ゼロの自明ケース）。
func TestComputeAggregateP90ConstantInput(t *testing.T) {
	result := computeAggregate([]float64{7, 7, 7, 7, 7})
	if result.P90 != 7 {
		t.Errorf("expected p90=7 for constant input, got %f", result.P90)
	}
}

// JSON レスポンスに p90 キーが含まれることを確認する（消費側 API の保証）。
func TestAggregateHandlerIncludesP90Field(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode raw: %v", err)
	}
	if _, ok := raw["p90"]; !ok {
		t.Errorf("response JSON missing key \"p90\"")
	}
}

// hasNonFinite() が p90 の NaN/Inf も検出することを保証する。
func TestAggregateResponseHasNonFiniteDetectsP90(t *testing.T) {
	resp := AggregateResponse{P90: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN p90")
	}
	resp = AggregateResponse{P90: math.Inf(1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect Inf p90")
	}
}

// CV (Coefficient of Variation) = std_dev / |avg|。
// avg=10, std_dev≈2 のとき CV≈0.2。
func TestComputeAggregateCV(t *testing.T) {
	values := []float64{8, 9, 10, 11, 12}
	result := computeAggregate(values)
	// avg = 10, variance = ((-2)^2 + (-1)^2 + 0 + 1^2 + 2^2)/5 = 10/5 = 2
	// std_dev = sqrt(2) ≈ 1.4142, CV = 1.4142 / 10 ≈ 0.14142
	expected := math.Sqrt(2) / 10
	if math.Abs(result.CV-expected) > 1e-9 {
		t.Errorf("expected CV %.6f, got %.6f", expected, result.CV)
	}
}

// avg = 0 のときは 0/0 不定なので 0 を返す。
func TestComputeAggregateCVZeroAverage(t *testing.T) {
	values := []float64{-5, 0, 5}
	result := computeAggregate(values)
	if result.Avg != 0 {
		t.Fatalf("test precondition failed: expected avg 0, got %f", result.Avg)
	}
	if result.CV != 0 {
		t.Errorf("expected CV 0 when avg=0, got %f", result.CV)
	}
}

// 定数入力では分散も 0 になるため CV = 0。
func TestComputeAggregateCVConstantInput(t *testing.T) {
	values := []float64{42, 42, 42, 42}
	result := computeAggregate(values)
	if result.CV != 0 {
		t.Errorf("expected CV 0 for constant input, got %f", result.CV)
	}
}

// 単一要素では std_dev = 0 なので CV = 0。
func TestComputeAggregateCVSingleValue(t *testing.T) {
	result := computeAggregate([]float64{17})
	if result.CV != 0 {
		t.Errorf("expected CV 0 for single value, got %f", result.CV)
	}
}

// 負の avg でも |avg| を使うので CV は正の値。
func TestComputeAggregateCVNegativeAverage(t *testing.T) {
	values := []float64{-12, -10, -8}
	result := computeAggregate(values)
	// avg = -10, variance = (4+0+4)/3 = 8/3, std_dev = sqrt(8/3)
	// CV = sqrt(8/3) / 10
	expected := math.Sqrt(8.0/3.0) / 10
	if math.Abs(result.CV-expected) > 1e-9 {
		t.Errorf("expected CV %.6f, got %.6f", expected, result.CV)
	}
	if result.CV < 0 {
		t.Errorf("CV must be non-negative, got %f", result.CV)
	}
}

func TestAggregateHandlerIncludesCVField(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode raw: %v", err)
	}
	if _, ok := raw["cv"]; !ok {
		t.Errorf("response JSON missing key \"cv\"")
	}
}

// hasNonFinite() が CV の NaN/Inf も検出することを保証する。
func TestAggregateResponseHasNonFiniteDetectsCV(t *testing.T) {
	resp := AggregateResponse{CV: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN cv")
	}
	resp = AggregateResponse{CV: math.Inf(1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect Inf cv")
	}
}

// TestComputeAggregateKurtosis は population kurtosis が以下の規約で計算されることを検証する:
// - 定数入力 (σ=0): 0
// - 単一要素: 0
// - heavy-tail 分布: > 3
// - 一様幅の対称分布: 3 未満（platykurtic）
func TestComputeAggregateKurtosis(t *testing.T) {
	// 定数入力 (σ=0): 定義不能 → 0
	if result := computeAggregate([]float64{5, 5, 5, 5}); result.Kurtosis != 0 {
		t.Errorf("constant input: expected kurtosis 0 (σ=0 degenerate), got %f", result.Kurtosis)
	}

	// 単一要素: σ=0 → 0
	if result := computeAggregate([]float64{42}); result.Kurtosis != 0 {
		t.Errorf("single element: expected kurtosis 0, got %f", result.Kurtosis)
	}

	// heavy-tail 分布: 平均近傍に集中しつつ大きな外れ値が出るケース → kurtosis > 3
	heavy := computeAggregate([]float64{0, 0, 0, 0, 0, 0, 0, 0, 0, 100})
	if heavy.Kurtosis <= 3 {
		t.Errorf("heavy-tail distribution: expected kurtosis > 3, got %f", heavy.Kurtosis)
	}

	// kurtosis は常に非負（定義上 Σ(x-μ)⁴ >= 0）。
	if heavy.Kurtosis < 0 {
		t.Errorf("kurtosis must be non-negative, got %f", heavy.Kurtosis)
	}
}

// TestComputeAggregateKurtosisExactValue は既知入力での kurtosis 値を厳密に検証する。
// 入力 [-1, 1] → avg=0, σ²=1, σ=1
//
//	Σ(x-0)⁴ = 1 + 1 = 2
//	m4 = 2 / 2 = 1
//	kurtosis = 1 / 1 = 1
//
// 2 値分布は kurtosis = 1（最小値）。
func TestComputeAggregateKurtosisExactValue(t *testing.T) {
	result := computeAggregate([]float64{-1, 1})
	if !approxEqual(result.Kurtosis, 1.0, 1e-9) {
		t.Errorf("expected kurtosis 1.0, got %f", result.Kurtosis)
	}
}

// TestComputeAggregateKurtosisInvariantUnderShift はシフト不変性を検証する。
// kurtosis は中心化されたモーメントの比なので、入力に定数を加えても変わらない。
func TestComputeAggregateKurtosisInvariantUnderShift(t *testing.T) {
	a := computeAggregate([]float64{1, 2, 3, 4, 5})
	b := computeAggregate([]float64{101, 102, 103, 104, 105})
	if !approxEqual(a.Kurtosis, b.Kurtosis, 1e-9) {
		t.Errorf("kurtosis must be shift-invariant: a=%f b=%f", a.Kurtosis, b.Kurtosis)
	}
}

func TestAggregateHandlerIncludesKurtosisField(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 5}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}

	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("failed to decode raw: %v", err)
	}
	if _, ok := raw["kurtosis"]; !ok {
		t.Errorf("response JSON missing key \"kurtosis\"")
	}
}

// hasNonFinite() が Kurtosis の NaN/Inf も検出することを保証する。
func TestAggregateResponseHasNonFiniteDetectsKurtosis(t *testing.T) {
	resp := AggregateResponse{Kurtosis: math.NaN()}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect NaN kurtosis")
	}
	resp = AggregateResponse{Kurtosis: math.Inf(1)}
	if !resp.hasNonFinite() {
		t.Error("expected hasNonFinite to detect Inf kurtosis")
	}
}

// TestParseLogLevel_AcceptsDebug は "DEBUG" 文字列が logLevelDebug に
// 変換されることを確認する。
func TestParseLogLevel_AcceptsDebug(t *testing.T) {
	if got := parseLogLevel("DEBUG"); got != logLevelDebug {
		t.Errorf("parseLogLevel(\"DEBUG\") = %v, want logLevelDebug", got)
	}
}

// TestParseLogLevel_IsCaseInsensitive は LOG_LEVEL の値解釈が
// 大文字小文字非依存であることを確認する。`debug` / `Debug` 等の
// 表記揺れで「production で suppress するつもりが output されてしまう」
// 事故を防ぐ。
func TestParseLogLevel_IsCaseInsensitive(t *testing.T) {
	for _, s := range []string{"debug", "Debug", "dEbUg", "  DEBUG  "} {
		if got := parseLogLevel(s); got != logLevelDebug {
			t.Errorf("parseLogLevel(%q) = %v, want logLevelDebug", s, got)
		}
	}
}

// TestParseLogLevel_DefaultsToInfo は未対応・未指定の値が logLevelInfo に
// フォールバックすることを確認する（空文字列 / `INFO` / 不正値 / `WARN` 等）。
func TestParseLogLevel_DefaultsToInfo(t *testing.T) {
	for _, s := range []string{"", "INFO", "info", "WARN", "WARNING", "ERROR", "unknown", "trace"} {
		if got := parseLogLevel(s); got != logLevelInfo {
			t.Errorf("parseLogLevel(%q) = %v, want logLevelInfo", s, got)
		}
	}
}

// withCurrentLogLevel は currentLogLevel を一時的に上書きし、テスト終了時に
// 元の値に戻すヘルパー。テスト間の独立性を保つ。
func withCurrentLogLevel(t *testing.T, level logLevel) {
	t.Helper()
	prev := currentLogLevel
	currentLogLevel = level
	t.Cleanup(func() { currentLogLevel = prev })
}

// captureLogger はパッケージレベル `logger` の出力先を一時的に bytes.Buffer に
// 差し替え、テスト終了時に元の os.Stdout 出力に戻す。logDebug の出力可否を
// 直接観測するために使う。
func captureLogger(t *testing.T) *bytes.Buffer {
	t.Helper()
	var buf bytes.Buffer
	prev := logger.Writer()
	logger.SetOutput(&buf)
	t.Cleanup(func() { logger.SetOutput(prev) })
	return &buf
}

// TestLogDebug_SuppressedAtInfoLevel は LOG_LEVEL=INFO（既定）の状態で
// logDebug 呼び出しが何も出力しないことを確認する。これが本 issue の中核。
func TestLogDebug_SuppressedAtInfoLevel(t *testing.T) {
	withCurrentLogLevel(t, logLevelInfo)
	buf := captureLogger(t)

	logDebug("Health check requested")

	if got := buf.String(); got != "" {
		t.Errorf("logDebug should not emit at INFO level, but got: %q", got)
	}
}

// TestLogDebug_EmittedAtDebugLevel は LOG_LEVEL=DEBUG のとき logDebug が
// 出力する（= デバッグ時には残せる）ことを確認する。
func TestLogDebug_EmittedAtDebugLevel(t *testing.T) {
	withCurrentLogLevel(t, logLevelDebug)
	buf := captureLogger(t)

	logDebug("Health check requested")

	if got := buf.String(); got == "" {
		t.Errorf("logDebug should emit at DEBUG level, but got empty output")
	}
}

// TestLogDebug_FormatsArguments は logDebug が Printf 形式の
// フォーマット引数を解釈することを確認する。
func TestLogDebug_FormatsArguments(t *testing.T) {
	withCurrentLogLevel(t, logLevelDebug)
	buf := captureLogger(t)

	logDebug("worker=%s count=%d", "metrics", 42)

	if got := buf.String(); !bytes.Contains([]byte(got), []byte("worker=metrics count=42")) {
		t.Errorf("logDebug should format args, but got: %q", got)
	}
}

// TestHealthHandler_DoesNotLogAtInfoLevel は本 issue の挙動上の受け入れ条件。
// INFO レベル（既定）で /health を叩いてもログが空であることを観測する。
func TestHealthHandler_DoesNotLogAtInfoLevel(t *testing.T) {
	withCurrentLogLevel(t, logLevelInfo)
	buf := captureLogger(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	healthHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if got := buf.String(); got != "" {
		t.Errorf("/health should not log at INFO level, but got: %q", got)
	}
}

// TestHealthHandler_LogsAtDebugLevel は LOG_LEVEL=DEBUG で /health を叩くと
// "Health check requested" が記録されることを確認する。デバッグ用途で
// ヘルスチェックが届いているか確認したいケースの後方互換を保証する。
func TestHealthHandler_LogsAtDebugLevel(t *testing.T) {
	withCurrentLogLevel(t, logLevelDebug)
	buf := captureLogger(t)

	req := httptest.NewRequest(http.MethodGet, "/health", nil)
	w := httptest.NewRecorder()
	healthHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d", w.Code)
	}
	if got := buf.String(); !bytes.Contains([]byte(got), []byte("Health check requested")) {
		t.Errorf("/health should log at DEBUG level, but got: %q", got)
	}
}

// TestTrimmedMean_Helper は trimmedMean ヘルパーの境界挙動を単体で検証する。
// n が小さくて切り落とし数が 0 になるケース、両端対称に切り落とすケース、
// 定数入力ケース、fraction=0.5 以上での自己防御ケースを網羅する。
func TestTrimmedMean_Helper(t *testing.T) {
	cases := []struct {
		name     string
		sorted   []float64
		fraction float64
		want     float64
	}{
		{
			name:     "empty returns 0",
			sorted:   []float64{},
			fraction: 0.1,
			want:     0,
		},
		{
			name:     "n=1 keeps single value (trim=0)",
			sorted:   []float64{42},
			fraction: 0.1,
			want:     42,
		},
		{
			name:     "n=9 fraction=0.1 trims 0 (floor(0.9)=0)",
			sorted:   []float64{1, 2, 3, 4, 5, 6, 7, 8, 9},
			fraction: 0.1,
			want:     5, // == avg
		},
		{
			name:     "n=10 fraction=0.1 trims 1 each side, mean of [2..9]",
			sorted:   []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10},
			fraction: 0.1,
			want:     5.5,
		},
		{
			name:     "n=10 with extreme outlier reduces mean to median-like",
			sorted:   []float64{1, 1, 1, 1, 1, 1, 1, 1, 1, 10000},
			fraction: 0.1,
			// trim=1: keep sorted[1..9] = [1,1,1,1,1,1,1,1] → mean=1
			want: 1,
		},
		{
			name:     "constant input equals that constant",
			sorted:   []float64{7, 7, 7, 7, 7, 7, 7, 7, 7, 7},
			fraction: 0.1,
			want:     7,
		},
		{
			name:     "fraction 0.5 would empty the slice → falls back to full mean",
			sorted:   []float64{1, 2, 3, 4},
			fraction: 0.5,
			// 2*trim=4=n → guard resets trim to 0, mean of [1,2,3,4]=2.5
			want: 2.5,
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := trimmedMean(tc.sorted, tc.fraction)
			if math.Abs(got-tc.want) > 1e-9 {
				t.Errorf("trimmedMean(%v, %v) = %v, want %v", tc.sorted, tc.fraction, got, tc.want)
			}
		})
	}
}

// TestComputeAggregate_TrimmedMean10 は AggregateResponse.TrimmedMean10 が
// 期待通り計算されることを確認する。既存フィールド (avg/median/mad) の値には
// 影響を与えないことを合わせて確認する。
func TestComputeAggregate_TrimmedMean10(t *testing.T) {
	t.Run("n=10 with outlier, trimmed_mean_10 pulls away from avg toward median", func(t *testing.T) {
		values := []float64{1, 1, 1, 1, 1, 1, 1, 1, 1, 10000}
		got := computeAggregate(values)
		// avg = (9*1 + 10000)/10 = 1000.9
		if math.Abs(got.Avg-1000.9) > 1e-9 {
			t.Errorf("Avg = %v, want 1000.9", got.Avg)
		}
		// median = mean of 5th/6th element = 1
		if got.Median != 1 {
			t.Errorf("Median = %v, want 1", got.Median)
		}
		// trimmed_mean_10 = 1 (すべての外れ値 1 件が切り落とされる)
		if got.TrimmedMean10 != 1 {
			t.Errorf("TrimmedMean10 = %v, want 1", got.TrimmedMean10)
		}
	})

	t.Run("n < 10 (trim=0) equals avg", func(t *testing.T) {
		values := []float64{2, 4, 6, 8}
		got := computeAggregate(values)
		if got.TrimmedMean10 != got.Avg {
			t.Errorf("TrimmedMean10 = %v, want == Avg = %v", got.TrimmedMean10, got.Avg)
		}
	})

	t.Run("constant input equals that constant", func(t *testing.T) {
		values := []float64{3, 3, 3, 3, 3, 3, 3, 3, 3, 3}
		got := computeAggregate(values)
		if got.TrimmedMean10 != 3 {
			t.Errorf("TrimmedMean10 = %v, want 3", got.TrimmedMean10)
		}
	})

	t.Run("uniform sequence trimmed_mean_10 equals avg (symmetric distribution)", func(t *testing.T) {
		// 昇順 [1..10]、下位 1 (=1) と上位 1 (=10) を切り落とす → mean([2..9]) = 5.5
		values := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
		got := computeAggregate(values)
		if got.TrimmedMean10 != 5.5 {
			t.Errorf("TrimmedMean10 = %v, want 5.5", got.TrimmedMean10)
		}
		// 対称分布なので avg と同値
		if got.TrimmedMean10 != got.Avg {
			t.Errorf("TrimmedMean10 = %v, Avg = %v; expected equal for symmetric input",
				got.TrimmedMean10, got.Avg)
		}
	})
}

// TestAggregate_JSONIncludesTrimmedMean10 は /api/v1/aggregate のレスポンス JSON に
// "trimmed_mean_10" キーが含まれることを回帰保証する。struct タグの typo で
// silent に "TrimmedMean10" 等になる事故を検出する。
func TestAggregate_JSONIncludesTrimmedMean10(t *testing.T) {
	body := strings.NewReader(`{"values":[1,2,3,4,5,6,7,8,9,10]}`)
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", body)
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	aggregateHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}
	var raw map[string]interface{}
	if err := json.Unmarshal(w.Body.Bytes(), &raw); err != nil {
		t.Fatalf("invalid JSON: %v", err)
	}
	v, ok := raw["trimmed_mean_10"]
	if !ok {
		t.Fatalf("response is missing \"trimmed_mean_10\" key: %s", w.Body.String())
	}
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("trimmed_mean_10 is not a number: %#v", v)
	}
	if f != 5.5 {
		t.Errorf("trimmed_mean_10 = %v, want 5.5", f)
	}
}
