package service

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestMediaSyncConfirmsUncertainPutWithoutDeleting(t *testing.T) {
	reads, uploads := 0, 0
	err := ensureMediaCloudWithIO(func() error {
		reads++
		if reads == 1 {
			return mediaHTTPError(404)
		}
		return nil
	}, func() error { uploads++; return context.DeadlineExceeded })
	if err != nil || reads != 2 || uploads != 1 {
		t.Fatalf("timeout committed: reads=%d uploads=%d err=%v", reads, uploads, err)
	}
}

func TestMediaSyncOnlyUploadsConfirmedMissingTargets(t *testing.T) {
	for _, failure := range []error{nil, mediaHTTPError(401), mediaHTTPError(403), mediaHTTPError(500), mediaIssue("mismatch", "不同内容")} {
		uploads := 0
		err := ensureMediaCloudWithIO(func() error { return failure }, func() error { uploads++; return nil })
		if uploads != 0 {
			t.Fatal("healthy, inaccessible or conflicting targets must never be overwritten")
		}
		if (failure == nil) != (err == nil) {
			t.Fatalf("unexpected outcome: %v", err)
		}
	}
}

func TestMediaSyncRejectsPostUploadMismatch(t *testing.T) {
	reads := 0
	err := ensureMediaCloudWithIO(func() error {
		reads++
		if reads == 1 {
			return mediaHTTPError(404)
		}
		return mediaIssue("mismatch", "云端内容不符")
	}, func() error { return nil })
	if mediaErrorKind(err) != "mismatch" {
		t.Fatalf("must not mark successful PUT as verified: %v", err)
	}
	updates := mediaSyncFailureUpdates(model.StorageObject{ID: "id", CloudSyncAttempts: 1}, err, time.Now())
	if updates["cloud_sync_status"] != "blocked" || updates["cloud_check_status"] != "mismatch" {
		t.Fatalf("unexpected state: %v", updates)
	}
}

func TestMediaSyncRetryScheduleAndSafeErrors(t *testing.T) {
	current := time.Date(2026, 10, 6, 0, 0, 0, 0, time.UTC)
	for attempt := 1; attempt <= 6; attempt++ {
		updates := mediaSyncFailureUpdates(model.StorageObject{ID: "id", CloudSyncAttempts: attempt}, errors.New("https://private.example/?token=secret"), current)
		if strings.Contains(updates["cloud_sync_error"].(string), "secret") {
			t.Fatal("stored errors leaked credentials")
		}
		if attempt <= 5 {
			stamp, err := time.Parse(time.RFC3339Nano, updates["cloud_sync_next_retry_at"].(string))
			if err != nil || !stamp.After(current) || updates["cloud_sync_status"] != "retry" {
				t.Fatalf("attempt %d: %v", attempt, updates)
			}
		} else if updates["cloud_sync_status"] != "blocked" || updates["cloud_sync_next_retry_at"] != "" {
			t.Fatal("retry budget must be bounded")
		}
	}
	for _, err := range []error{mediaHTTPError(403), mediaIssue("unverifiable", "无校验依据"), mediaIssue("mismatch", "错误内容")} {
		if mediaSyncFailureUpdates(model.StorageObject{CloudSyncAttempts: 1}, err, current)["cloud_sync_status"] != "blocked" {
			t.Fatal("permanent errors must not loop")
		}
	}
}

func TestMediaSyncRetainsActualCloudResultWhenSourceFails(t *testing.T) {
	err := ensureMediaCloudWithIO(func() error { return mediaHTTPError(404) }, func() error { return mediaIssue("mismatch", "本地副本损坏") })
	updates := mediaSyncFailureUpdates(model.StorageObject{CloudSyncAttempts: 1}, err, time.Now())
	if updates["cloud_check_status"] != "missing" || updates["cloud_sync_status"] != "blocked" {
		t.Fatalf("local corruption must not be reported as cloud corruption: %v", updates)
	}
}

func TestMediaSyncTargetAndCredentialFingerprintRemainStable(t *testing.T) {
	object := model.StorageObject{ID: "id", CreatedBy: "owner", CreatedAt: "2026-09-01T12:00:00Z", MimeType: "image/png"}
	provider := model.StorageProvider{ID: "dav", Type: model.StorageProviderTypeWebDAV, PathPrefix: "canvas", Endpoint: "https://dav.example", Password: "first"}
	if key := newMediaCloudKey(object, provider); key != "canvas/owner/2026/09/01/id.png" {
		t.Fatalf("target must use immutable creation date: %q", key)
	}
	fingerprint := mediaProviderFingerprint(provider)
	provider.Name, provider.Weight = "new name", 5
	if mediaProviderFingerprint(provider) != fingerprint {
		t.Fatal("labels/weights must not interrupt queued uploads")
	}
	provider.Password = "changed"
	if mediaProviderFingerprint(provider) == fingerprint {
		t.Fatal("changed credentials must block old queued authorization")
	}
}

func TestMediaSyncPausedTaskRemainsResumable(t *testing.T) {
	updates := mediaSyncFailureUpdates(model.StorageObject{CloudSyncAttempts: 1}, mediaIssue("paused", "自动上云已关闭"), time.Now())
	if updates["cloud_sync_status"] != "pending" || updates["cloud_sync_lease_token"] != "" {
		t.Fatalf("disabling auto-sync must pause, not permanently block the task: %v", updates)
	}
}

func TestGeneratedCopyCleanupRetainsPendingOrUnhealthyMedia(t *testing.T) {
	current := time.Now()
	object := model.StorageObject{ProviderID: "dav", CloudSyncedAt: current.Add(-8 * 24 * time.Hour).UTC().Format(time.RFC3339Nano), CloudSyncStatus: "verified", CloudCheckStatus: "ok"}
	if !generatedCopyReady(object, current, 7*24*time.Hour) {
		t.Fatal("verified retained copy should be eligible for the existing explicit cleanup")
	}
	for _, state := range []string{"pending", "retry", "syncing", "blocked"} {
		candidate := object
		candidate.CloudSyncStatus = state
		if generatedCopyReady(candidate, current, 7*24*time.Hour) {
			t.Fatalf("cleanup admitted sync state %s", state)
		}
	}
	object.CloudCheckStatus = "missing"
	if generatedCopyReady(object, current, 7*24*time.Hour) {
		t.Fatal("a historical sync timestamp cannot authorize removal of an unhealthy copy")
	}
}
