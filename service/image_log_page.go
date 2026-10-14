package service

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/repository"
)

type ImageLogPage struct {
	Items      []json.RawMessage `json:"items"`
	NextCursor string            `json:"nextCursor"`
}

type imageLogCursor struct {
	CreatedAt string `json:"createdAt"`
	ID        string `json:"id"`
}

func CurrentUserImageGenerationLogPage(ctx context.Context, limit int, cursor string) (ImageLogPage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return ImageLogPage{}, errors.New("请先登录")
	}
	if limit <= 0 || limit > 40 {
		limit = 40
	}
	position := imageLogCursor{}
	if cursor != "" {
		data, err := base64.RawURLEncoding.DecodeString(cursor)
		if err != nil || json.Unmarshal(data, &position) != nil || position.CreatedAt == "" || position.ID == "" {
			return ImageLogPage{}, errors.New("历史记录分页参数无效")
		}
	}
	if err := migrateUserImageGenerationLogs(user.ID); err != nil {
		return ImageLogPage{}, err
	}
	logs, err := repository.PageImageGenerationLogs(user.ID, position.CreatedAt, position.ID, limit+1)
	if err != nil {
		return ImageLogPage{}, err
	}
	more := len(logs) > limit
	if more {
		logs = logs[:limit]
	}
	page := ImageLogPage{Items: make([]json.RawMessage, 0, len(logs))}
	for _, log := range logs {
		page.Items = append(page.Items, json.RawMessage(log.SummaryJSON))
	}
	if more && len(logs) > 0 {
		last := logs[len(logs)-1]
		data, _ := json.Marshal(imageLogCursor{CreatedAt: last.CreatedAt, ID: last.ID})
		page.NextCursor = base64.RawURLEncoding.EncodeToString(data)
	}
	return page, nil
}

func CurrentUserImageGenerationLog(ctx context.Context, id string) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}
	log, err := repository.GetImageGenerationLog(user.ID, strings.TrimSpace(id))
	return json.RawMessage(log.PayloadJSON), err
}

// The list representation deliberately contains no inline image or request bodies.
// Full legacy payloads remain available through the detail endpoint.
func imageGenerationSummary(raw json.RawMessage) string {
	var record map[string]any
	if json.Unmarshal(raw, &record) != nil || record == nil {
		return ""
	}
	fields := []string{"id", "createdAt", "title", "prompt", "time", "model", "config", "references", "durationMs", "successCount", "failCount", "imageCount", "size", "quality", "status", "images", "errors", "categoryIds", "workflowId", "workflowName", "workflowTaskId", "providerWorkflowRef", "lastPolledAt"}
	summary := make(map[string]any, len(fields)+2)
	for _, key := range fields {
		if value, ok := record[key]; ok {
			summary[key] = compactImageLogValue(value)
		}
	}
	if task, ok := record["task"].(map[string]any); ok {
		fields := []string{"id", "parent_task_id", "source", "source_id", "node_id", "channelId", "userChannelId", "status", "progress", "url", "image_url", "image_urls", "storageKey", "width", "height", "mimeType", "bytes", "started_at", "startedAt", "created_at", "createdAt", "completed_at", "error", "error_detail"}
		shortTask := make(map[string]any, len(fields))
		for _, key := range fields {
			if value, ok := task[key]; ok {
				shortTask[key] = compactImageLogValue(value)
			}
		}
		summary["task"] = shortTask
	}
	if images, ok := summary["images"].([]any); ok {
		thumbnails := make([]string, 0, len(images))
		for _, item := range images {
			image, ok := item.(map[string]any)
			if !ok {
				continue
			}
			key, _ := image["storageKey"].(string)
			url, _ := image["dataUrl"].(string)
			if url == "" {
				url, _ = image["url"].(string)
			}
			if url == "" && strings.HasPrefix(key, "server:") && !strings.HasPrefix(key, "server:webdav:") {
				url = "/api/files/" + strings.TrimPrefix(key, "server:") + "/content"
			}
			image["dataUrl"] = url
			thumbnails = append(thumbnails, url)
		}
		summary["thumbnails"] = thumbnails
	}
	if references, ok := summary["references"].([]any); ok {
		for _, item := range references {
			reference, ok := item.(map[string]any)
			if !ok {
				continue
			}
			key, _ := reference["storageKey"].(string)
			url, _ := reference["dataUrl"].(string)
			if url == "" && strings.HasPrefix(key, "server:") && !strings.HasPrefix(key, "server:webdav:") {
				reference["dataUrl"] = "/api/files/" + strings.TrimPrefix(key, "server:") + "/content"
			}
		}
	}
	data, err := json.Marshal(summary)
	if err != nil {
		return ""
	}
	return string(data)
}

func compactImageLogValue(value any) any {
	switch current := value.(type) {
	case string:
		if len(current) > 8192 || strings.HasPrefix(current, "data:") || strings.HasPrefix(current, "blob:") {
			return ""
		}
		return current
	case []any:
		result := make([]any, len(current))
		for i, item := range current {
			result[i] = compactImageLogValue(item)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(current))
		for key, item := range current {
			if key == "response_body" || key == "responseBody" || key == "request_body" || key == "requestBody" || key == "errorDetails" {
				continue
			}
			result[key] = compactImageLogValue(item)
		}
		return result
	default:
		return value
	}
}

type ImageLogSummaryBackfill struct {
	Inspected  int    `json:"inspected"`
	Updated    int    `json:"updated"`
	NextCursor string `json:"nextCursor"`
}

func BackfillImageLogSummaries(after string, limit int, apply bool) (ImageLogSummaryBackfill, error) {
	if limit < 1 || limit > 100 {
		return ImageLogSummaryBackfill{}, errors.New("批量大小应在 1–100 之间")
	}
	logs, err := repository.ListImageLogsForSummary(after, limit)
	if err != nil {
		return ImageLogSummaryBackfill{}, err
	}
	result := ImageLogSummaryBackfill{}
	for _, log := range logs {
		result.Inspected++
		result.NextCursor = log.ID
		summary := imageGenerationSummary(json.RawMessage(log.PayloadJSON))
		if summary == "" {
			continue
		}
		if apply {
			if err := repository.SaveImageGenerationSummary(log.UserID, log.ID, summary); err != nil {
				return result, err
			}
			result.Updated++
		}
	}
	return result, nil
}
