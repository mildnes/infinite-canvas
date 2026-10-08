package service

import (
	"encoding/json"
	"testing"
)

func TestRewriteStorageAliasesRewritesReferencesIdempotently(t *testing.T) {
	oldID := "11111111-1111-1111-1111-111111111111"
	middleID := "22222222-2222-2222-2222-222222222222"
	newID := "33333333-3333-3333-3333-333333333333"
	raw := json.RawMessage("{\"nodes\":[{\"metadata\":{\"content\":\"/api/files/11111111-1111-1111-1111-111111111111/content\",\"storageKey\":\"server:11111111-1111-1111-1111-111111111111\"}},{\"metadata\":{\"content\":\"/api/files/unknown/content\"}}]}")
	next, count := rewriteStorageAliases(raw, map[string]string{oldID: middleID, middleID: newID})
	if count != 2 {
		t.Fatalf("rewrites = %d, want 2", count)
	}
	want := "{\"nodes\":[{\"metadata\":{\"content\":\"/api/files/33333333-3333-3333-3333-333333333333/content\",\"storageKey\":\"server:33333333-3333-3333-3333-333333333333\"}},{\"metadata\":{\"content\":\"/api/files/unknown/content\"}}]}"
	if string(next) != want {
		t.Fatalf("rewritten payload = %s, want %s", next, want)
	}
	again, count := rewriteStorageAliases(next, map[string]string{oldID: middleID, middleID: newID})
	if count != 0 || string(again) != string(next) {
		t.Fatalf("rewrite is not idempotent: count=%d payload=%s", count, again)
	}
}

func TestRewriteStorageAliasesPreservesUnrelatedJSONAndRejectsInvalidJSON(t *testing.T) {
	raw := json.RawMessage("{\"text\":\"server:not-a-uuid\",\"value\":42,\"nested\":[true,null]}")
	next, count := rewriteStorageAliases(raw, map[string]string{"11111111-1111-1111-1111-111111111111": "22222222-2222-2222-2222-222222222222"})
	if count != 0 || string(next) != string(raw) {
		t.Fatalf("unrelated payload changed: count=%d payload=%s", count, next)
	}
	if _, err := RewriteStorageObjectAliases(json.RawMessage("{\"broken\"")); err == nil {
		t.Fatal("invalid JSON should be rejected")
	}
}
