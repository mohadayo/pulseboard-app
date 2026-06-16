package main

import (
	"bytes"
	"encoding/json"
	"math"
	"net/http"
	"net/http/httptest"
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
	for _, key := range []string{"median", "p95", "p99"} {
		if _, ok := raw[key]; !ok {
			t.Errorf("response JSON missing key %q", key)
		}
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

// JSON レスポンスに variance キーが含まれることを確認する（消費側 API の保証）。
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
