package main

import (
	"context"
	"encoding/json"
	"errors"
	"log"
	"math"
	"net/http"
	"os"
	"os/signal"
	"sort"
	"strconv"
	"sync"
	"syscall"
	"time"
)

type AggregateRequest struct {
	Values []float64 `json:"values"`
}

type AggregateResponse struct {
	Count int     `json:"count"`
	Sum   float64 `json:"sum"`
	Avg   float64 `json:"avg"`
	Min   float64 `json:"min"`
	Max   float64 `json:"max"`
	Range float64 `json:"range"`
	// 母集団分散（除数 n、Bessel 補正なし）。StdDev = sqrt(Variance) の関係を保つ。
	// 後段の集計サーバが複数 worker の結果をマージする際、平方和を再計算せずに
	// 合成分散の閉形式を組み立てられるようにするため、std_dev とは別に露出する。
	Variance float64 `json:"variance"`
	StdDev   float64 `json:"std_dev"`
	Median   float64 `json:"median"`
	P25      float64 `json:"p25"`
	P75      float64 `json:"p75"`
	IQR      float64 `json:"iqr"`
	// SLO 指標として p95 / p99 と並んで実利用で使われるため、既存パーセンタイル群と
	// 同じ補間方式 (percentile()) で個別フィールドとして露出する。
	P90 float64 `json:"p90"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
}

type HealthResponse struct {
	Status    string `json:"status"`
	Service   string `json:"service"`
	Timestamp string `json:"timestamp"`
}

var (
	logger   = log.New(os.Stdout, "[metrics-worker] ", log.LstdFlags)
	jobCount int
	jobMu    sync.Mutex

	// /api/v1/aggregate のリクエストボディ全体に対するサイズ上限（バイト）。
	// 0 以下なら無制限（テスト等での明示無効化用）。
	maxAggregateBodyBytes int64 = 1 << 20 // 1 MiB

	// /api/v1/aggregate の values 配列の要素数上限。
	// 0 以下なら無制限。
	maxAggregateValues = 10000
)

func init() {
	if v := envInt("MAX_AGGREGATE_BODY_BYTES", -1); v >= 0 {
		maxAggregateBodyBytes = int64(v)
	}
	if v := envInt("MAX_AGGREGATE_VALUES", -1); v >= 0 {
		maxAggregateValues = v
	}
}

func envInt(key string, fallback int) int {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return fallback
}

func envSeconds(key string, fallback time.Duration) time.Duration {
	if v := os.Getenv(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return time.Duration(n) * time.Second
		}
	}
	return fallback
}

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

	// リクエストボディ全体に対する上限。
	// JSON デコード前に上限を超えればここで打ち切られ、追加メモリを確保しない。
	if maxAggregateBodyBytes > 0 {
		r.Body = http.MaxBytesReader(w, r.Body, maxAggregateBodyBytes)
	}

	var req AggregateRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		var mbe *http.MaxBytesError
		if errors.As(err, &mbe) {
			logger.Printf("Request body too large: %d > %d", mbe.Limit, maxAggregateBodyBytes)
			http.Error(w, `{"error":"request body too large"}`, http.StatusRequestEntityTooLarge)
			return
		}
		logger.Printf("Invalid request body: %v", err)
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}

	if len(req.Values) == 0 {
		logger.Println("Empty values array received")
		http.Error(w, `{"error":"values array must not be empty"}`, http.StatusBadRequest)
		return
	}

	if maxAggregateValues > 0 && len(req.Values) > maxAggregateValues {
		logger.Printf(
			"Too many values: %d > %d",
			len(req.Values), maxAggregateValues,
		)
		http.Error(w, `{"error":"values array too large"}`, http.StatusRequestEntityTooLarge)
		return
	}

	// 入力に非有限値が含まれる場合は弾く（api-gateway / dashboard-bff と挙動を揃える）。
	for i, v := range req.Values {
		if math.IsInf(v, 0) || math.IsNaN(v) {
			logger.Printf("Non-finite value at index %d", i)
			http.Error(w, `{"error":"values must all be finite numbers"}`, http.StatusBadRequest)
			return
		}
	}

	result := computeAggregate(req.Values)

	// 入力が有限でも sum のオーバーフロー等で集計結果が Inf/NaN になりうる。
	// その場合 json.Encode が失敗し「200 + 壊れた空ボディ」を返してしまうため、
	// エンコード前に検出して明示的に 422 を返す。
	if result.hasNonFinite() {
		logger.Printf("Aggregate produced a non-finite result (count=%d)", result.Count)
		http.Error(
			w,
			`{"error":"aggregate result is not finite; input values may be out of representable range"}`,
			http.StatusUnprocessableEntity,
		)
		return
	}

	jobMu.Lock()
	jobCount++
	currentJob := jobCount
	jobMu.Unlock()

	logger.Printf("Aggregation job #%d completed: count=%d avg=%.4f", currentJob, result.Count, result.Avg)

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(result)
}

// percentile は昇順ソート済みの values から、線形補間による pct パーセンタイル値を返す。
// pct は 0～100 の範囲。空スライスの場合は 0 を返す。
func percentile(sorted []float64, pct float64) float64 {
	n := len(sorted)
	if n == 0 {
		return 0
	}
	if n == 1 {
		return sorted[0]
	}
	rank := (pct / 100.0) * float64(n-1)
	lower := int(math.Floor(rank))
	upper := int(math.Ceil(rank))
	if lower == upper {
		return sorted[lower]
	}
	weight := rank - float64(lower)
	return sorted[lower]*(1-weight) + sorted[upper]*weight
}

// hasNonFinite は集計結果のいずれかの数値フィールドが非有限値 (Inf / NaN) に
// なっていないかを判定する。有限入力でもオーバーフローで非有限になりうるため、
// 壊れた 200 応答を返す前にこの判定を用いる。
func (a AggregateResponse) hasNonFinite() bool {
	for _, v := range []float64{
		a.Sum, a.Avg, a.Min, a.Max, a.Range,
		a.Variance, a.StdDev, a.Median, a.P25, a.P75, a.IQR, a.P90, a.P95, a.P99,
	} {
		if math.IsInf(v, 0) || math.IsNaN(v) {
			return true
		}
	}
	return false
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

	sorted := make([]float64, n)
	copy(sorted, values)
	sort.Float64s(sorted)

	p25 := percentile(sorted, 25)
	p75 := percentile(sorted, 75)
	return AggregateResponse{
		Count:    n,
		Sum:      sum,
		Avg:      avg,
		Min:      minVal,
		Max:      maxVal,
		Range:    maxVal - minVal,
		Variance: variance,
		StdDev:   stdDev,
		Median:   percentile(sorted, 50),
		P25:      p25,
		P75:      p75,
		IQR:      p75 - p25,
		P90:      percentile(sorted, 90),
		P95:      percentile(sorted, 95),
		P99:      percentile(sorted, 99),
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

	srv := &http.Server{
		Addr:              ":" + port,
		Handler:           mux,
		ReadHeaderTimeout: envSeconds("WORKER_READ_HEADER_TIMEOUT", 5*time.Second),
		ReadTimeout:       envSeconds("WORKER_READ_TIMEOUT", 15*time.Second),
		WriteTimeout:      envSeconds("WORKER_WRITE_TIMEOUT", 15*time.Second),
		IdleTimeout:       envSeconds("WORKER_IDLE_TIMEOUT", 60*time.Second),
	}

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		logger.Printf("Starting metrics-worker on port %s", port)
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			logger.Fatalf("Server failed: %v", err)
		}
	}()

	<-quit
	logger.Println("Shutting down metrics-worker gracefully...")

	shutdownTimeout := envSeconds("WORKER_SHUTDOWN_TIMEOUT", 30*time.Second)
	ctx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		logger.Fatalf("Graceful shutdown failed: %v", err)
	}
	logger.Println("metrics-worker stopped")
}
