package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
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
