package handler

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestAIAdminAICallLogListOmitsBodyFields(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	service.SaveAICallLog(service.AICallLogInput{
		UserID:       "list-user",
		Endpoint:     "/images/generations",
		Method:       "POST",
		Model:        "gpt-image-2",
		Status:       200,
		RequestBody:  `{"prompt":"summary"}`,
		ResponseBody: `{"data":[]}`,
		Error:        "should not be listed",
	})

	result := httptest.NewRecorder()
	AdminAICallLogs(result, httptest.NewRequest(http.MethodGet, "/api/admin/ai-logs?page=1&pageSize=20", nil))
	if result.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", result.Code, result.Body)
	}

	var body struct {
		Code int `json:"code"`
		Data struct {
			Items []map[string]json.RawMessage `json:"items"`
			Total int                          `json:"total"`
		} `json:"data"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	if body.Code != 0 || body.Data.Total != 1 || len(body.Data.Items) != 1 {
		t.Fatalf("unexpected list response: %s", result.Body)
	}
	for _, field := range []string{"requestBody", "responseBody", "error"} {
		if _, ok := body.Data.Items[0][field]; ok {
			t.Fatalf("list item contains %q: %s", field, result.Body)
		}
	}
	for _, field := range []string{"id", "createdAt", "userId", "userDisplayName", "endpoint", "method", "model", "channelId", "channelName", "status", "durationMs", "credits"} {
		if _, ok := body.Data.Items[0][field]; !ok {
			t.Fatalf("list item missing %q: %s", field, result.Body)
		}
	}
}

func TestAIAdminAICallLogDetailAndMissing(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	service.SaveAICallLog(service.AICallLogInput{
		UserID:          "detail-user",
		UserDisplayName: "Detail User",
		Endpoint:        "/responses",
		Method:          "POST",
		Model:           "gpt-image-2",
		ChannelID:       "channel-1",
		ChannelName:     "Fixture Channel",
		Status:          502,
		DurationMs:      321,
		Credits:         1.25,
		RequestBody:     `{"prompt":"detail"}`,
		ResponseBody:    `{"error":{"message":"upstream failed"},"request_id":"fixture"}`,
		Error:           `{"error":{"message":"upstream failed"}}`,
	})
	list, err := service.ListAICallLogs(model.Query{Page: 1, PageSize: 20})
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Items) != 1 {
		t.Fatalf("list count = %d, want 1", len(list.Items))
	}

	result := httptest.NewRecorder()
	AdminAICallLog(result, httptest.NewRequest(http.MethodGet, "/api/admin/ai-logs/"+list.Items[0].ID, nil), list.Items[0].ID)
	if result.Code != http.StatusOK {
		t.Fatalf("status = %d, body=%s", result.Code, result.Body)
	}
	var detail struct {
		Code int             `json:"code"`
		Data model.AICallLog `json:"data"`
	}
	if err := json.Unmarshal(result.Body.Bytes(), &detail); err != nil {
		t.Fatal(err)
	}
	if detail.Code != 0 {
		t.Fatalf("unexpected detail response: %s", result.Body)
	}
	const expectedResponseBody = "失败原因: upstream failed\n\n原始返回:\n{\n  \"error\": {\n    \"message\": \"upstream failed\"\n  },\n  \"request_id\": \"fixture\"\n}"
	expected := model.AICallLog{
		ID:              list.Items[0].ID,
		UserID:          "detail-user",
		UserDisplayName: "Detail User",
		Endpoint:        "/responses",
		Method:          "POST",
		Model:           "gpt-image-2",
		ChannelID:       "channel-1",
		ChannelName:     "Fixture Channel",
		Status:          502,
		DurationMs:      321,
		Credits:         1.25,
		RequestBody:     "{\n  \"prompt\": \"detail\"\n}",
		ResponseBody:    expectedResponseBody,
		Error:           "upstream failed",
		CreatedAt:       list.Items[0].CreatedAt,
	}
	if detail.Data != expected {
		t.Fatalf("detail = %#v, want %#v", detail.Data, expected)
	}

	logFiles, err := filepath.Glob(filepath.Join(config.Cfg.AILogDir, "ai-calls-*.log"))
	if err != nil || len(logFiles) != 1 {
		t.Fatalf("log files: %v, count=%d", err, len(logFiles))
	}
	if err := os.Remove(logFiles[0]); err != nil {
		t.Fatal(err)
	}
	deleted := httptest.NewRecorder()
	AdminAICallLog(deleted, httptest.NewRequest(http.MethodGet, "/api/admin/ai-logs/"+list.Items[0].ID, nil), list.Items[0].ID)
	if deleted.Code != http.StatusNotFound {
		t.Fatalf("deleted status = %d, body=%s", deleted.Code, deleted.Body)
	}
	var deletedBody response
	if err := json.Unmarshal(deleted.Body.Bytes(), &deletedBody); err != nil {
		t.Fatal(err)
	}
	if deletedBody.Code != 1 || deletedBody.Data != nil || deletedBody.Msg != "AI 调用日志不存在" {
		t.Fatalf("deleted response = %s", deleted.Body)
	}

	missing := httptest.NewRecorder()
	AdminAICallLog(missing, httptest.NewRequest(http.MethodGet, "/api/admin/ai-logs/missing", nil), "missing")
	if missing.Code != http.StatusNotFound {
		t.Fatalf("missing status = %d, body=%s", missing.Code, missing.Body)
	}
	var notFound response
	if err := json.Unmarshal(missing.Body.Bytes(), &notFound); err != nil {
		t.Fatal(err)
	}
	if notFound.Code != 1 || notFound.Data != nil || notFound.Msg != "AI 调用日志不存在" {
		t.Fatalf("missing response = %s", missing.Body)
	}
}
