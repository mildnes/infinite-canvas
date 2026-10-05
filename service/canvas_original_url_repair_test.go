package service

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestVerifyCanvasOriginalURLContent(t *testing.T) {
	data := "stored-media"
	sum := sha256.Sum256([]byte(data))
	object := model.StorageObject{Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
	if err := verifyCanvasOriginalURLContent(object, strings.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	for _, invalid := range []string{"", data[:4], data + "extra", "wrong--media"} {
		if err := verifyCanvasOriginalURLContent(object, strings.NewReader(invalid)); err == nil {
			t.Fatal("unreadable, truncated or mismatched media must not permit migration")
		}
	}
	object.SHA256 = ""
	if err := verifyCanvasOriginalURLContent(object, strings.NewReader(data)); err == nil {
		t.Fatal("unverified object must not permit migration")
	}
}

func TestRewriteCanvasOriginalURLsPreservesMediaAndUnrelatedFields(t *testing.T) {
	project := model.CanvasProject{ID: "canvas", UserID: "owner", ProjectData: `{"nodes":[{"id":"image","type":"image","position":{"x":10,"y":20},"metadata":{"content":"/api/files/object/content","storageKey":"server:object","originalUrl":"data:image/png;base64,AAAA","status":"success","prompt":"keep","custom":9007199254740993}},{"id":"video","type":"video","metadata":{"content":"/api/files/object/content","storageKey":"server:object","originalUrl":"blob:old"}}],"connections":[{"fromNodeId":"image","toNodeId":"video"}],"chatSessions":[],"updatedAt":"old"}`}
	reads := 0
	resolve := func(id string) (model.StorageObject, error) {
		reads++
		return model.StorageObject{ID: id, CreatedBy: "owner", Bytes: 4, SHA256: "verified-hash"}, nil
	}
	data, reports, err := rewriteCanvasOriginalURLs(project, resolve)
	if err != nil || len(reports) != 2 || reads != 1 {
		t.Fatalf("reports=%+v reads=%d err=%v", reports, reads, err)
	}
	if strings.Contains(data, "data:") || strings.Contains(data, "blob:") || !strings.Contains(data, "9007199254740993") {
		t.Fatalf("inline media remained or an unrelated number changed: %s", data)
	}
	var before, after map[string]any
	_ = json.Unmarshal([]byte(project.ProjectData), &before)
	_ = json.Unmarshal([]byte(data), &after)
	for _, raw := range before["nodes"].([]any) {
		raw.(map[string]any)["metadata"].(map[string]any)["originalUrl"] = "/api/files/object/content"
	}
	wanted, _ := json.Marshal(before)
	actual, _ := json.Marshal(after)
	if string(wanted) != string(actual) {
		t.Fatalf("fields other than originalUrl changed: %s", data)
	}
	for _, report := range reports {
		if report.Status != "verified" || report.After != "/api/files/object/content" || report.CanvasID != "canvas" || report.ObjectID != "object" || report.BeforeBytes == 0 {
			t.Fatalf("unexpected report: %+v", report)
		}
	}
	repeated, reports, err := rewriteCanvasOriginalURLs(model.CanvasProject{UserID: "owner", ProjectData: data}, resolve)
	if err != nil || repeated != data || len(reports) != 0 || reads != 1 {
		t.Fatalf("rerun must be a no-op: reports=%+v reads=%d err=%v", reports, reads, err)
	}
}

func TestRewriteCanvasOriginalURLsIsolatesFailuresAndKeepsOriginals(t *testing.T) {
	project := model.CanvasProject{UserID: "owner", ProjectData: `{"nodes":[{"id":"missing-key","metadata":{"content":"keep-local","originalUrl":"data:image/png;base64,AAAA"}},{"id":"missing-object","metadata":{"content":"keep-missing","storageKey":"server:missing","originalUrl":"data:image/png;base64,BBBB"}},{"id":"foreign","metadata":{"storageKey":"server:foreign","originalUrl":"blob:foreign"}},{"id":"deleted","metadata":{"storageKey":"server:deleted","originalUrl":"blob:deleted"}},{"id":"valid","metadata":{"content":"keep-content","storageKey":"server:valid","originalUrl":"data:image/png;base64,CCCC"}},{"id":"remote","metadata":{"storageKey":"server:valid","originalUrl":"https://images.example/original.png"}}]}`}
	data, reports, err := rewriteCanvasOriginalURLs(project, func(id string) (model.StorageObject, error) {
		object := model.StorageObject{ID: id, CreatedBy: "owner"}
		switch id {
		case "missing":
			return object, fmt.Errorf("missing storage object")
		case "foreign":
			object.CreatedBy = "other-user"
		case "deleted":
			object.DeletedAt = "yesterday"
		}
		return object, nil
	})
	if err != nil || len(reports) != 5 {
		t.Fatalf("reports=%+v err=%v", reports, err)
	}
	for _, report := range reports[:4] {
		if report.Status != "failed" || report.Reason == "" || report.After != "" {
			t.Fatalf("unsafe source was changed: %+v", report)
		}
	}
	if reports[4].Status != "verified" || !strings.Contains(data, "data:image/png;base64,BBBB") || !strings.Contains(data, "keep-content") || !strings.Contains(data, "https://images.example/original.png") {
		t.Fatalf("failed or unrelated media were changed: %s", data)
	}
}

func TestRewriteCanvasOriginalURLsDoesNotDumpBase64InReports(t *testing.T) {
	original := "data:image/png;base64," + strings.Repeat("A", 8192)
	data, _ := json.Marshal(map[string]any{"nodes": []any{map[string]any{"id": "image", "metadata": map[string]any{"originalUrl": original}}}})
	project := model.CanvasProject{ProjectData: string(data)}
	unchanged, reports, err := rewriteCanvasOriginalURLs(project, func(string) (model.StorageObject, error) {
		t.Fatal("a node without server key must not trigger a read or upload")
		return model.StorageObject{}, nil
	})
	if err != nil || unchanged != project.ProjectData || len(reports) != 1 || reports[0].BeforeBytes != len(original) || len(reports[0].Before) > 80 {
		t.Fatalf("unsafe report: %+v, %v", reports, err)
	}
}
