package router

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAPIHealthSmallResponseIsNotCompressed(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/health", nil)
	request.Header.Set("Accept-Encoding", "gzip")
	response := httptest.NewRecorder()
	New().ServeHTTP(response, request)

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if response.Body.String() != "ok" {
		t.Fatalf("body = %q, want ok", response.Body.String())
	}
	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want absent", got)
	}
}
