package repository

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func prepareStorageSyncDB(t *testing.T, readOnly bool) model.StorageObject {
	t.Helper()
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	name := filepath.Join(t.TempDir(), "storage.db")
	seed, err := gorm.Open(sqlite.Open(name), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = seed.AutoMigrate(&model.StorageObject{}); err != nil {
		t.Fatal(err)
	}
	object := model.StorageObject{ID: "object", CreatedBy: "owner", ProviderID: "local-generated", ObjectKey: "object.png", SHA256: "hash", Bytes: 5, CloudSyncStatus: "pending"}
	if err = seed.Create(&object).Error; err != nil {
		t.Fatal(err)
	}
	connection, _ := seed.DB()
	_ = connection.Close()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", name
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			connection, _ := db.DB()
			_ = connection.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	if err = OpenExistingDatabase(readOnly); err != nil {
		t.Fatal(err)
	}
	return object
}

func TestStorageSyncLeaseSingleClaimAndExpiredRecovery(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	current := time.Now().UTC()
	claimed, err := ClaimStorageObjectSync(object, "first", current.Format(time.RFC3339Nano), current.Add(time.Minute).Format(time.RFC3339Nano))
	if err != nil || !claimed {
		t.Fatalf("first claim: %v %v", claimed, err)
	}
	if claimed, err = ClaimStorageObjectSync(object, "other", current.Format(time.RFC3339Nano), current.Add(time.Minute).Format(time.RFC3339Nano)); err != nil || claimed {
		t.Fatalf("duplicate claim: %v %v", claimed, err)
	}
	first, err := GetStorageObject(object.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("cloud_sync_lease_until", current.Add(-time.Minute).Format(time.RFC3339Nano)).Error; err != nil {
		t.Fatal(err)
	}
	due, err := ListDueStorageObjectSyncs(current.Format(time.RFC3339Nano), 10, true)
	if err != nil || len(due) != 1 {
		t.Fatalf("expired task wasn't found: %v %v", due, err)
	}
	if claimed, err = ClaimStorageObjectSync(due[0], "new", current.Format(time.RFC3339Nano), current.Add(time.Minute).Format(time.RFC3339Nano)); err != nil || !claimed {
		t.Fatalf("recovery claim: %v %v", claimed, err)
	}
	if err = UpdateStorageObjectSnapshot(first, map[string]any{"cloud_sync_status": "verified"}); err == nil {
		t.Fatal("late first worker overwrote the new lease")
	}
}

func TestStorageSyncCannotResurrectDeletedOrChangedObject(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	if err := db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Update("provider_id", "changed").Error; err != nil {
		t.Fatal(err)
	}
	if err := UpdateStorageObjectSnapshot(object, map[string]any{"cloud_sync_status": "verified"}); err == nil {
		t.Fatal("stale provider index was overwritten")
	}
	latest, err := GetStorageObject(object.ID)
	if err != nil {
		t.Fatal(err)
	}
	if err = db.Delete(&model.StorageObject{}, "id = ?", object.ID).Error; err != nil {
		t.Fatal(err)
	}
	if err = UpdateStorageObjectSnapshot(latest, map[string]any{"cloud_sync_status": "verified"}); err == nil {
		t.Fatal("deleted row was resurrected")
	}
}

func TestStorageSyncLegacyNullFields(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	if err := db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Updates(map[string]any{"cloud_sync_status": nil, "cloud_sync_lease_token": nil, "cloud_sync_lease_until": nil}).Error; err != nil {
		t.Fatal(err)
	}
	legacy, err := GetStorageObject(object.ID)
	if err != nil {
		t.Fatal(err)
	}
	claimed, err := ClaimStorageObjectSync(legacy, "token", time.Now().UTC().Format(time.RFC3339Nano), time.Now().UTC().Add(time.Minute).Format(time.RFC3339Nano))
	if err != nil || !claimed {
		t.Fatalf("new columns on old rows must be claimable: %v %v", claimed, err)
	}
}

func TestStorageSyncPausedAutomaticDoesNotHideExplicitJobs(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	explicit := object
	explicit.ID, explicit.CloudSyncExplicit = "z-explicit", true
	if err := db.Create(&explicit).Error; err != nil {
		t.Fatal(err)
	}
	due, err := ListDueStorageObjectSyncs(time.Now().UTC().Format(time.RFC3339Nano), 1, false)
	if err != nil || len(due) != 1 || due[0].ID != explicit.ID {
		t.Fatalf("paused automatic job hid an explicit request: %v %v", due, err)
	}
}

func TestStorageSyncStaleRetryCannotResetAttemptBudget(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	if err := db.Model(&model.StorageObject{}).Where("id = ?", object.ID).Updates(map[string]any{"cloud_sync_attempts": 2, "cloud_sync_next_retry_at": "later"}).Error; err != nil {
		t.Fatal(err)
	}
	if err := UpdateStorageObjectSnapshot(object, map[string]any{"cloud_sync_attempts": 0}); err == nil {
		t.Fatal("stale queue snapshot reset the retry budget")
	}
}

func TestStorageVerificationReadOnlyCannotWriteOrCreateTables(t *testing.T) {
	object := prepareStorageSyncDB(t, true)
	objects, err := ListStorageObjectsForVerification(StorageObjectFilter{Limit: 10})
	if err != nil || len(objects) != 1 {
		t.Fatalf("dry-run cannot read: %v %v", objects, err)
	}
	if db.Migrator().HasTable(&model.User{}) {
		t.Fatal("read-only maintenance created a table")
	}
	if err = UpdateStorageObjectSnapshot(object, map[string]any{"cloud_check_status": "ok"}); err == nil {
		t.Fatal("dry-run connection accepted a write")
	}
}

func TestStorageSiblingsRequireProofAndExcludeDeletedObjects(t *testing.T) {
	object := prepareStorageSyncDB(t, false)
	for _, candidate := range []model.StorageObject{
		{ID: "cross-owner", CreatedBy: "other", SHA256: "HASH", Bytes: object.Bytes},
		{ID: "different-size", SHA256: object.SHA256, Bytes: object.Bytes + 1},
		{ID: "different-hash", SHA256: "other-hash", Bytes: object.Bytes},
		{ID: "deleted", SHA256: object.SHA256, Bytes: object.Bytes, DeletedAt: "deleted"},
	} {
		if err := db.Create(&candidate).Error; err != nil {
			t.Fatal(err)
		}
	}
	siblings, err := ListStorageObjectSiblings(object, "", 50)
	if err != nil || len(siblings) != 1 || siblings[0].ID != "cross-owner" {
		t.Fatalf("only the active same-content donor is eligible: %v %v", siblings, err)
	}
}
