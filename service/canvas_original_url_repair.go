package service

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// RepairCanvasProjectOriginalURLs only replaces inline originalUrl copies backed by readable objects.
func RepairCanvasProjectOriginalURLs(project model.CanvasProject, apply bool) ([]CanvasMediaRepairReport, error) {
	data, reports, err := rewriteCanvasOriginalURLs(project, func(id string) (model.StorageObject, error) {
		object, err := repository.GetStorageObject(id)
		if err != nil {
			return object, err
		}
		if object.DeletedAt != "" {
			return object, fmt.Errorf("存储对象已删除")
		}
		result, err := DownloadStorageObject(id, "")
		if err != nil {
			return object, err
		}
		if result.Stream == nil {
			return object, fmt.Errorf("存储对象没有可读内容")
		}
		defer result.Stream.Close()
		if result.StatusCode != http.StatusOK {
			return object, fmt.Errorf("存储对象读取状态为 %d", result.StatusCode)
		}
		return object, verifyCanvasOriginalURLContent(object, result.Stream)
	})
	if err != nil || !apply || data == project.ProjectData {
		return reports, err
	}
	updatedAt := time.Now().UTC().Format(time.RFC3339Nano)
	var root map[string]json.RawMessage
	if err = json.Unmarshal([]byte(data), &root); err == nil {
		root["updatedAt"], _ = json.Marshal(updatedAt)
		var encoded []byte
		encoded, err = json.Marshal(root)
		if err == nil {
			err = repository.ReplaceCanvasProjectDataForMaintenance(project, string(encoded), updatedAt)
		}
	}
	for i := range reports {
		if reports[i].Status == "verified" {
			reports[i].Status = "persisted"
			if err != nil {
				reports[i].Status, reports[i].Reason = "failed", err.Error()
			}
		}
	}
	return reports, err
}

func verifyCanvasOriginalURLContent(object model.StorageObject, content io.Reader) error {
	if object.Bytes <= 0 || object.SHA256 == "" {
		return fmt.Errorf("存储对象缺少字节数或 SHA-256")
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(content, object.Bytes+1))
	if err != nil {
		return err
	}
	if count != object.Bytes || !strings.EqualFold(hex.EncodeToString(hash.Sum(nil)), object.SHA256) {
		return fmt.Errorf("存储对象字节数或 SHA-256 校验失败")
	}
	return nil
}

func verifyCanvasOriginalURLOwner(userID string, object model.StorageObject, source string) error {
	if object.CreatedBy == userID {
		return nil
	}
	comma := strings.IndexByte(source, ',')
	if !strings.HasPrefix(source, "data:") || comma < 0 || !strings.HasSuffix(strings.ToLower(source[:comma]), ";base64") {
		return fmt.Errorf("跨账号引用必须提供可校验的 Base64 originalUrl")
	}
	decoded := base64.NewDecoder(base64.StdEncoding, strings.NewReader(source[comma+1:]))
	if err := verifyCanvasOriginalURLContent(object, decoded); err != nil {
		return fmt.Errorf("跨账号 originalUrl 内容不等价或 Base64 无效：%w", err)
	}
	return nil
}

func rewriteCanvasOriginalURLs(project model.CanvasProject, resolve func(string) (model.StorageObject, error)) (string, []CanvasMediaRepairReport, error) {
	var root map[string]json.RawMessage
	if err := json.Unmarshal([]byte(project.ProjectData), &root); err != nil {
		return project.ProjectData, nil, err
	}
	var nodes []map[string]json.RawMessage
	if data := root["nodes"]; len(data) > 0 {
		if err := json.Unmarshal(data, &nodes); err != nil {
			return project.ProjectData, nil, err
		}
	}
	var reports []CanvasMediaRepairReport
	type resolvedObject struct {
		object model.StorageObject
		err    error
	}
	cache := map[string]resolvedObject{}
	resolveOnce := func(id string) (model.StorageObject, error) {
		if result, ok := cache[id]; ok {
			return result.object, result.err
		}
		object, err := resolve(id)
		cache[id] = resolvedObject{object, err}
		return object, err
	}
	changed := false
	for _, node := range nodes {
		var metadata map[string]json.RawMessage
		if json.Unmarshal(node["metadata"], &metadata) != nil || metadata == nil {
			continue
		}
		var originalURL, storageKey, nodeID string
		_ = json.Unmarshal(metadata["originalUrl"], &originalURL)
		_ = json.Unmarshal(metadata["storageKey"], &storageKey)
		_ = json.Unmarshal(node["id"], &nodeID)
		source := strings.TrimSpace(originalURL)
		if !strings.HasPrefix(source, "data:") && !strings.HasPrefix(source, "blob:") {
			continue
		}
		before := source
		if len(before) > 64 {
			before = before[:64] + "…"
		}
		report := CanvasMediaRepairReport{CanvasID: project.ID, NodeID: nodeID, Before: before, BeforeBytes: len(originalURL), Status: "failed"}
		storageKey = strings.TrimSpace(storageKey)
		objectID := strings.TrimSpace(strings.TrimPrefix(storageKey, "server:"))
		if !strings.HasPrefix(storageKey, "server:") || objectID == "" {
			report.Reason = "无 server: 持久化副本，保留 originalUrl"
		} else if object, err := resolveOnce(objectID); err != nil {
			report.ObjectID, report.Reason = objectID, err.Error()
		} else if object.ID != objectID || object.DeletedAt != "" {
			report.ObjectID, report.Reason = objectID, "存储对象 ID 不匹配或已删除"
		} else if err := verifyCanvasOriginalURLOwner(project.UserID, object, source); err != nil {
			report.ObjectID, report.Reason = objectID, err.Error()
		} else {
			report.ObjectID, report.Bytes, report.SHA256 = object.ID, object.Bytes, object.SHA256
			report.After = "/api/files/" + url.PathEscape(object.ID) + "/content"
			report.Status = "verified"
			metadata["originalUrl"], _ = json.Marshal(report.After)
			node["metadata"], _ = json.Marshal(metadata)
			changed = true
		}
		reports = append(reports, report)
	}
	if !changed {
		return project.ProjectData, reports, nil
	}
	root["nodes"], _ = json.Marshal(nodes)
	data, err := json.Marshal(root)
	return string(data), reports, err
}
