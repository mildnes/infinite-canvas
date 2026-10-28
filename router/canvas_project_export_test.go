package router

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func canvasExportRequest(router http.Handler, method, token, path string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(method, path, nil)
	if token != "" {
		request.Header.Set("Authorization", "Bearer "+token)
	}
	request.Header.Set("Accept-Encoding", "gzip")
	response := httptest.NewRecorder()
	router.ServeHTTP(response, request)
	return response
}

func canvasExportTicket(t *testing.T, router http.Handler, token, id string) string {
	t.Helper()
	response := canvasExportRequest(router, http.MethodPost, token, "/api/v1/canvas/projects/"+url.PathEscape(id)+"/export")
	var body struct {
		Code int `json:"code"`
		Data struct {
			Mode      string    `json:"mode"`
			URL       string    `json:"url"`
			ExpiresAt time.Time `json:"expiresAt"`
		} `json:"data"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.Code != 0 {
		t.Fatalf("export ticket status=%d err=%v body=%s", response.Code, err, response.Body)
	}
	if body.Data.Mode != "server" {
		t.Fatalf("cloud-only export mode=%q, want server; body=%s", body.Data.Mode, response.Body)
	}
	link, err := url.Parse(body.Data.URL)
	if err != nil || link.Host != "" || link.Path != "/api/v1/canvas/projects/"+id+"/export" || link.Query().Get("ticket") == "" {
		t.Fatalf("invalid native-download URL: %q (%v)", body.Data.URL, err)
	}
	remaining := time.Until(body.Data.ExpiresAt)
	if remaining < 4*time.Minute+50*time.Second || remaining > 5*time.Minute+time.Second {
		t.Fatalf("ticket expiry is %s away, want five minutes", remaining)
	}
	return body.Data.URL
}

func canvasExportZip(t *testing.T, response *httptest.ResponseRecorder) ([]*zip.File, map[string][]byte) {
	t.Helper()
	if response.Code != http.StatusOK || response.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("export download status=%d headers=%v body=%s", response.Code, response.Header(), response.Body)
	}
	if response.Header().Get("Content-Length") != "" || response.Header().Get("Content-Encoding") != "" {
		t.Fatalf("streaming ZIP must not declare Content-Length or gzip: %v", response.Header())
	}
	archive, err := zip.NewReader(bytes.NewReader(response.Body.Bytes()), int64(response.Body.Len()))
	if err != nil {
		t.Fatalf("invalid ZIP: %v", err)
	}
	if len(archive.File) == 0 || archive.File[0].Name != "projects.json" {
		t.Fatal("projects.json must be the first ZIP entry")
	}
	files := make(map[string][]byte, len(archive.File))
	for _, file := range archive.File {
		if _, duplicate := files[file.Name]; duplicate {
			t.Fatalf("duplicate ZIP entry: %s", file.Name)
		}
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		_ = reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		files[file.Name] = data
	}
	return archive.File, files
}

func canvasExportProject(t *testing.T, owner, id, title string, fields map[string]any, deleted bool) {
	t.Helper()
	fields["id"], fields["title"] = id, title
	fields["createdAt"], fields["updatedAt"] = "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"
	raw, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	project := model.CanvasProject{
		UserID: owner, ID: id, ProjectData: string(raw),
		CreatedAt: "2026-01-01T00:00:00Z", UpdatedAt: "2026-01-02T00:00:00Z",
	}
	if deleted {
		project.DeletedAt = "2026-01-03T00:00:00Z"
	}
	database, _ := repository.DB()
	if err := database.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
}

func canvasExportObject(t *testing.T, id, owner, mimeType, extension string, content []byte, readable bool) {
	t.Helper()
	checksum := sha256.Sum256(content)
	object := model.StorageObject{
		ID: id, ProviderID: "local-generated", ObjectKey: id + "." + extension,
		CreatedBy: owner, MimeType: mimeType, Bytes: int64(len(content)),
		SHA256: hex.EncodeToString(checksum[:]), CreatedAt: "2026-01-01T00:00:00Z",
	}
	database, _ := repository.DB()
	if err := database.Create(&object).Error; err != nil {
		t.Fatal(err)
	}
	if readable {
		if err := os.MkdirAll(service.GeneratedMediaDir(), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(service.GeneratedMediaDir(), object.ObjectKey), content, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCanvasProjectExportLocalMediaRoutes(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	canvasExportProject(t, "owner", "mixed-local-board", "包含本地媒体", map[string]any{
		"nodes": []any{
			map[string]any{"metadata": map[string]any{"storageKey": "image:local-image"}},
			map[string]any{"metadata": map[string]any{"storageKey": "video:local-video"}},
			map[string]any{"metadata": map[string]any{"storageKey": "server:cloud-object"}},
		},
		"chatSessions": []any{map[string]any{"messages": []any{map[string]any{
			"references": []any{map[string]any{"storageKey": "image:local-image"}, map[string]any{"storageKey": "audio:chat-audio"}},
		}}}},
	}, false)
	response := canvasExportRequest(router, http.MethodPost, token, "/api/v1/canvas/projects/mixed-local-board/export")
	var body struct {
		Code int                        `json:"code"`
		Data map[string]json.RawMessage `json:"data"`
		Msg  string                     `json:"msg"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil || response.Code != http.StatusOK || body.Code != 0 || body.Msg != "ok" {
		t.Fatalf("browser export response status=%d err=%v body=%s", response.Code, err, response.Body)
	}
	if len(body.Data) != 2 || string(body.Data["mode"]) != `"browser"` || string(body.Data["localAssetCount"]) != "3" {
		t.Fatalf("local media must return browser mode with a deduplicated count and no ticket: %s", response.Body)
	}
	if response.Header().Get("Cache-Control") != "no-store" {
		t.Fatalf("browser export response must not be cached: %v", response.Header())
	}
}

func TestCanvasProjectExportRoutes(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	const projectID = "export-board"
	const firstID = "10000000-0000-4000-8000-000000000001"
	const secondID = "10000000-0000-4000-8000-000000000002"
	const chatID = "10000000-0000-4000-8000-000000000003"
	const foreignID = "10000000-0000-4000-8000-000000000004"
	const deletedID = "10000000-0000-4000-8000-000000000005"
	const unreadableID = "10000000-0000-4000-8000-000000000006"
	const absentID = "10000000-0000-4000-8000-000000000007"
	first, second, chat := []byte("first PNG bytes"), []byte("second JPEG bytes"), []byte("chat WebM bytes")
	canvasExportObject(t, firstID, "owner", "image/png", "png", first, true)
	canvasExportObject(t, secondID, "owner", "image/jpeg", "jpg", second, true)
	canvasExportObject(t, chatID, "owner", "video/webm", "webm", chat, true)
	canvasExportObject(t, deletedID, "owner", "image/png", "png", []byte("deleted"), true)
	canvasExportObject(t, unreadableID, "owner", "image/png", "png", []byte("file absent"), false)
	database, _ := repository.DB()
	if err := database.Model(&model.StorageObject{}).Where("id = ?", deletedID).Update("deleted_at", "2026-01-03T00:00:00Z").Error; err != nil {
		t.Fatal(err)
	}
	var foreignReads atomic.Int32
	foreignServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		foreignReads.Add(1)
		_, _ = w.Write([]byte("must not read this private file"))
	}))
	defer foreignServer.Close()
	// Permit this isolated probe endpoint so an authorization regression would
	// reach it instead of being hidden by the normal SSRF network restriction.
	proxyClient := service.SafeProxyHTTPClient()
	previousTransport := proxyClient.Transport
	proxyClient.Transport = foreignServer.Client().Transport
	t.Cleanup(func() { proxyClient.Transport = previousTransport })
	if err := database.Create(&model.StorageObject{
		ID: foreignID, ProviderID: "unconfigured", ObjectKey: "foreign-private",
		CreatedBy: "foreign", MimeType: "image/png", Bytes: 31, PublicURL: foreignServer.URL,
	}).Error; err != nil {
		t.Fatal(err)
	}
	canvasExportProject(t, "owner", projectID, `测试/画板:*?"<>|`, map[string]any{
		"nodes": []any{
			map[string]any{"id": "root", "metadata": map[string]any{"storageKey": "server:" + firstID, "isBatchRoot": true, "batchChildIds": []string{"child"}}},
			map[string]any{"id": "child", "metadata": map[string]any{"storageKey": "server:" + secondID, "batchRootId": "root"}},
			map[string]any{"id": "duplicate", "metadata": map[string]any{"storageKey": "server:" + firstID}},
			map[string]any{"id": "foreign", "metadata": map[string]any{"storageKey": "server:" + foreignID}},
			map[string]any{"id": "deleted", "metadata": map[string]any{"storageKey": "server:" + deletedID}},
			map[string]any{"id": "unreadable", "metadata": map[string]any{"storageKey": "server:" + unreadableID}},
			map[string]any{"id": "absent", "metadata": map[string]any{"storageKey": "server:" + absentID}},
		},
		"connections":  []any{map[string]any{"from": "root", "to": "child"}},
		"chatSessions": []any{map[string]any{"id": "session", "messages": []any{map[string]any{"references": []any{map[string]any{"storageKey": "server:" + chatID}}}}}},
		"viewport":     map[string]any{"x": 10, "y": 20, "k": 0.7},
	}, false)
	canvasExportProject(t, "owner", "empty-board", "无云端素材", map[string]any{"nodes": []any{}, "connections": []any{}, "chatSessions": []any{}}, false)
	canvasExportProject(t, "foreign", "foreign-board", "他人画板", map[string]any{"nodes": []any{}}, false)
	canvasExportProject(t, "owner", "deleted-board", "已删画板", map[string]any{"nodes": []any{}}, true)

	t.Run("ticket endpoint requires login and hides foreign deleted missing boards", func(t *testing.T) {
		path := "/api/v1/canvas/projects/" + projectID + "/export"
		if response := canvasExportRequest(router, http.MethodPost, "", path); response.Code != http.StatusUnauthorized {
			t.Fatalf("anonymous ticket status=%d, want 401", response.Code)
		}
		var previous string
		for _, id := range []string{"foreign-board", "deleted-board", "missing-board"} {
			response := canvasExportRequest(router, http.MethodPost, token, "/api/v1/canvas/projects/"+id+"/export")
			if response.Code != http.StatusNotFound {
				t.Fatalf("%s ticket status=%d, want 404; body=%s", id, response.Code, response.Body)
			}
			if previous != "" && response.Body.String() != previous {
				t.Fatalf("%s leaks a distinct not-found response", id)
			}
			previous = response.Body.String()
		}
	})
	t.Run("native download streams compatible v3 ZIP and omits unauthorized missing objects", func(t *testing.T) {
		link := canvasExportTicket(t, router, token, projectID)
		response := canvasExportRequest(router, http.MethodGet, "", link)
		entries, files := canvasExportZip(t, response)
		disposition, params, err := mime.ParseMediaType(response.Header().Get("Content-Disposition"))
		if err != nil || disposition != "attachment" || !strings.HasSuffix(params["filename"], ".zip") || strings.ContainsAny(params["filename"], `/\:*?"<>|`) {
			t.Fatalf("unsafe attachment filename: %q (%v)", response.Header().Get("Content-Disposition"), err)
		}
		var manifest struct {
			App        string `json:"app"`
			Version    int    `json:"version"`
			ExportedAt string `json:"exportedAt"`
			Projects   []struct {
				Project map[string]json.RawMessage `json:"project"`
				Files   []struct {
					StorageKey string `json:"storageKey"`
					Path       string `json:"path"`
					MimeType   string `json:"mimeType"`
					Bytes      int64  `json:"bytes"`
				} `json:"files"`
			} `json:"projects"`
		}
		if err := json.Unmarshal(files["projects.json"], &manifest); err != nil {
			t.Fatal(err)
		}
		if manifest.App != "infinite-canvas" || manifest.Version != 3 || len(manifest.Projects) != 1 {
			t.Fatalf("incompatible manifest: app=%q version=%d projects=%d", manifest.App, manifest.Version, len(manifest.Projects))
		}
		if _, err := time.Parse(time.RFC3339Nano, manifest.ExportedAt); err != nil {
			t.Fatalf("invalid exportedAt %q: %v", manifest.ExportedAt, err)
		}
		for key, want := range map[string]string{"id": `"` + projectID + `"`, "createdAt": `"2026-01-01T00:00:00Z"`, "updatedAt": `"2026-01-02T00:00:00Z"`} {
			if string(manifest.Projects[0].Project[key]) != want {
				t.Errorf("manifest project %s=%s want %s", key, manifest.Projects[0].Project[key], want)
			}
		}
		for key := range map[string]bool{"nodes": true, "connections": true, "chatSessions": true, "viewport": true} {
			if len(manifest.Projects[0].Project[key]) == 0 {
				t.Errorf("manifest dropped project field %s", key)
			}
		}
		expected := map[string][]byte{firstID: first, secondID: second, chatID: chat}
		found := map[string]bool{}
		for _, asset := range manifest.Projects[0].Files {
			id := strings.TrimPrefix(asset.StorageKey, "server:")
			content, present := expected[id]
			if !present {
				if _, leaked := files[asset.Path]; leaked {
					t.Errorf("missing or foreign asset included: %s", asset.StorageKey)
				}
				continue
			}
			ext := map[string]string{firstID: "png", secondID: "jpg", chatID: "webm"}[id]
			wantPath := "projects/" + projectID + "/files/" + id + "." + ext
			if asset.Path != wantPath || asset.Bytes != int64(len(content)) || asset.MimeType == "" {
				t.Errorf("asset manifest mismatch: %+v", asset)
			}
			if !bytes.Equal(files[wantPath], content) || sha256.Sum256(files[wantPath]) != sha256.Sum256(content) {
				t.Errorf("exported bytes differ for %s", id)
			}
			if found[id] {
				t.Errorf("duplicate manifest object: %s", id)
			}
			found[id] = true
		}
		if len(found) != len(expected) {
			t.Fatalf("exported %d readable objects, want %d", len(found), len(expected))
		}
		if len(entries) != 5 {
			t.Errorf("ZIP has %d entries, want projects.json + 3 assets + missing.json", len(entries))
		}
		var missing []struct {
			StorageKey string `json:"storageKey"`
			Reason     string `json:"reason"`
		}
		if err := json.Unmarshal(files["missing.json"], &missing); err != nil {
			t.Fatalf("missing.json: %v", err)
		}
		missingKeys := map[string]bool{}
		for _, asset := range missing {
			if asset.Reason == "" {
				t.Errorf("missing reason empty for %s", asset.StorageKey)
			}
			missingKeys[asset.StorageKey] = true
		}
		for _, id := range []string{foreignID, deletedID, unreadableID, absentID} {
			if !missingKeys["server:"+id] {
				t.Errorf("missing.json omitted server:%s", id)
			}
		}
		if foreignReads.Load() != 0 {
			t.Errorf("foreign object was opened %d times", foreignReads.Load())
		}
		if bytes.Contains(files["projects.json"], []byte("data:")) || bytes.Contains(files["projects.json"], []byte("base64,")) {
			t.Error("manifest contains inline media")
		}
		if replay := canvasExportRequest(router, http.MethodGet, "", link); replay.Code != http.StatusForbidden {
			t.Errorf("replayed ticket status=%d, want 403", replay.Code)
		}
	})
	t.Run("invalid expired mismatched and login JWT tickets are forbidden", func(t *testing.T) {
		link := canvasExportTicket(t, router, token, projectID)
		parsed, _ := url.Parse(link)
		validTicket := parsed.Query().Get("ticket")
		expired, err := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
			"sub": "owner", "projectId": projectID, "aud": "canvas-export", "jti": "expired-test-ticket",
			"iat": time.Now().Add(-6 * time.Minute).Unix(), "exp": time.Now().Add(-time.Minute).Unix(),
		}).SignedString([]byte(config.Cfg.JWTSecret))
		if err != nil {
			t.Fatal(err)
		}
		for name, path := range map[string]string{
			"missing":     "/api/v1/canvas/projects/" + projectID + "/export",
			"malformed":   "/api/v1/canvas/projects/" + projectID + "/export?ticket=invalid",
			"tampered":    link + "tampered",
			"expired":     "/api/v1/canvas/projects/" + projectID + "/export?ticket=" + url.QueryEscape(expired),
			"wrong board": "/api/v1/canvas/projects/empty-board/export?ticket=" + url.QueryEscape(validTicket),
			"login JWT":   "/api/v1/canvas/projects/" + projectID + "/export?ticket=" + url.QueryEscape(token),
		} {
			response := canvasExportRequest(router, http.MethodGet, "", path)
			if response.Code != http.StatusForbidden {
				t.Errorf("%s status=%d, want 403; body=%s", name, response.Code, response.Body)
			}
		}
	})
	t.Run("small board without server media contains only projects json", func(t *testing.T) {
		link := canvasExportTicket(t, router, token, "empty-board")
		entries, files := canvasExportZip(t, canvasExportRequest(router, http.MethodGet, "", link))
		if len(entries) != 1 || len(files) != 1 {
			t.Fatalf("empty-media export has %d entries, want only projects.json", len(entries))
		}
	})
	t.Run("ticket cannot access a project soft deleted after issuance", func(t *testing.T) {
		link := canvasExportTicket(t, router, token, "empty-board")
		if err := database.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ?", "owner", "empty-board").Update("deleted_at", "2026-01-03T00:00:00Z").Error; err != nil {
			t.Fatal(err)
		}
		if response := canvasExportRequest(router, http.MethodGet, "", link); response.Code != http.StatusNotFound {
			t.Fatalf("soft-deleted download status=%d, want 404; body=%s", response.Code, response.Body)
		}
	})
}

func TestCanvasProjectExport178Objects(t *testing.T) {
	if canvasSummarySubprocess(t, t.Name()) {
		return
	}
	router, token := canvasSummaryFixture(t)
	nodes := make([]any, 178)
	expected := make(map[string][sha256.Size]byte, len(nodes))
	for index := range nodes {
		id := fmt.Sprintf("20000000-0000-4000-8000-%012d", index)
		content := []byte(strings.Repeat(fmt.Sprintf("synthetic-object-%03d;", index), 23))
		canvasExportObject(t, id, "owner", "image/png", "png", content, true)
		nodes[index] = map[string]any{"id": fmt.Sprintf("node-%d", index), "metadata": map[string]any{"storageKey": "server:" + id}}
		expected["projects/large-board/files/"+id+".png"] = sha256.Sum256(content)
	}
	canvasExportProject(t, "owner", "large-board", "178 个合成对象", map[string]any{"nodes": nodes, "connections": []any{}, "chatSessions": []any{}}, false)
	link := canvasExportTicket(t, router, token, "large-board")
	entries, files := canvasExportZip(t, canvasExportRequest(router, http.MethodGet, "", link))
	if len(entries) != 179 {
		t.Fatalf("exported %d entries, want projects.json + 178 objects", len(entries))
	}
	for path, checksum := range expected {
		if got, ok := files[path]; !ok || sha256.Sum256(got) != checksum {
			t.Fatalf("object missing or SHA-256 differs: %s", path)
		}
	}
	t.Log("synthetic 178-object ZIP: all 178 source SHA-256 hashes match; not a 1.33 GB production/RSS test")
}
