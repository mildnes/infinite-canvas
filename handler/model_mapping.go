package handler

import (
	"bytes"
	"encoding/json"
	"io"
	"log"
	"mime"
	"mime/multipart"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func upstreamAIModel(channel model.ModelChannel, localModel string) string {
	upstream := service.ResolveUpstreamModelName(channel, localModel)
	if upstream != localModel {
		log.Printf("AI model mapping: channel=%s local=%q upstream=%q", channel.ID, localModel, upstream)
	}
	return upstream
}

// Only existing top-level model fields are changed. Unmapped requests retain
// their exact bytes, and multipart file bytes and headers are copied intact.
func rewriteAIRequestModel(body []byte, contentType, localModel, upstreamModel string) ([]byte, error) {
	if localModel == upstreamModel {
		return body, nil
	}
	if !strings.HasPrefix(strings.ToLower(contentType), "multipart/form-data") {
		var payload map[string]json.RawMessage
		if json.Unmarshal(body, &payload) != nil || payload["model"] == nil {
			return body, nil
		}
		var value string
		if !bytes.HasPrefix(bytes.TrimSpace(payload["model"]), []byte{'"'}) || json.Unmarshal(payload["model"], &value) != nil {
			return body, nil
		}
		payload["model"], _ = json.Marshal(upstreamModel)
		return json.Marshal(payload)
	}
	_, params, err := mime.ParseMediaType(contentType)
	if err != nil {
		return nil, err
	}
	reader := multipart.NewReader(bytes.NewReader(body), params["boundary"])
	var buffer bytes.Buffer
	writer := multipart.NewWriter(&buffer)
	if err := writer.SetBoundary(params["boundary"]); err != nil {
		return nil, err
	}
	changed := false
	for {
		part, err := reader.NextRawPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, err
		}
		destination, err := writer.CreatePart(part.Header)
		if err != nil {
			return nil, err
		}
		if part.FormName() == "model" && part.FileName() == "" {
			_, err = io.WriteString(destination, upstreamModel)
			changed = true
		} else {
			_, err = io.Copy(destination, part)
		}
		part.Close()
		if err != nil {
			return nil, err
		}
	}
	if err := writer.Close(); err != nil {
		return nil, err
	}
	if !changed {
		return body, nil
	}
	return buffer.Bytes(), nil
}

func rewriteAIQueryModel(path, localModel, upstreamModel string) string {
	if localModel == upstreamModel {
		return path
	}
	parsed, err := url.Parse(path)
	if err != nil {
		return path
	}
	query := parsed.Query()
	if query.Get("model") != localModel {
		return path
	}
	query.Set("model", upstreamModel)
	parsed.RawQuery = query.Encode()
	return parsed.String()
}
