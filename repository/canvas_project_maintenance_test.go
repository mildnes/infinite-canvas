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

func prepareCanvasMaintenanceDB(t *testing.T, readOnly bool) model.CanvasProject {
	t.Helper()
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	path := filepath.Join(t.TempDir(), "existing.db")
	seed, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.AutoMigrate(&model.CanvasProject{}); err != nil {
		t.Fatal(err)
	}
	project := model.CanvasProject{ID: "canvas", UserID: "owner", ProjectData: `{"nodes":[],"updatedAt":"old"}`, UpdatedAt: "old"}
	if err := seed.Create(&project).Error; err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := seed.DB()
	_ = sqlDB.Close()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", path
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			connection, _ := db.DB()
			_ = connection.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	if err := OpenExistingDatabase(readOnly); err != nil {
		t.Fatal(err)
	}
	return project
}

func TestCanvasMaintenanceDryRunCannotWriteOrMigrateSchema(t *testing.T) {
	project := prepareCanvasMaintenanceDB(t, true)
	projects, err := ListCanvasProjectsForMediaRepair("", "", 100)
	if err != nil || len(projects) != 1 || projects[0].ProjectData != project.ProjectData {
		t.Fatalf("unexpected dry-run read: %+v, %v", projects, err)
	}
	if db.Migrator().HasTable(&model.User{}) || db.Migrator().HasTable(&model.StorageObject{}) {
		t.Fatal("maintenance connection must not create application tables")
	}
	if err := ReplaceCanvasProjectDataForMaintenance(project, "changed", "new"); err == nil {
		t.Fatal("dry-run SQLite connection must reject writes")
	}
}

func TestCanvasMaintenanceRefusesStaleWrites(t *testing.T) {
	project := prepareCanvasMaintenanceDB(t, false)
	if err := ReplaceCanvasProjectDataForMaintenance(project, `{"nodes":[],"updatedAt":"new"}`, "new"); err != nil {
		t.Fatal(err)
	}
	if err := ReplaceCanvasProjectDataForMaintenance(project, "stale", "later"); err == nil {
		t.Fatal("a stale migration must not overwrite a newer canvas")
	}
	var saved model.CanvasProject
	if err := db.First(&saved, "user_id = ? AND id = ?", project.UserID, project.ID).Error; err != nil || saved.UpdatedAt != "new" || saved.ProjectData == "stale" {
		t.Fatalf("saved project=%+v, %v", saved, err)
	}
}
