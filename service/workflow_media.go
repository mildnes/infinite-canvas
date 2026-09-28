package service

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
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

type GeneratedMediaPayload struct {
	Data      []byte
	MimeType  string
	SourceURL string
	SHA256    string
}

// PersistWorkflowResultMedia downloads one trusted workflow result into the
// durable local-generated store. Callers can then expose the returned short
// URL, instead of retaining a provider URL that may expire.
func PersistWorkflowResultMedia(ctx context.Context, userID, raw string) (UploadedStorageObject, error) {
	return persistWorkflowResultMedia(ctx, userID, raw, "")
}

// PersistWorkflowResultMediaStable keeps the existing task-oriented API while
// using the result bytes as the durable deduplication key.
func PersistWorkflowResultMediaStable(ctx context.Context, userID, raw, stableKey string) (UploadedStorageObject, error) {
	return persistWorkflowResultMedia(ctx, userID, raw, stableKey)
}

func persistWorkflowResultMedia(ctx context.Context, userID, raw, stableKey string) (UploadedStorageObject, error) {
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return UploadedStorageObject{}, errors.New("工作流媒体缺少用户")
	}
	if stored, referenced, err := storedWorkflowResultMedia(raw, userID); referenced {
		return stored, err
	}
	payload, err := ReadTrustedGeneratedMedia(ctx, raw)
	if err != nil {
		return UploadedStorageObject{}, err
	}
	return SaveGeneratedMediaDeduplicated(userID, payload.MimeType, payload.Data, payload.SourceURL)
}

// PersistTrustedGeneratedMedia materializes a verified channel/workflow result
// before callers expose it as successful. The returned URL is always local and stable.
func PersistTrustedGeneratedMedia(ctx context.Context, userID, raw string) (UploadedStorageObject, error) {
	return persistWorkflowResultMedia(ctx, userID, raw, "")
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

func ReadTrustedGeneratedMedia(ctx context.Context, raw string) (GeneratedMediaPayload, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return GeneratedMediaPayload{}, errors.New("生成结果没有返回媒体地址")
	}
	if strings.HasPrefix(raw, "data:") {
		comma := strings.IndexByte(raw, ',')
		if comma <= len("data:") {
			return GeneratedMediaPayload{}, errors.New("生成媒体 data URL 无效")
		}
		header := strings.TrimPrefix(raw[:comma], "data:")
		parts := strings.Split(header, ";")
		mimeType := strings.TrimSpace(parts[0])
		if mimeType == "" || !isWorkflowResultMIME(mimeType) {
			return GeneratedMediaPayload{}, errors.New("生成媒体类型不受支持")
		}
		encoded := strings.TrimSpace(raw[comma+1:])
		if int64(len(encoded)) > (workflowResultMediaLimit*4/3)+16 {
			return GeneratedMediaPayload{}, errors.New("生成媒体超过 128MB")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) == 0 || int64(len(data)) > workflowResultMediaLimit {
			return GeneratedMediaPayload{}, errors.New("生成媒体编码无效或超过 128MB")
		}
		if err := ValidateGeneratedMediaBytes(data, mimeType); err != nil {
			return GeneratedMediaPayload{}, err
		}
		return generatedMediaPayload(data, mimeType, ""), nil
	}
	if strings.HasPrefix(raw, "/api/proxy-image?") {
		var unwrapErr error
		raw, unwrapErr = UnwrapGeneratedMediaSourceURL(raw)
		if unwrapErr != nil {
			return GeneratedMediaPayload{}, unwrapErr
		}
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Hostname() == "" || parsed.User != nil || len(raw) > 4096 {
		return GeneratedMediaPayload{}, errors.New("生成结果只接受 HTTP(S) 地址")
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, parsed.String(), nil)
	if err != nil {
		return GeneratedMediaPayload{}, err
	}
	response, err := SafeProxyHTTPClient().Do(request)
	if err != nil {
		return GeneratedMediaPayload{}, errors.New("生成结果下载失败")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return GeneratedMediaPayload{}, fmt.Errorf("生成结果下载失败 HTTP %d", response.StatusCode)
	}
	if response.ContentLength > workflowResultMediaLimit {
		return GeneratedMediaPayload{}, errors.New("生成结果超过 128MB")
	}
	data, err := io.ReadAll(io.LimitReader(response.Body, workflowResultMediaLimit+1))
	if err != nil || len(data) == 0 || int64(len(data)) > workflowResultMediaLimit {
		return GeneratedMediaPayload{}, errors.New("生成结果读取失败或超过 128MB")
	}
	mimeType := strings.TrimSpace(strings.Split(response.Header.Get("Content-Type"), ";")[0])
	if mimeType == "" || mimeType == "application/octet-stream" {
		mimeType = workflowResultMIMEFromPath(parsed.Path)
	}
	if mimeType == "" || !isWorkflowResultMIME(mimeType) {
		mimeType = strings.TrimSpace(http.DetectContentType(data))
	}
	if !isWorkflowResultMIME(mimeType) {
		return GeneratedMediaPayload{}, errors.New("生成结果媒体类型不受支持")
	}
	if err := ValidateGeneratedMediaBytes(data, mimeType); err != nil {
		return GeneratedMediaPayload{}, err
	}
	return generatedMediaPayload(data, mimeType, parsed.String()), nil
}

func UnwrapGeneratedMediaSourceURL(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if !strings.HasPrefix(raw, "/api/proxy-image?") {
		return raw, nil
	}
	proxyURL, err := url.Parse(raw)
	if err != nil || proxyURL.Path != "/api/proxy-image" {
		return "", errors.New("生成媒体代理地址无效")
	}
	source := strings.TrimSpace(proxyURL.Query().Get("url"))
	if source == "" {
		return "", errors.New("生成媒体代理地址缺少原始 URL")
	}
	return source, nil
}

func ValidateGeneratedMediaBytes(data []byte, declared string) error {
	detected := strings.ToLower(strings.TrimSpace(strings.Split(http.DetectContentType(data), ";")[0]))
	if strings.HasPrefix(detected, "text/") || detected == "application/json" || detected == "application/xml" {
		return errors.New("生成结果不是可读取的媒体文件")
	}
	declaredMajor := strings.SplitN(strings.ToLower(declared), "/", 2)[0]
	if isWorkflowResultMIME(detected) && !strings.HasPrefix(detected, declaredMajor+"/") {
		return errors.New("生成结果媒体类型校验失败")
	}
	return nil
}

func generatedMediaPayload(data []byte, mimeType, sourceURL string) GeneratedMediaPayload {
	sum := sha256.Sum256(data)
	return GeneratedMediaPayload{Data: data, MimeType: mimeType, SourceURL: sourceURL, SHA256: hex.EncodeToString(sum[:])}
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

func IsSupportedGeneratedMediaMIME(value string) bool {
	return isWorkflowResultMIME(value)
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
