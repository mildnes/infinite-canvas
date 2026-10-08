package service

import (
	"encoding/json"
	"errors"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/repository"
)

var storageAliasCache struct {
	sync.Mutex
	loadedAt time.Time
	aliases  map[string]string
}

var storageAliasString = regexp.MustCompile(`"(?:\\.|[^"\\])*"`)
var storageAliasReference = regexp.MustCompile(`server:([A-Za-z0-9_-]+)|/api/files/([A-Za-z0-9_-]+)/content`)

func storageObjectAliases() (map[string]string, error) {
	storageAliasCache.Lock()
	defer storageAliasCache.Unlock()
	if storageAliasCache.aliases != nil && time.Since(storageAliasCache.loadedAt) < time.Minute {
		return storageAliasCache.aliases, nil
	}
	rows, err := repository.ListStorageObjectAliases()
	if err != nil {
		return nil, err
	}
	aliases := make(map[string]string, len(rows))
	for _, row := range rows {
		if _, err := uuid.Parse(row.OldID); err != nil {
			continue
		}
		if _, err := uuid.Parse(row.NewID); err == nil {
			aliases[row.OldID] = row.NewID
		}
	}
	storageAliasCache.aliases, storageAliasCache.loadedAt = aliases, time.Now()
	return aliases, nil
}

// RewriteStorageObjectAliases changes only referenced JSON strings. Numbers,
// whitespace and unrelated fields retain their original serialized bytes.
func RewriteStorageObjectAliases(raw json.RawMessage) (json.RawMessage, error) {
	if len(strings.TrimSpace(string(raw))) == 0 {
		return raw, nil
	}
	if !json.Valid(raw) {
		return nil, errors.New("保存数据不是有效 JSON")
	}
	if !strings.Contains(string(raw), "server:") && !strings.Contains(string(raw), "content") {
		return raw, nil
	}
	aliases, err := storageObjectAliases()
	if err != nil {
		return nil, err
	}
	next, count := rewriteStorageAliases(raw, aliases)
	if count > 0 {
		log.Printf("storage alias_rewritten=%d", count)
	}
	return next, nil
}

func rewriteStorageAliases(raw json.RawMessage, aliases map[string]string) (json.RawMessage, int) {
	count := 0
	next := storageAliasString.ReplaceAllFunc(raw, func(encoded []byte) []byte {
		var value string
		if json.Unmarshal(encoded, &value) != nil {
			return encoded
		}
		rewritten := storageAliasReference.ReplaceAllStringFunc(value, func(reference string) string {
			match := storageAliasReference.FindStringSubmatch(reference)
			id := match[1]
			if id == "" {
				id = match[2]
			}
			seen := make(map[string]bool)
			target := id
			for aliases[target] != "" {
				if seen[target] {
					return reference // Invalid cyclic mappings must never oscillate on each save.
				}
				seen[target] = true
				target = aliases[target]
			}
			if target == id {
				return reference
			}
			count++
			if match[1] != "" {
				return "server:" + target
			}
			return "/api/files/" + target + "/content"
		})
		if rewritten == value {
			return encoded
		}
		encoded, _ = json.Marshal(rewritten)
		return encoded
	})
	return next, count
}
