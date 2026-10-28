package service

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestAICallLogAPIWritesBoundedRedactedRecord(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
		defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})
	})
	defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})

	payload := strings.Repeat("iVBORw0KGgo", 120000)
	SaveAICallLog(AICallLogInput{
		UserID:       "bounded-user",
		Endpoint:     "/images/generations",
		Method:       "POST",
		Model:        "gpt-image-2",
		Status:       200,
		ResponseBody: `{"data":[{"b64_json":"` + payload + `"}]}`,
	})

	file := aiLogAPIOnlyFile(t)
	raw, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) >= 8*1024 {
		t.Fatalf("persisted log length = %d, want < %d", len(raw), 8*1024)
	}
	if regexp.MustCompile(`[A-Za-z0-9+/=]{512,}`).Match(raw) {
		t.Fatal("persisted log contains a contiguous base64 fragment of 512 characters or more")
	}

	var item model.AICallLog
	if err := json.Unmarshal(raw, &item); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(item.ResponseBody, "[redacted large base64/string]") {
		t.Fatalf("redaction placeholder missing: %q", item.ResponseBody)
	}
}

func TestAICallLogAPIRedactsBeforeTruncatingAllBodies(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
		defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})
	})
	defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})

	const (
		requestTail  = "request-tail-after-redaction"
		responseTail = "response-tail-after-redaction"
		errorTail    = "error-tail-after-redaction"
	)
	requestBody := `{"b64_json":"` + strings.Repeat("A", aiLogRequestTextLimit+1) + `","tail":"` + requestTail + `"}`
	responseBody := `{"b64_json":"` + strings.Repeat("A", aiLogResponseTextLimit+1) + `","tail":"` + responseTail + `"}`
	errorText := `{"b64_json":"` + strings.Repeat("A", aiLogErrorTextLimit+1) + `","tail":"` + errorTail + `"}`
	if len(requestBody) <= aiLogRequestTextLimit || len(responseBody) <= aiLogResponseTextLimit || len(errorText) <= aiLogErrorTextLimit {
		t.Fatal("fixtures must exceed their respective persisted body limits")
	}

	SaveAICallLog(AICallLogInput{
		UserID:       "redact-before-truncate-user",
		Endpoint:     "/images/generations",
		Method:       "POST",
		Model:        "gpt-image-2",
		Status:       500,
		RequestBody:  requestBody,
		ResponseBody: responseBody,
		Error:        errorText,
	})

	raw, err := os.ReadFile(aiLogAPIOnlyFile(t))
	if err != nil {
		t.Fatal(err)
	}
	var item model.AICallLog
	if err := json.Unmarshal(raw, &item); err != nil {
		t.Fatal(err)
	}
	for _, field := range []struct {
		name     string
		value    string
		wantTail string
	}{
		{name: "requestBody", value: item.RequestBody, wantTail: requestTail},
		{name: "responseBody", value: item.ResponseBody, wantTail: responseTail},
		{name: "error", value: item.Error, wantTail: errorTail},
	} {
		if !strings.Contains(field.value, field.wantTail) {
			t.Fatalf("%s lost its tail after redaction: %q", field.name, field.value)
		}
		if !strings.Contains(field.value, "[redacted large base64/string]") {
			t.Fatalf("%s redaction placeholder missing: %q", field.name, field.value)
		}
		if strings.Contains(field.value, strings.Repeat("A", 512)) {
			t.Fatalf("%s retained a contiguous base64 fragment of 512 characters or more", field.name)
		}
	}
}

func TestAICallLogAPIRedactsEscapedJSONBase64(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
		defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})
	})
	defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})

	SaveAICallLog(AICallLogInput{
		UserID:       "escaped-base64-user",
		Endpoint:     "/images/generations",
		Method:       "POST",
		Model:        "gpt-image-2",
		Status:       200,
		ResponseBody: `{"data":[{"b64_json":"` + strings.Repeat(`abcd\/`, 2000) + `"}]}`,
	})

	raw, err := os.ReadFile(aiLogAPIOnlyFile(t))
	if err != nil {
		t.Fatal(err)
	}
	if len(raw) >= 8*1024 {
		t.Fatalf("persisted log length = %d, want < %d", len(raw), 8*1024)
	}
	var item model.AICallLog
	if err := json.Unmarshal(raw, &item); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(item.ResponseBody, strings.Repeat(`abcd\/`, 128)) {
		t.Fatalf("persisted response retained escaped-slash base64: %q", item.ResponseBody)
	}
	if !strings.Contains(item.ResponseBody, "[redacted large base64/string]") {
		t.Fatalf("redaction placeholder missing: %q", item.ResponseBody)
	}
}

func TestAICallLogAPIReadsLegacyFailureReasonAndRedactsTruncatedBase64(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
		defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})
	})
	defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})

	const id = "legacy-detail"
	legacyRequest := `{"prompt":"legacy","image":"` + strings.Repeat("iVBORw0KGgo", 1000) + `"}`
	legacyResponse := `{"error":{"message":"upstream rejected request"},"data":[{"b64_json":"` +
		strings.Repeat("iVBORw0KGgo", 1000)
	legacyError := `{"b64_json":"` + strings.Repeat("iVBORw0KGgo", 1000) + `","error":{"message":"upstream rejected request"}}`
	item := model.AICallLog{
		ID:           id,
		UserID:       "legacy-user",
		Endpoint:     "/images/generations",
		Method:       "POST",
		Model:        "gpt-image-2",
		Status:       500,
		RequestBody:  legacyRequest,
		ResponseBody: legacyResponse,
		Error:        legacyError,
		CreatedAt:    time.Now().Format(time.RFC3339),
	}
	file := filepath.Join(config.Cfg.AILogDir, "ai-calls-2026-10-28.log")
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(file, append(encoded, '\n'), 0644); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}

	got, found, err := GetAICallLog(id)
	if err != nil {
		t.Fatal(err)
	}
	if !found {
		t.Fatal("legacy detail not found")
	}
	if strings.Contains(got.RequestBody, strings.Repeat("iVBORw0KGgo", 64)) {
		t.Fatal("legacy detail retained the request base64 payload")
	}
	const expectedRequestBody = "{\n  \"image\": \"[redacted large base64/string]\",\n  \"prompt\": \"legacy\"\n}"
	if got.RequestBody != expectedRequestBody {
		t.Fatalf("request body was not precisely redacted while preserving JSON: %q", got.RequestBody)
	}
	if !strings.HasPrefix(got.ResponseBody, "失败原因: upstream rejected request\n\n原始返回:\n") {
		t.Fatalf("failure reason prefix missing: %q", got.ResponseBody)
	}
	if got.Error != "upstream rejected request" {
		t.Fatalf("normalized error = %q", got.Error)
	}
	if strings.Contains(got.Error, strings.Repeat("iVBORw0KGgo", 64)) {
		t.Fatal("legacy detail retained the error base64 payload")
	}
	if strings.Contains(got.ResponseBody, strings.Repeat("iVBORw0KGgo", 64)) {
		t.Fatal("legacy detail retained the truncated base64 payload")
	}
	if !strings.Contains(got.ResponseBody, "[redacted large base64/string]") {
		t.Fatalf("redaction placeholder missing: %q", got.ResponseBody)
	}

	after, err := os.ReadFile(file)
	if err != nil {
		t.Fatal(err)
	}
	if string(after) != string(before) {
		t.Fatal("reading legacy detail rewrote the log file")
	}
}

func aiLogAPIOnlyFile(t *testing.T) string {
	t.Helper()
	files, err := filepath.Glob(filepath.Join(config.Cfg.AILogDir, "ai-calls-*.log"))
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("log file count = %d, want 1", len(files))
	}
	return files[0]
}
