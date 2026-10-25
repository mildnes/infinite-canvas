package router

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestCanvasImageResultRecoveryRoutes(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	database, _ := repository.DB()
	if err := database.Create(&model.User{ID: "other", Username: "other", AffCode: "other", Role: model.UserRoleUser, Status: model.UserStatusActive}).Error; err != nil {
		t.Fatal(err)
	}
	foreignToken, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{"userId": "other", "exp": time.Now().Add(time.Hour).Unix()}).SignedString([]byte(config.Cfg.JWTSecret))
	if err != nil {
		t.Fatal(err)
	}
	old := time.Now().UTC().Add(-20 * time.Minute).Format(time.RFC3339Nano)
	task := model.CanvasImageTask{ID: "same-task", UserID: "owner", Source: "canvas", SourceID: "board", NodeID: "node", Status: "processing", CreatedAt: old}
	if err := database.Create(&task).Error; err != nil {
		t.Fatal(err)
	}
	task.Status = "completed"
	task.ImageURL = "/api/files/object/content"
	task.StorageKey = "server:object"
	task.CompletedAt = old
	task.Width = 3840
	task.Height = 2160
	if _, err := repository.UpdateCanvasImageTask(task); err != nil {
		t.Fatal(err)
	}
	if err := repository.DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
		t.Fatal(err)
	}
	call := func(method, path, body, auth string) *httptest.ResponseRecorder {
		req := httptest.NewRequest(method, path, strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+auth)
		res := httptest.NewRecorder()
		router.ServeHTTP(res, req)
		return res
	}
	got := call("GET", "/api/v1/canvas/image-tasks/same-task", "", token)
	if got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatalf("GET archive: %d %s", got.Code, got.Body)
	}
	if got := call("GET", "/api/v1/canvas/image-tasks/same-task", "", foreignToken); got.Code != 404 {
		t.Fatalf("foreign GET=%d", got.Code)
	}
	if got := call("POST", "/api/v1/canvas/image-tasks/status", `{"ids":["same-task"]}`, token); got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatal("batch lookup cannot restore archive")
	}
	if got := call("POST", "/api/v1/canvas/image-tasks/status", `{"ids":["same-task"]}`, foreignToken); got.Code != 200 || bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatal("foreign batch leaked archive")
	}
	const body = `{"baseUpdatedAt":"","data":{"id":"board","createdAt":"old","updatedAt":"old","nodes":[{"id":"node","type":"image","position":{"x":4176,"y":8112},"width":420,"height":236,"metadata":{"status":"error","taskPollError":true,"imageTaskId":"same-task","content":""}}],"connections":[]}}`
	got = call("POST", "/api/v1/canvas/projects", body, token)
	if got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatalf("save recovery: %d %s", got.Code, got.Body)
	}
	var saved struct{ Data map[string]json.RawMessage }
	if err := json.Unmarshal(got.Body.Bytes(), &saved); err != nil {
		t.Fatal(err)
	}
	if got := call("POST", "/api/v1/canvas/projects", body, token); got.Code != http.StatusConflict {
		t.Fatal("recovery bypassed optimistic-lock conflict")
	}
	if got := call("GET", "/api/v1/canvas/projects/board", "", token); got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatal("restored result not persisted")
	}
	// Missing old snapshot replay with the current version must not remove a proven result.
	var version string
	_ = json.Unmarshal(saved.Data["updatedAt"], &version)
	retry := strings.Replace(body, `"baseUpdatedAt":""`, `"baseUpdatedAt":"`+version+`"`, 1)
	if got := call("POST", "/api/v1/canvas/projects", retry, token); got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatal("same-task stale replay lost completed result")
	}
	// Re-submitting an archived client id returns the same result without creating a paid task.
	if got := call("POST", "/api/v1/canvas/image-tasks", `{"clientTaskId":"same-task","requestBody":{"model":"ignored"}}`, token); got.Code != 200 || !bytes.Contains(got.Body.Bytes(), []byte(task.ImageURL)) {
		t.Fatalf("idempotent archive submit: %d %s", got.Code, got.Body)
	}
	if got := call("DELETE", "/api/v1/canvas/image-tasks/same-task", "", foreignToken); got.Code != 200 {
		t.Fatal("foreign delete request failed")
	}
	if got := call("GET", "/api/v1/canvas/image-tasks/same-task", "", token); got.Code != 200 {
		t.Fatal("foreign delete removed owner archive")
	}
	if got := call("DELETE", "/api/v1/canvas/image-tasks/same-task", "", token); got.Code != 200 {
		t.Fatal("owner explicit delete failed")
	}
	if got := call("GET", "/api/v1/canvas/image-tasks/same-task", "", token); got.Code != 404 {
		t.Fatalf("explicitly deleted result was resurrected: %d %s", got.Code, got.Body)
	}
	t.Log("PASS real HTTP: retention→GET/batch owner recovery, foreign 404/empty, old node save→readback, CAS conflict, stale same-task replay, idempotent submit, explicit-delete isolation")
}
