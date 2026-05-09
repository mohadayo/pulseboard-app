package main

import (
	"encoding/json"
	"log"
	"math"
	"net/http"
	"os"
	"sync"
	"time"
)

type AggregateRequest struct {
	Values []float64 `json:"values"`
}

type AggregateResponse struct {
	Count  int     `json:"count"`
	Sum    float64 `json:"sum"`
	Avg    float64 `json:"avg"`
	Min    float64 `json:"min"`
	Max    float64 `json:"max"`
	StdDev float64 `json:"std_dev"`
}

type HealthResponse struct {
	Status    string `json:"status"`
	Service   string `json:"service"`
	Timestamp string `json:"timestamp"`
}

var (
	logger    = log.New(os.Stdout, "[metrics-worker] ", log.LstdFlags)
	jobCount  int
	jobMu     sync.Mutex
)

func healthHandler(w http.ResponseWriter, r *http.Request) {
	logger.Println("Health check requested")
	resp := HealthResponse{
		Status:    "ok",
		Service:   "metrics-worker",
		Timestamp: time.Now().UTC().Format(time.RFC3339),
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(resp)
}

func aggregateHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, `{"error":"method not allowed"}`, http.StatusMethodNotAllowed)
		return
	}

	var req AggregateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		logger.Printf("Invalid request body: %v", err)
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if len(req.Values) == 0 {
		logger.Println("Empty values array received")
		http.Error(w, `{"error":"values array must not be empty"}`, http.StatusBadRequest)
		return
	}

	result := computeAggregate(req.Values)

	jobMu.Lock()
	jobCount++
	currentJob := jobCount
	jobMu.Unlock()

	logger.Printf("Aggregation job #%d completed: count=%d avg=%.4f", currentJob, result.Count, result.Avg)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

func computeAggregate(values []float64) AggregateResponse {
	n := len(values)
	sum := 0.0
	minVal := values[0]
	maxVal := values[0]

	for _, v := range values {
		sum += v
		if v < minVal {
			minVal = v
		}
		if v > maxVal {
			maxVal = v
		}
	}

	avg := sum / float64(n)

	variance := 0.0
	for _, v := range values {
		diff := v - avg
		variance += diff * diff
	}
	variance /= float64(n)
	stdDev := math.Sqrt(variance)

	return AggregateResponse{
		Count:  n,
		Sum:    sum,
		Avg:    avg,
		Min:    minVal,
		Max:    maxVal,
		StdDev: stdDev,
	}
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8001"
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/api/v1/aggregate", aggregateHandler)

	logger.Printf("Starting metrics-worker on port %s", port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		logger.Fatalf("Server failed: %v", err)
	}
}
