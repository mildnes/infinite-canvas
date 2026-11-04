package service

import (
	"encoding/json"
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
		resolved[source] = CompactInlineMediaURL(userID, source)
		return resolved[source]
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
