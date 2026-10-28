package service

import (
	"strings"
	"testing"
)

func TestRedactLargePlainLogTextHandlesTruncatedBase64(t *testing.T) {
	truncated := `{"data":[{"b64_json":"` + strings.Repeat("iVBORw0KGgo", 6000)
	got := redactLargePlainLogText(truncated)
	if strings.Contains(got, strings.Repeat("iVBORw0KGgo", 64)) {
		t.Fatal("truncated base64 payload was not redacted")
	}
	if !strings.Contains(got, "[redacted large base64/string]") {
		t.Fatalf("redaction placeholder missing: %q", got)
	}
}
