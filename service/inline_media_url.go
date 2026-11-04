package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/repository"
)

func NormalizeInlineMediaURL(userID, source string, storageKey ...string) (string, error) {
	if !strings.HasPrefix(source, "data:") {
		return source, nil
	}
	if len(storageKey) > 0 {
		key := strings.TrimSpace(storageKey[0])
		if strings.HasPrefix(key, "server:") && strings.TrimPrefix(key, "server:") != "" {
			return key, nil
		}
		return "", errors.New("内联媒体没有持久化存储引用")
	}
	comma := strings.IndexByte(source, ',')
	if comma < 0 || !strings.HasSuffix(strings.ToLower(source[:comma]), ";base64") {
		return "", errors.New("内联媒体 data URL 无效")
	}
	content, err := base64.StdEncoding.DecodeString(source[comma+1:])
	if err != nil || len(content) == 0 {
		return "", errors.New("内联媒体 Base64 无效")
	}
	hash := sha256.Sum256(content)
	objects, err := repository.ListStorageObjectsByFingerprintAnyOwner(hex.EncodeToString(hash[:]), int64(len(content)))
	if err != nil {
		return "", err
	}
	for _, object := range objects {
		if verifyCanvasOriginalURLContent(object, bytes.NewReader(content)) != nil || verifyCanvasOriginalURLOwner(userID, object, source) != nil {
			continue
		}
		download, err := DownloadStorageObject(object.ID, "")
		if err != nil || download.Stream == nil {
			continue
		}
		verified := download.StatusCode == http.StatusOK && verifyCanvasOriginalURLContent(object, download.Stream) == nil
		_ = download.Stream.Close()
		if verified {
			return "server:" + object.ID, nil
		}
	}
	return "", errors.New("内联媒体没有可校验的持久化副本")
}

// CompactInlineMediaURL only reuses an existing verified object and never uploads.
func CompactInlineMediaURL(userID, source string) string {
	if !strings.HasPrefix(source, "data:") {
		return source
	}
	comma := strings.IndexByte(source, ',')
	if comma < 0 || !strings.HasSuffix(strings.ToLower(source[:comma]), ";base64") {
		return source
	}
	content, err := base64.StdEncoding.DecodeString(source[comma+1:])
	if err != nil || len(content) == 0 {
		return source
	}
	hash := sha256.Sum256(content)
	objects, err := repository.ListStorageObjectsByFingerprintAnyOwner(hex.EncodeToString(hash[:]), int64(len(content)))
	if err != nil {
		return source
	}
	for _, object := range objects {
		if verifyCanvasOriginalURLContent(object, bytes.NewReader(content)) != nil || verifyCanvasOriginalURLOwner(userID, object, source) != nil {
			continue
		}
		download, err := DownloadStorageObject(object.ID, "")
		if err != nil || download.Stream == nil {
			continue
		}
		verified := download.StatusCode == http.StatusOK && verifyCanvasOriginalURLContent(object, download.Stream) == nil
		_ = download.Stream.Close()
		if verified {
			return "/api/files/" + url.PathEscape(object.ID) + "/content"
		}
	}
	return source
}
