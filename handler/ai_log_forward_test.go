package handler

import (
	"bytes"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestAIResponseLogRedactsLargeBase64WithoutTruncatingClient(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	payload := []byte(fmt.Sprintf(`{"created":1,"data":[{"b64_json":"%s"}]}`, strings.Repeat("iVBORw0KGgo", 120000)))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()

	request, err := http.NewRequest(http.MethodPost, upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	result := httptest.NewRecorder()
	copyAIResponse(result, request, model.ModelChannel{Protocol: "openai"}, aiLogContext{
		Endpoint:        "/images/generations",
		Method:          http.MethodPost,
		Model:           "gpt-image-2",
		UserID:          "fixture-user",
		UserDisplayName: "fixture",
	}, nil)

	if !bytes.Equal(result.Body.Bytes(), payload) {
		t.Fatalf("client response changed: got=%d want=%d bytes", result.Body.Len(), len(payload))
	}
	files, err := filepath.Glob(filepath.Join(config.Cfg.AILogDir, "ai-calls-*.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("log file count = %d, want 1", len(files))
	}
	raw, err := os.ReadFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) >= 8*1024 {
		t.Fatalf("persisted log length = %d, want < %d", len(raw), 8*1024)
	}
	var full model.AICallLog
	if err := json.Unmarshal(bytes.TrimSpace(raw), &full); err != nil {
		t.Fatal(err)
	}
	if regexp.MustCompile(`[A-Za-z0-9+/=]{512,}`).MatchString(full.ResponseBody) {
		t.Fatal("persisted response retained a contiguous base64 fragment of 512 characters or more")
	}
	if !strings.Contains(full.ResponseBody, "[redacted large base64/string]") {
		t.Fatalf("redaction placeholder missing: %q", full.ResponseBody)
	}
}

func TestAIUpstreamErrorDoesNotLogResponseBody(t *testing.T) {
	const secret = "SENSITIVE-UPSTREAM-BODY"
	payload := []byte(fmt.Sprintf(`{"error":{"message":"upstream failed"},"debug":"%s%s"}`, secret, strings.Repeat("A", 4096)))
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		_, _ = w.Write(payload)
	}))
	defer upstream.Close()

	request, err := http.NewRequest(http.MethodPost, upstream.URL, nil)
	if err != nil {
		t.Fatal(err)
	}
	var processLog bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&processLog)
	t.Cleanup(func() {
		log.SetOutput(previous)
	})

	result := httptest.NewRecorder()
	copyAIResponse(result, request, model.ModelChannel{Protocol: "openai"}, aiLogContext{SkipLog: true}, nil)

	output := processLog.String()
	if strings.Contains(output, secret) {
		t.Fatalf("process log exposed upstream response body: %s", output)
	}
	if !strings.Contains(output, "status=502") || !strings.Contains(output, "bodyBytes=") {
		t.Fatalf("process log did not describe the upstream failure safely: %s", output)
	}
}
