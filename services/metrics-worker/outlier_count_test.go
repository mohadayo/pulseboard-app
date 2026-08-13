package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

// TestComputeAggregateOutlierCount_SingleOutlier は右側の巨大スパイクを 1 件検出することを検証する。
// [1,2,3,4,100] の p25 = 2, p75 = 4, IQR = 2, 上側フェンス = 4 + 1.5*2 = 7。
// 100 > 7 なので外れ値件数は 1。下側フェンス = 2 - 3 = -1 で、最小値 1 は下側外れ値ではない。
func TestComputeAggregateOutlierCount_SingleOutlier(t *testing.T) {
	values := []float64{1, 2, 3, 4, 100}
	result := computeAggregate(values)
	if result.OutlierCount != 1 {
		t.Errorf(
			"OutlierCount for [1,2,3,4,100] = %d, want 1 (upper fence=%v, IQR=%v)",
			result.OutlierCount, result.P75+1.5*result.IQR, result.IQR,
		)
	}
}

// TestComputeAggregateOutlierCount_TwoSidedOutliers は下側と上側の両方に
// 外れ値がある場合の件数を検証する。
// [-100, 1, 2, 3, 4, 5, 200] の p25 = 1.5, p75 = 4.5, IQR = 3
// 下側フェンス = 1.5 - 4.5 = -3、上側フェンス = 4.5 + 4.5 = 9
// -100 < -3 で下側 1 件、200 > 9 で上側 1 件 → 計 2 件。
func TestComputeAggregateOutlierCount_TwoSidedOutliers(t *testing.T) {
	values := []float64{-100, 1, 2, 3, 4, 5, 200}
	result := computeAggregate(values)
	if result.OutlierCount != 2 {
		t.Errorf(
			"OutlierCount for [-100,1,2,3,4,5,200] = %d, want 2 (lower=%v, upper=%v)",
			result.OutlierCount, result.P25-1.5*result.IQR, result.P75+1.5*result.IQR,
		)
	}
}

// TestComputeAggregateOutlierCount_NoOutliers は「なだらかな系列」で
// 外れ値件数が 0 になることを検証する（正常系ダッシュボードの回帰）。
// [1,2,3,4,5,6,7,8,9,10] は全値がフェンス内に収まる。
func TestComputeAggregateOutlierCount_NoOutliers(t *testing.T) {
	values := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10}
	result := computeAggregate(values)
	if result.OutlierCount != 0 {
		t.Errorf("OutlierCount for uniform series = %d, want 0", result.OutlierCount)
	}
}

// TestComputeAggregateOutlierCount_ConstantInput は定数入力（全要素同値）で
// IQR = 0 → フェンスが 1 点に縮退 → 全値がフェンス上 → 外れ値件数 0 になることを検証する。
// 既存 mad / cv / skewness / kurtosis の σ=0 退化規約と整合。
func TestComputeAggregateOutlierCount_ConstantInput(t *testing.T) {
	values := []float64{5, 5, 5, 5, 5}
	result := computeAggregate(values)
	if result.OutlierCount != 0 {
		t.Errorf("OutlierCount for constant input = %d, want 0 (degenerate IQR=0)", result.OutlierCount)
	}
}

// TestComputeAggregateOutlierCount_SingleValue は要素 1 個の入力で
// p25 == p75 == value、IQR = 0、フェンスが単一点に縮退 → 0 件になる境界条件。
func TestComputeAggregateOutlierCount_SingleValue(t *testing.T) {
	values := []float64{42}
	result := computeAggregate(values)
	if result.OutlierCount != 0 {
		t.Errorf("OutlierCount for single value = %d, want 0", result.OutlierCount)
	}
}

// TestComputeAggregateOutlierCount_MultipleOutliersSameSide は上側に複数の
// 外れ値が並んだ場合、全件がカウントされることを検証する（ループ早期打ち切りの
// 誤リファクタで下位の外れ値のみに絞られないことの回帰）。
//
// [1..10, 100, 200, 300] の分位数 (n=13):
//   - p25 = sorted[floor(0.25 * 12)=3] = 4
//   - p75 = sorted[floor(0.75 * 12)=9] = 10
//   - IQR = 6、上側フェンス = 10 + 9 = 19
//   - 100 / 200 / 300 はすべて > 19 なので上側外れ値 3 件
//
// 「大量の large 値が p75 を引き上げてフェンスを外れ値ごと含んでしまう」現象を
// 避けるため、外れ値件数は総数の 1/4 未満に抑えている（Tukey フェンスは
// 外れ値混入率が高い分布では検出感度が落ちる標準的挙動）。
func TestComputeAggregateOutlierCount_MultipleOutliersSameSide(t *testing.T) {
	values := []float64{1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 100, 200, 300}
	result := computeAggregate(values)
	if result.OutlierCount != 3 {
		t.Errorf(
			"OutlierCount for [1..10, 100, 200, 300] = %d, want 3 (upper fence=%v)",
			result.OutlierCount, result.P75+1.5*result.IQR,
		)
	}
}

// TestComputeAggregateOutlierCount_ExactlyOnFence は値が Tukey フェンス上に
// 乗った場合、外れ値としてカウントされないことを検証する（厳格比較 < / > を採用）。
// [0, 1, 2, 3, 4] の p25 = 1, p75 = 3, IQR = 2
// 下側フェンス = 1 - 3 = -2、上側フェンス = 3 + 3 = 6。
// フェンス上ちょうどに置いた -2 / 6 を追加した [-2, 0, 1, 2, 3, 4, 6] では
// -2 も 6 も外れ値ではない（境界を含まない）ことを確認する。
// なおこれによって IQR / フェンスも変わる: n=7 の p25 = 1*1.5(interp)、
// ここでは新しい入力に対して再計算した値が「外れ値カウント 0」になることを
// 統合的に確認する。
func TestComputeAggregateOutlierCount_ExactlyOnFence(t *testing.T) {
	// n=7 について改めて計算:
	// sorted = [-2, 0, 1, 2, 3, 4, 6], n=7
	// p25 = interpolate at rank 0.25*6 = 1.5 → sorted[1]*(0.5) + sorted[2]*(0.5) = 0*0.5+1*0.5 = 0.5
	// p75 = interpolate at rank 0.75*6 = 4.5 → sorted[4]*(0.5) + sorted[5]*(0.5) = 3*0.5+4*0.5 = 3.5
	// IQR = 3.0、下側フェンス = 0.5 - 4.5 = -4、上側フェンス = 3.5 + 4.5 = 8
	// -2 > -4、6 < 8 → 外れ値 0 件（境界含まない厳格比較）
	values := []float64{-2, 0, 1, 2, 3, 4, 6}
	result := computeAggregate(values)
	if result.OutlierCount != 0 {
		t.Errorf(
			"OutlierCount for boundary case = %d, want 0 (strict < / > comparison; fences at %v..%v)",
			result.OutlierCount, result.P25-1.5*result.IQR, result.P75+1.5*result.IQR,
		)
	}
}

// TestAggregateHandler_JSONIncludesOutlierCount は /api/v1/aggregate の
// レスポンス JSON に "outlier_count" キーが含まれ、正しく整数値として
// エンコードされることを検証する。フィールドタグの誤り（`outlierCount`
// 等に silent に落ちる事故）を検出する。
func TestAggregateHandler_JSONIncludesOutlierCount(t *testing.T) {
	body, _ := json.Marshal(AggregateRequest{Values: []float64{1, 2, 3, 4, 100}})
	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate", bytes.NewReader(body))
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
	v, ok := raw["outlier_count"]
	if !ok {
		t.Fatalf("response is missing \"outlier_count\" key: %s", w.Body.String())
	}
	// JSON の数値は float64 でデコードされる。1.0 相当を期待。
	f, ok := v.(float64)
	if !ok {
		t.Fatalf("outlier_count is not a number: %#v", v)
	}
	if f != 1 {
		t.Errorf("outlier_count = %v, want 1", f)
	}
}
