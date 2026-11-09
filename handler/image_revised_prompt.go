package handler

import (
	"encoding/json"
	"strings"
)

func appendImageRevisedPromptMetadata(requestBody string, response []byte) string {
	var payload struct {
		Data []struct {
			RevisedPrompt any `json:"revised_prompt"`
		} `json:"data"`
	}
	if json.Unmarshal(response, &payload) != nil || len(payload.Data) == 0 {
		return requestBody
	}
	revised, ok := payload.Data[0].RevisedPrompt.(string)
	if !ok || strings.TrimSpace(revised) == "" {
		return requestBody
	}
	var metadata map[string]json.RawMessage
	if json.Unmarshal([]byte(requestBody), &metadata) != nil || metadata == nil {
		metadata = map[string]json.RawMessage{}
	}
	metadata["_image_revised_prompt"], _ = json.Marshal(revised)
	encoded, err := json.Marshal(metadata)
	if err != nil {
		return requestBody
	}
	return string(encoded)
}
