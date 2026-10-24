package router

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gin-gonic/gin"
	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func canvasSummaryFixture(t *testing.T) (http.Handler, string) {
	t.Helper()
	config.Cfg.StorageDriver = "sqlite"
	config.Cfg.DatabaseDSN = filepath.Join(t.TempDir(), "canvas-summary.db")
	config.Cfg.JWTSecret = "canvas-summary-test-secret"
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := database.Create(&model.User{
		ID: "owner", Username: "owner", AffCode: "owner",
		Role: model.UserRoleUser, Status: model.UserStatusActive,
	}).Error; err != nil {
		t.Fatal(err)
	}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"userId": "owner", "exp": time.Now().Add(time.Hour).Unix(),
	}).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	gin.SetMode(gin.TestMode)
	gin.DefaultWriter = io.Discard
	return New(), token
}

func canvasSummarySubprocess(t *testing.T, name string) bool {
	t.Helper()
	if os.Getenv("IC_CANVAS_SUMMARY_TEST") == name {
		return false
	}
	command := exec.Command(os.Args[0], "-test.run=^"+name+"$", "-test.v")
	command.Env = append(os.Environ(), "IC_CANVAS_SUMMARY_TEST="+name)
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("isolated canvas summary fixture: %v\n%s", err, output)
	}
	t.Logf("%s", output)
	return true
}

func canvasSummaryRequest(t *testing.T, router http.Handler, token, path, encoding string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, path, nil)
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("Accept-Encoding", encoding)
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func canvasSummaryRows(t *testing.T, response *httptest.ResponseRecorder) []map[string]json.RawMessage {
	t.Helper()
	var body struct {
		Code int                          `json:"code"`
		Data []map[string]json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.Code != 0 {
		t.Fatalf("list response: status=%d err=%v body=%s", response.Code, err, response.Body)
	}
	return body.Data
}

func TestCanvasProjectSummaryReadRoutes(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	database, _ := repository.DB()
	const oldID = "00000000-0000-4000-8000-000000000001"
	const newID = "00000000-0000-4000-8000-000000000002"
	if err := database.Create(&model.StorageObjectAlias{OldID: oldID, NewID: newID}).Error; err != nil {
		t.Fatal(err)
	}
	const older = `{"id":"older","title":"较早画布","createdAt":"2026-01-01T00:00:00Z","updatedAt":"2026-01-02T00:00:00Z","nodes":[{"id":"n1","image":"server:` + oldID + `"},{"id":"n2","custom":9007199254740993}],"connections":[{"from":"n1","to":"n2"}],"chatSessions":[{"id":"s1"},{"id":"s2"},{"id":"s3"}],"viewport":{"x":12,"y":34,"zoom":0.7},"custom":"完整字段"}`
	const newer = `{"id":"newer","createdAt":"2026-01-03T00:00:00Z","updatedAt":"2026-01-04T00:00:00Z","nodes":null,"connections":[],"chatSessions":[],"custom":"没有标题"}`
	for _, project := range []model.CanvasProject{
		{UserID: "owner", ID: "older", ProjectData: older, CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z"},
		{UserID: "owner", ID: "newer", ProjectData: newer, CreatedAt: "2026-01-03T00:00:00Z", UpdatedAt: "2026-01-04T00:00:00Z"},
		{UserID: "owner", ID: "deleted", ProjectData: `{"id":"deleted"}`, UpdatedAt: "2026-01-06T00:00:00Z", DeletedAt: "2026-01-06T00:00:00Z"},
		{UserID: "foreign", ID: "foreign-only", ProjectData: `{"id":"foreign-only"}`, UpdatedAt: "2026-01-07T00:00:00Z"},
		{UserID: "foreign", ID: "older", ProjectData: `{"id":"older","title":"另一个账号的同名ID"}`, UpdatedAt: "2026-01-08T00:00:00Z"},
	} {
		if err := database.Create(&project).Error; err != nil {
			t.Fatal(err)
		}
	}
	fullResponse := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects", "")
	expected := `{"code":0,"data":[` + newer + `,` + strings.ReplaceAll(older, oldID, newID) + `],"msg":"ok"}` + "\n"
	t.Run("default complete response remains byte identical", func(t *testing.T) {
		if fullResponse.Code != http.StatusOK || fullResponse.Body.String() != expected {
			t.Fatalf("default list bytes changed:\ngot  %s\nwant %s", fullResponse.Body, expected)
		}
		otherQuery := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects?summary=0", "")
		if !bytes.Equal(otherQuery.Body.Bytes(), fullResponse.Body.Bytes()) {
			t.Fatal("summary=0 changed the complete response")
		}
	})
	full := canvasSummaryRows(t, fullResponse)
	t.Run("summary has exactly seven fields and matching count order timestamps", func(t *testing.T) {
		summary := canvasSummaryRows(t, canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects?summary=1", ""))
		if len(summary) != len(full) || len(summary) != 2 {
			t.Fatalf("list counts differ: summary=%d full=%d", len(summary), len(full))
		}
		keys := []string{"id", "title", "createdAt", "updatedAt", "nodeCount", "connectionCount", "sessionCount"}
		for index, row := range summary {
			if len(row) != len(keys) {
				t.Errorf("summary %d has %d fields, want 7", index, len(row))
			}
			for _, key := range keys {
				if _, ok := row[key]; !ok {
					t.Errorf("summary %d missing %s", index, key)
				}
			}
			for _, key := range []string{"id", "createdAt", "updatedAt"} {
				if !bytes.Equal(row[key], full[index][key]) {
					t.Errorf("summary %d %s differs from complete list", index, key)
				}
			}
		}
		if string(summary[0]["title"]) != `"未命名画布"` {
			t.Errorf("missing title fallback = %s", summary[0]["title"])
		}
		for key, count := range map[string]string{"nodeCount": "2", "connectionCount": "1", "sessionCount": "3"} {
			if string(summary[1][key]) != count || string(summary[0][key]) != "0" {
				t.Errorf("%s: older=%s newer=%s", key, summary[1][key], summary[0][key])
			}
		}
	})
	t.Run("single project equals complete list element including aliases", func(t *testing.T) {
		response := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects/older", "")
		raw, err := json.Marshal(full[1])
		if err != nil {
			t.Fatal(err)
		}
		want := `{"code":0,"data":` + string(raw) + `,"msg":"ok"}` + "\n"
		if response.Code != http.StatusOK || response.Body.String() != want {
			t.Errorf("single project: status=%d body=%s", response.Code, response.Body)
		}
	})
	t.Run("missing foreign and soft deleted projects share the same 404", func(t *testing.T) {
		var previous []byte
		for _, id := range []string{"absent", "foreign-only", "deleted"} {
			response := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects/"+id, "")
			var body struct {
				Code int             `json:"code"`
				Data json.RawMessage `json:"data"`
				Msg  string          `json:"msg"`
			}
			if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusNotFound || body.Code != 1 || string(body.Data) != "null" || body.Msg != "画布不存在" {
				t.Errorf("%s: status=%d err=%v body=%s", id, response.Code, err, response.Body)
			}
			if previous != nil && !bytes.Equal(previous, response.Body.Bytes()) {
				t.Errorf("%s exposes a different not found response", id)
			}
			previous = bytes.Clone(response.Body.Bytes())
		}
	})
	t.Run("single and summary require authentication", func(t *testing.T) {
		for _, path := range []string{"/api/v1/canvas/projects/older", "/api/v1/canvas/projects?summary=1"} {
			if response := canvasSummaryRequest(t, router, "", path, ""); response.Code != http.StatusUnauthorized {
				t.Errorf("%s status=%d, want 401", path, response.Code)
			}
		}
	})
}

func TestCanvasProjectSummarySyntheticPerformance(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	database, _ := repository.DB()
	totalBytes, totalRunes := 0, 0
	for index := 0; index < 23; index++ {
		raw, err := json.Marshal(map[string]any{
			"id": fmt.Sprintf("synthetic-%02d", index), "title": fmt.Sprintf("合成画布 %02d", index),
			"createdAt": "2026-01-01T00:00:00Z", "updatedAt": fmt.Sprintf("2026-01-%02dT00:00:00Z", index+1),
			"nodes":       []any{map[string]any{"id": "n1", "text": strings.Repeat("画", 101000), "image": strings.Repeat("a", 156700)}},
			"connections": []any{}, "chatSessions": []any{map[string]any{"id": "s1"}},
		})
		if err != nil {
			t.Fatal(err)
		}
		totalBytes += len(raw)
		totalRunes += utf8.RuneCount(raw)
		if err := database.Create(&model.CanvasProject{
			UserID: "owner", ID: fmt.Sprintf("synthetic-%02d", index), ProjectData: string(raw),
			CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: fmt.Sprintf("2026-01-%02dT00:00:00Z", index+1),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	plain := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects?summary=1", "")
	rows := canvasSummaryRows(t, plain)
	if len(rows) != 23 {
		t.Fatalf("synthetic summary returned %d rows, want 23", len(rows))
	}
	if len(rows[0]) != 7 {
		t.Fatalf("synthetic summary returned %d fields, want 7", len(rows[0]))
	}
	compressed := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects?summary=1", "gzip")
	if compressed.Header().Get("Content-Encoding") != "gzip" {
		t.Fatal("summary gzip was not enabled")
	}
	reader, err := gzip.NewReader(bytes.NewReader(compressed.Body.Bytes()))
	if err != nil {
		t.Fatal(err)
	}
	decompressed, err := io.ReadAll(reader)
	_ = reader.Close()
	if err != nil || !bytes.Equal(decompressed, plain.Body.Bytes()) {
		t.Fatalf("summary gzip changed response bytes: %v", err)
	}
	const samples = 25
	for _, encoding := range []string{"", "gzip"} {
		durations := make([]time.Duration, samples)
		for index := range durations {
			start := time.Now()
			response := canvasSummaryRequest(t, router, token, "/api/v1/canvas/projects?summary=1", encoding)
			durations[index] = time.Since(start)
			expected := plain
			if encoding == "gzip" {
				expected = compressed
			}
			if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), expected.Body.Bytes()) {
				t.Fatal("performance request changed summary")
			}
		}
		slices.Sort(durations)
		p95 := durations[(samples*95+99)/100-1]
		t.Logf("SYNTHETIC ONLY, not production data: projects=23 stored_bytes=%d JSON_characters=%d summary_plain_bytes=%d summary_gzip_bytes=%d encoding=%q samples=%d p95=%s",
			totalBytes, totalRunes, plain.Body.Len(), compressed.Body.Len(), encoding, samples, p95)
	}
}
