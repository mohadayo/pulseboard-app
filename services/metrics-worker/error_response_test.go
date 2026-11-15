package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// エラー応答が JSON ボディと一致する Content-Type (application/json) で返ることを検証する。
// 以前は http.Error を使っていたため text/plain; charset=utf-8 になっていた。
func TestAggregateErrorResponsesAreJSON(t *testing.T) {
	cases := []struct {
		name       string
		method     string
		body       string
		wantStatus int
		wantError  string
	}{
		{"method not allowed", http.MethodGet, "", http.StatusMethodNotAllowed, "method not allowed"},
		{"invalid json", http.MethodPost, "{not json", http.StatusBadRequest, "invalid request body"},
		{"empty values", http.MethodPost, `{"values":[]}`, http.StatusBadRequest, "values array must not be empty"},
		{"non-finite overflow", http.MethodPost, `{"values":[1.7976931348623157e308,1.7976931348623157e308]}`,
			http.StatusUnprocessableEntity, "aggregate result is not finite; input values may be out of representable range"},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(tc.method, "/api/v1/aggregate", strings.NewReader(tc.body))
			w := httptest.NewRecorder()
			aggregateHandler(w, req)

			if w.Code != tc.wantStatus {
				t.Fatalf("status = %d, want %d", w.Code, tc.wantStatus)
			}
			if ct := w.Header().Get("Content-Type"); ct != "application/json" {
				t.Fatalf("Content-Type = %q, want application/json", ct)
			}
			if got := w.Header().Get("X-Content-Type-Options"); got != "nosniff" {
				t.Fatalf("X-Content-Type-Options = %q, want nosniff", got)
			}
			var resp map[string]string
			if err := json.NewDecoder(w.Body).Decode(&resp); err != nil {
				t.Fatalf("body is not valid JSON: %v", err)
			}
			if resp["error"] != tc.wantError {
				t.Fatalf("error = %q, want %q", resp["error"], tc.wantError)
			}
		})
	}
}

func TestAggregateMethodNotAllowedSetsAllowHeader(t *testing.T) {
	for _, m := range []string{http.MethodGet, http.MethodPut, http.MethodDelete} {
		req := httptest.NewRequest(m, "/api/v1/aggregate", nil)
		w := httptest.NewRecorder()
		aggregateHandler(w, req)
		if w.Code != http.StatusMethodNotAllowed {
			t.Fatalf("%s: status = %d, want 405", m, w.Code)
		}
		if got := w.Header().Get("Allow"); got != http.MethodPost {
			t.Fatalf("%s: Allow = %q, want POST", m, got)
		}
	}
}

func TestAggregateBodyTooLargeIsJSON(t *testing.T) {
	orig := maxAggregateBodyBytes
	maxAggregateBodyBytes = 16
	defer func() { maxAggregateBodyBytes = orig }()

	req := httptest.NewRequest(http.MethodPost, "/api/v1/aggregate",
		strings.NewReader(`{"values":[1,2,3,4,5,6,7,8,9,10]}`))
	w := httptest.NewRecorder()
	aggregateHandler(w, req)

	if w.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want 413", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json" {
		t.Fatalf("Content-Type = %q, want application/json", ct)
	}
}
