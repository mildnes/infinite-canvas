package service

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type CanvasMediaRepairReport struct {
	CanvasID    string `json:"canvasId"`
	NodeID      string `json:"nodeId"`
	OriginalURL string `json:"originalUrl,omitempty"`
	Before      string `json:"before,omitempty"`
	BeforeBytes int    `json:"beforeBytes,omitempty"`
	After       string `json:"after,omitempty"`
	ObjectID    string `json:"objectId,omitempty"`
	Bytes       int64  `json:"bytes,omitempty"`
	SHA256      string `json:"sha256,omitempty"`
	Status      string `json:"status"`
	Reason      string `json:"reason,omitempty"`
}

func RepairCanvasProjectMedia(ctx context.Context, project model.CanvasProject, apply bool) ([]CanvasMediaRepairReport, error) {
	var root map[string]any
	if err := json.Unmarshal([]byte(project.ProjectData), &root); err != nil {
		return nil, err
	}
	reports := make([]CanvasMediaRepairReport, 0)
	if nodes, ok := root["nodes"].([]any); ok {
		for _, rawNode := range nodes {
			node, _ := rawNode.(map[string]any)
			metadata, _ := node["metadata"].(map[string]any)
			nodeType, _ := node["type"].(string)
			if metadata == nil || !isCanvasMediaNodeType(nodeType) || repairStringValue(metadata["storageKey"]) != "" {
				continue
			}
			repairCanvasMediaMap(ctx, project, repairStringValue(node["id"]), metadata, "content", apply, &reports)
		}
	}
	if sessions, ok := root["chatSessions"].([]any); ok {
		for sessionIndex, rawSession := range sessions {
			session, _ := rawSession.(map[string]any)
			messages, _ := session["messages"].([]any)
			for messageIndex, rawMessage := range messages {
				message, _ := rawMessage.(map[string]any)
				for _, field := range []string{"images", "references"} {
					items, _ := message[field].([]any)
					for itemIndex, rawItem := range items {
						item, _ := rawItem.(map[string]any)
						if item == nil || repairStringValue(item["storageKey"]) != "" {
							continue
						}
						key := "dataUrl"
						if repairStringValue(item[key]) == "" {
							key = "url"
						}
						id := fmt.Sprintf("session:%d:message:%d:%s:%d", sessionIndex, messageIndex, field, itemIndex)
						repairCanvasMediaMap(ctx, project, id, item, key, apply, &reports)
					}
				}
			}
		}
	}
	if apply && len(reports) > 0 {
		updatedAt := time.Now().UTC().Format(time.RFC3339Nano)
		root["updatedAt"] = updatedAt
		data, err := json.Marshal(root)
		if err != nil {
			return reports, err
		}
		project.ProjectData = string(data)
		project.UpdatedAt = updatedAt
		if _, err := repository.SaveUserCanvasProject(project); err != nil {
			return reports, err
		}
	}
	return reports, nil
}

func repairCanvasMediaMap(ctx context.Context, project model.CanvasProject, nodeID string, value map[string]any, urlKey string, apply bool, reports *[]CanvasMediaRepairReport) {
	source := strings.TrimSpace(repairStringValue(value[urlKey]))
	if !isRepairableGeneratedURL(source) {
		return
	}
	report := CanvasMediaRepairReport{CanvasID: project.ID, NodeID: nodeID, OriginalURL: source}
	payload, err := ReadTrustedGeneratedMedia(ctx, source)
	if err != nil {
		report.Status, report.Reason = "failed", err.Error()
		if apply {
			value["originalUrl"] = source
			value["mediaStatus"] = "broken"
			value["mediaError"] = err.Error()
		}
		*reports = append(*reports, report)
		return
	}
	report.Bytes, report.SHA256 = int64(len(payload.Data)), payload.SHA256
	report.ObjectID = GeneratedMediaObjectID(project.UserID, payload.SHA256)
	report.Status = "verified"
	if apply {
		stored, saveErr := SaveGeneratedMediaDeduplicated(project.UserID, payload.MimeType, payload.Data, payload.SourceURL)
		if saveErr != nil {
			report.Status, report.Reason = "failed", saveErr.Error()
			value["originalUrl"] = source
			value["mediaStatus"] = "broken"
			value["mediaError"] = saveErr.Error()
		} else {
			report.Status = "persisted"
			report.ObjectID = stored.ID
			value[urlKey] = stored.URL
			value["storageKey"] = stored.StorageKey
			value["mimeType"] = stored.MimeType
			value["bytes"] = stored.Bytes
			value["originalUrl"] = source
			value["mediaStatus"] = "ok"
			delete(value, "mediaError")
			_ = SyncGeneratedMediaForUser(ctx, project.UserID, stored.ID)
		}
	}
	*reports = append(*reports, report)
}

func isCanvasMediaNodeType(value string) bool {
	switch strings.ToLower(strings.TrimSpace(value)) {
	case "image", "panorama", "video", "audio":
		return true
	default:
		return false
	}
}

func isRepairableGeneratedURL(value string) bool {
	value = strings.TrimSpace(value)
	return strings.HasPrefix(value, "/api/proxy-image?") || strings.HasPrefix(value, "https://") || strings.HasPrefix(value, "http://")
}

func repairStringValue(value any) string {
	text, _ := value.(string)
	return strings.TrimSpace(text)
}
