package service

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/repository"
)

// Only rewrite an inline copy after both bytes and readability match an
// existing object. Unknown or unverifiable content is left untouched.
func compactImageLogOriginalURLs(userID string, raw json.RawMessage) json.RawMessage {
	var record map[string]json.RawMessage
	if json.Unmarshal(raw, &record) != nil {
		return raw
	}
	var task map[string]json.RawMessage
	if json.Unmarshal(record["task"], &task) != nil {
		return raw
	}
	changed := false
	resolved := map[string]string{}
	replace := func(source string) string {
		if cached, ok := resolved[source]; ok {
			return cached
		}
		resolved[source] = source
		comma := strings.IndexByte(source, ',')
		if !strings.HasPrefix(source, "data:") || comma < 0 || !strings.HasSuffix(strings.ToLower(source[:comma]), ";base64") {
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
				resolved[source] = "/api/files/" + url.PathEscape(object.ID) + "/content"
				return resolved[source]
			}
		}
		return source
	}
	var original string
	if json.Unmarshal(task["originalUrl"], &original) == nil {
		if next := replace(original); next != original {
			task["originalUrl"], _ = json.Marshal(next)
			changed = true
		}
	}
	var originals []json.RawMessage
	if json.Unmarshal(task["originalUrls"], &originals) == nil {
		arrayChanged := false
		for i, value := range originals {
			var original string
			if json.Unmarshal(value, &original) != nil {
				continue
			}
			if next := replace(original); next != original {
				originals[i], _ = json.Marshal(next)
				arrayChanged = true
			}
		}
		if arrayChanged {
			task["originalUrls"], _ = json.Marshal(originals)
			changed = true
		}
	}
	if !changed {
		return raw
	}
	record["task"], _ = json.Marshal(task)
	encoded, err := json.Marshal(record)
	if err != nil {
		return raw
	}
	return encoded
}
