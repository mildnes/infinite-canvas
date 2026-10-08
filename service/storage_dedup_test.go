package service

import (
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestStorageObjectReadableForDedupUsesLocalOrVerifiedProof(t *testing.T) {
	for _, status := range []string{"ok", "verified", "OK", "VERIFIED"} {
		if !storageObjectReadableForDedup(model.StorageObject{CloudCheckStatus: status}) {
			t.Fatalf("cloud check status %q should be readable", status)
		}
		if !storageObjectReadableForDedup(model.StorageObject{CloudSyncStatus: status}) {
			t.Fatalf("cloud sync status %q should be readable", status)
		}
	}
	for _, object := range []model.StorageObject{
		{},
		{CloudCheckStatus: "missing", CloudSyncStatus: "blocked"},
		{CloudCheckStatus: "ok", DeletedAt: "2026-01-01"},
	} {
		if storageObjectReadableForDedup(object) {
			t.Fatalf("object %#v should not be reused", object)
		}
	}
}

func TestUploadedStorageObjectFromExistingUsesStableContentReference(t *testing.T) {
	got := uploadedStorageObjectFromExisting(model.StorageObject{
		ID: "object-id", Bytes: 42, MimeType: "image/png", Width: 640, Height: 480,
	})
	if got.ID != "object-id" || got.StorageKey != "server:object-id" || got.URL != "/api/files/object-id/content" || got.Bytes != 42 || got.MimeType != "image/png" || got.Width != 640 || got.Height != 480 {
		t.Fatalf("reuse result = %#v", got)
	}
}
