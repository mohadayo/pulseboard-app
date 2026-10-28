package main

import "testing"

// TestEnvIntInvalidUsesFallback は envInt() が整数として解釈できない値を
// 受け取ったときに fallback を返すことを検証する。
//
// envInt は MAX_AGGREGATE_BODY_BYTES / MAX_AGGREGATE_VALUES の読み込みに
// 使われており、不正値が silent に 0 等へ落ちるとガード無効化と等価に
// なってしまう（init() の `v >= 0` チェックが fallback (-1) に依存している）。
// 既存 envSeconds の TestEnvSecondsInvalidUsesFallback と同じテーブル駆動
// パターンで、`strconv.Atoi` が構文エラーを返す代表的なケースを網羅する。
//
// なお `" 42"`（前後に空白）は `strconv.Atoi` 側で `strconv.ErrSyntax` に
// なり fallback に落ちる挙動を回帰させる。将来 TrimSpace を追加するような
// 挙動変更が入った場合にこのテストが検出する。
func TestEnvIntInvalidUsesFallback(t *testing.T) {
	cases := []struct {
		name  string
		value string
	}{
		{"non-numeric string", "abc"},
		{"float literal", "1.5"},
		{"leading whitespace", " 42"},
		{"trailing whitespace", "42 "},
		{"hex literal", "0x2a"},
		{"empty-after-sign", "-"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			t.Setenv("WORKER_INVALID_INT", tc.value)
			if got := envInt("WORKER_INVALID_INT", 99); got != 99 {
				t.Errorf("envInt(%q) = %d, want fallback 99", tc.value, got)
			}
		})
	}
}

// TestEnvIntEmptyUsesFallback は環境変数が空文字列に設定されているケースで
// fallback を返すことを検証する。`os.Getenv` は未設定と空文字を区別しないが、
// 実装の `if v != ""` 早期 return 経路が将来のリファクタで消えても、
// このテストが挙動を保つ。
func TestEnvIntEmptyUsesFallback(t *testing.T) {
	t.Setenv("WORKER_EMPTY_INT", "")
	if got := envInt("WORKER_EMPTY_INT", 7); got != 7 {
		t.Errorf("envInt(\"\") = %d, want fallback 7", got)
	}
}

// TestEnvIntAllowsNegativeValues は envInt が負の整数を「不正値」とは
// みなさずそのまま返すことを明示的に回帰する。負値を禁止している envSeconds
// (`n > 0`) と挙動が意図的に異なる: 呼び出し側 (init()) の `v >= 0`
// チェックに依存して「負値 = ガード無効化のサイン」として扱われているため、
// envInt 側では符号を落とさないという契約を守る。
func TestEnvIntAllowsNegativeValues(t *testing.T) {
	t.Setenv("WORKER_NEG_INT", "-1")
	if got := envInt("WORKER_NEG_INT", 0); got != -1 {
		t.Errorf("envInt(\"-1\") = %d, want -1 (negatives are passed through)", got)
	}
	t.Setenv("WORKER_ZERO_INT", "0")
	if got := envInt("WORKER_ZERO_INT", 42); got != 0 {
		t.Errorf("envInt(\"0\") = %d, want 0 (explicit zero is valid)", got)
	}
}
