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
}
