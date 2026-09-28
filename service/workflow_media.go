package service

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"path"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const workflowResultMediaLimit int64 = 128 << 20

// PersistWorkflowResultMedia downloads one trusted workflow result into the
// durable local-generated store. Callers can then expose the returned short
// URL, instead of retaining a provider URL that may expire.
func PersistWorkflowResultMedia(ctx context.Context, userID, raw string) (UploadedStorageObject, error) {
	return persistWorkflowResultMedia(ctx, userID, raw, "")
}

// PersistWorkflowResultMediaStable applies a task-scoped key so a retry after
// a response timeout reuses the same local object instead of creating a
// duplicate orphan.
func PersistWorkflowResultMediaStable(ctx context.Context, userID, raw, stableKey string) (UploadedStorageObject, error) {
	return persistWorkflowResultMedia(ctx, userID, raw, stableKey)
}

func persistWorkflowResultMedia(ctx context.Context, userID, raw, stableKey string) (UploadedStorageObject, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return UploadedStorageObject{}, errors.New("工作流媒体缺少用户")
	}
	data, mimeType, err := readWorkflowResultMedia(ctx, raw)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	if strings.TrimSpace(stableKey) != "" {
		return SaveGeneratedMediaStable(userID, mimeType, data, stableKey)
	}
	return SaveGeneratedMedia(userID, mimeType, data)
}

func storedWorkflowResultMedia(raw, ownerID string) (UploadedStorageObject, bool, error) {
	objectID, referenced := workflowStoredMediaID(raw)
	if !referenced {
		return UploadedStorageObject{}, false, nil
	}
	if objectID == "" {
		return UploadedStorageObject{}, true, errors.New("存储对象引用无效")
	}
	object, err := StorageObjectInfo(objectID)
	if err != nil {
		return UploadedStorageObject{}, true, err
	}
	if object.CreatedBy == "" || object.CreatedBy != strings.TrimSpace(ownerID) || object.DeletedAt != "" {
		return UploadedStorageObject{}, true, errors.New("存储对象不属于当前任务用户")
	}
	return UploadedStorageObject{
		ID: object.ID, URL: "/api/files/" + object.ID + "/content", StorageKey: "server:" + object.ID,
		Bytes: object.Bytes, MimeType: object.MimeType, Width: object.Width, Height: object.Height,
	}, true, nil
}

func workflowStoredMediaID(raw string) (string, bool) {
	raw = strings.TrimSpace(raw)
	if strings.HasPrefix(raw, "server:") {
		id := strings.TrimSpace(strings.TrimPrefix(raw, "server:"))
		if id == "" || strings.ContainsAny(id, ":/\\") {
			return "", true
		}
		return id, true
	}
	if !strings.HasPrefix(raw, "/api/files/") {
		return "", false
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.RawQuery != "" || parsed.Fragment != "" || !strings.HasSuffix(parsed.Path, "/content") {
		return "", true
	}
	id := strings.TrimSuffix(strings.TrimPrefix(parsed.Path, "/api/files/"), "/content")
	id, err = url.PathUnescape(id)
	if err != nil || id == "" || strings.ContainsAny(id, "/\\:") {
		return "", true
	}
	return id, true
}

// SyncGeneratedMediaForUser supplies the authenticated account context needed
// by global storage selection when a background workflow has no HTTP request.
// Cloud upload errors are returned while the local object remains intact.
func SyncGeneratedMediaForUser(ctx context.Context, userID, objectID string) error {
	user, found, err := repository.GetUserByID(strings.TrimSpace(userID))
	if err != nil {
		return err
	}
	if !found {
		return errors.New("工作流媒体用户不存在")
	}
	return SyncGeneratedMedia(WithUser(ctx, model.PublicUser(user)), objectID)
}

func readWorkflowResultMedia(ctx context.Context, raw string) ([]byte, string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, "", errors.New("工作流没有返回媒体地址")
	}
	if strings.HasPrefix(raw, "data:") {
		comma := strings.IndexByte(raw, ',')
		if comma <= len("data:") {
			return nil, "", errors.New("工作流媒体 data URL 无效")
		}
		header := strings.TrimPrefix(raw[:comma], "data:")
		parts := strings.Split(header, ";")
		mimeType := strings.TrimSpace(parts[0])
		if mimeType == "" || !isWorkflowResultMIME(mimeType) {
			return nil, "", errors.New("工作流媒体类型不受支持")
		}
		encoded := strings.TrimSpace(raw[comma+1:])
		if int64(len(encoded)) > (workflowResultMediaLimit*4/3)+16 {
			return nil, "", errors.New("工作流媒体超过 128MB")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) == 0 || int64(len(data)) > workflowResultMediaLimit {
			return nil, "", errors.New("工作流媒体编码无效或超过 128MB")
		}
		return data, mimeType, nil
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme != "https" || parsed.Hostname() == "" || parsed.User != nil || len(raw) > 4096 {
		return nil, "", errors.New("工作流结果只接受 HTTPS 地址")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return nil, "", err
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return nil, "", errors.New("工作流结果下载失败")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return nil, "", fmt.Errorf("工作流结果下载失败 HTTP %d", response.StatusCode)
	}
	if response.ContentLength > workflowResultMediaLimit {
		return nil, "", errors.New("工作流结果超过 128MB")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, workflowResultMediaLimit+1))
	if err != nil || len(data) == 0 || int64(len(data)) > workflowResultMediaLimit {
		return nil, "", errors.New("工作流结果读取失败或超过 128MB")
	}
	mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = workflowResultMIMEFromPath(parsed.Path)
	}
	if mimeType == "" || !isWorkflowResultMIME(mimeType) {
		mimeType = strings.TrimSpace(http.DetectContentType(data))
	}
	if !isWorkflowResultMIME(mimeType) {
		return nil, "", errors.New("工作流结果媒体类型不受支持")
	}
	return data, mimeType, nil
}

func isWorkflowResultMIME(value string) bool {
	value = strings.ToLower(strings.TrimSpace(strings.Split(value, ";")[0]))
	switch value {
	case "image/png", "image/jpeg", "image/webp", "image/gif",
		"video/mp4", "video/webm", "video/quicktime",
		"audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/aac", "audio/mp4", "audio/x-m4a":
		return true
	default:
		return false
	}
}

func workflowResultMIMEFromPath(value string) string {
	switch strings.ToLower(path.Ext(value)) {
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".webp":
		return "image/webp"
	case ".gif":
		return "image/gif"
	case ".mp4":
		return "video/mp4"
	case ".webm":
		return "video/webm"
	case ".mov":
		return "video/quicktime"
	case ".mp3":
		return "audio/mpeg"
	case ".wav":
		return "audio/wav"
	case ".ogg":
		return "audio/ogg"
	case ".m4a":
		return "audio/mp4"
	default:
		return ""
	}
}
