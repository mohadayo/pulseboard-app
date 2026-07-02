package main

import (
	"math"
	"testing"
)

// TestComputeAggregateMAD_ConstantInput は定数入力（全要素同値）で MAD が 0 になることを検証する。
// |xᵢ - median| がすべて 0 になるため、その中央値も 0 になる自然な結果。
// std_dev / variance / cv / skewness / kurtosis がすべて 0 になる既存規約と一致する。
func TestComputeAggregateMAD_ConstantInput(t *testing.T) {
	values := []float64{5, 5, 5, 5, 5}
	result := computeAggregate(values)
	if result.MAD != 0 {
		t.Errorf("MAD for constant input = %v, want 0", result.MAD)
	}
}

// TestComputeAggregateMAD_SymmetricSeries は [1,2,3,4,5] の median = 3 で
// |xᵢ - 3| = [2,1,0,1,2]、これをソートすると [0,1,1,2,2] で中央値 = 1 になることを検証する。
// 対称分布での MAD の期待値がハンド計算と一致することの回帰テスト。
func TestComputeAggregateMAD_SymmetricSeries(t *testing.T) {
	values := []float64{1, 2, 3, 4, 5}
	result := computeAggregate(values)
	if got, want := result.MAD, 1.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("MAD for [1..5] = %v, want %v", got, want)
	}
}

// TestComputeAggregateMAD_EvenLengthSeries は要素数が偶数の場合、
// 絶対偏差の median が線形補間で決まることを検証する。
// [1,2,3,4] の median = 2.5, |xᵢ - 2.5| = [1.5, 0.5, 0.5, 1.5]
// ソート後 [0.5, 0.5, 1.5, 1.5] の median は (0.5 + 1.5)/2 = 1.0。
func TestComputeAggregateMAD_EvenLengthSeries(t *testing.T) {
	values := []float64{1, 2, 3, 4}
	result := computeAggregate(values)
	if got, want := result.MAD, 1.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("MAD for [1..4] = %v, want %v", got, want)
	}
}

// TestComputeAggregateMAD_RobustToOutlier は MAD の頑健性 (breakdown point 50%) の回帰テスト。
// [1,2,3,4,100] は std_dev が 100 に大きく引きずられるが、MAD は中央値基準なので
// 外れ値の影響を受けず、[1..5] のケースと同じ「中央部の代表的ばらつき」を返すことを確認する。
// median = 3, |xᵢ - 3| = [2, 1, 0, 1, 97]、ソートすると [0, 1, 1, 2, 97] で中央値 = 1。
func TestComputeAggregateMAD_RobustToOutlier(t *testing.T) {
	values := []float64{1, 2, 3, 4, 100}
	result := computeAggregate(values)
	if got, want := result.MAD, 1.0; math.Abs(got-want) > 1e-9 {
		t.Errorf("MAD for [1,2,3,4,100] = %v, want %v (should be robust to outlier)", got, want)
	}
	// 頑健性の証拠として、MAD << std_dev を明示的に確認する。
	// std_dev はおおよそ 38.68、MAD は 1.0 で 30 倍以上の乖離があるはず。
	if result.MAD >= result.StdDev {
		t.Errorf(
			"MAD (%v) should be much smaller than StdDev (%v) in outlier case",
			result.MAD, result.StdDev,
		)
	}
}

// TestComputeAggregateMAD_SingleValue は要素 1 個の入力で MAD が 0 になることを検証する。
// median = 唯一の値、絶対偏差 = 0、その中央値も 0 になる境界条件。
func TestComputeAggregateMAD_SingleValue(t *testing.T) {
	values := []float64{42}
	result := computeAggregate(values)
	if result.MAD != 0 {
		t.Errorf("MAD for single value = %v, want 0", result.MAD)
	}
}

// TestAggregateResponseHasNonFinite_DetectsMAD は hasNonFinite() の走査対象に
// MAD が組み込まれていることを検証する。他フィールドの追加漏れによる
// 「200 + 壊れたペイロード」応答を防ぐガードの回帰テスト。
func TestAggregateResponseHasNonFinite_DetectsMAD(t *testing.T) {
	cases := []struct {
		name string
		mad  float64
	}{
		{"NaN", math.NaN()},
		{"+Inf", math.Inf(1)},
		{"-Inf", math.Inf(-1)},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			resp := AggregateResponse{MAD: tc.mad}
			if !resp.hasNonFinite() {
				t.Errorf("hasNonFinite should detect MAD = %v as non-finite", tc.mad)
			}
		})
	}
}
