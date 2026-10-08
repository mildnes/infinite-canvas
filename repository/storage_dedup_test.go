package repository

import (
	"path/filepath"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

func TestListStorageObjectsByFingerprintScopesOwnerFingerprintAndDeletion(t *testing.T) {
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	name := filepath.Join(t.TempDir(), "storage-dedup.db")
	seed, err := gorm.Open(sqlite.Open(name), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err = seed.AutoMigrate(&model.StorageObject{}); err != nil {
		t.Fatal(err)
	}
	objects := []model.StorageObject{
		{ID: "same-owner", ObjectKey: "same-owner.png", CreatedBy: "owner", SHA256: "ABCDEF", Bytes: 4, CreatedAt: "2026-01-01"},
		{ID: "other-owner", ObjectKey: "other-owner.png", CreatedBy: "other", SHA256: "abcdef", Bytes: 4, CreatedAt: "2026-01-02"},
		{ID: "different-bytes", ObjectKey: "different-bytes.png", CreatedBy: "owner", SHA256: "abcdef", Bytes: 5, CreatedAt: "2026-01-03"},
		{ID: "deleted", ObjectKey: "deleted.png", CreatedBy: "owner", SHA256: "abcdef", Bytes: 4, DeletedAt: "2026-01-04", CreatedAt: "2026-01-04"},
	}
	if err = seed.Create(&objects).Error; err != nil {
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
	if err = OpenExistingDatabase(false); err != nil {
		t.Fatal(err)
	}
	got, err := ListStorageObjectsByFingerprint("owner", "abcdef", 4)
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[0].ID != "same-owner" {
		t.Fatalf("fingerprint candidates = %#v, want same-owner only", got)
	}
}
