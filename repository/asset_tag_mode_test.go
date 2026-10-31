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

func prepareAssetTagModeDB(t *testing.T) *gorm.DB {
	t.Helper()
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	path := filepath.Join(t.TempDir(), "assets.db")
	seed, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	if err := seed.AutoMigrate(&model.Asset{}); err != nil {
		t.Fatal(err)
	}
	connection, _ := seed.DB()
	_ = connection.Close()
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", path
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		connection, _ := database.DB()
		_ = connection.Close()
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	return database
}

func TestAssetTagModeFiltersAnyAndAll(t *testing.T) {
	database := prepareAssetTagModeDB(t)
	assets := []model.Asset{
		{ID: "alpha", Title: "alpha", Category: "photo", Tags: []string{"red", "square"}},
		{ID: "beta", Title: "beta", Category: "photo", Tags: []string{"blue"}},
		{ID: "gamma", Title: "gamma", Category: "graphic", Tags: []string{"red"}},
		{ID: "empty", Title: "empty", Category: "graphic"},
	}
	if err := database.Create(&assets).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name string
		q    model.Query
		want []string
	}{
		{name: "any", q: model.Query{Tags: []string{"red", "blue"}, TagMode: "any"}, want: []string{"alpha", "beta", "gamma"}},
		{name: "all", q: model.Query{Tags: []string{"red", "square"}, TagMode: "all"}, want: []string{"alpha"}},
		{name: "missing defaults to any", q: model.Query{Tags: []string{"red", "blue"}}, want: []string{"alpha", "beta", "gamma"}},
		{name: "invalid defaults to any", q: model.Query{Tags: []string{"red", "blue"}, TagMode: "invalid"}, want: []string{"alpha", "beta", "gamma"}},
		{name: "case insensitive all", q: model.Query{Tags: []string{"red", "square"}, TagMode: " ALL "}, want: []string{"alpha"}},
		{name: "blank tags ignored", q: model.Query{Tags: []string{"", " ", "red"}, TagMode: "all"}, want: []string{"alpha", "gamma"}},
		{name: "category and tags", q: model.Query{Category: "photo", Tags: []string{"red", "blue"}, TagMode: "all"}, want: nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			items, total, err := ListAssets(tc.q)
			if err != nil {
				t.Fatal(err)
			}
			got := make(map[string]bool, len(items))
			for _, item := range items {
				got[item.ID] = true
			}
			if int(total) != len(tc.want) || len(got) != len(tc.want) {
				t.Fatalf("items=%v total=%d, want %v", got, total, tc.want)
			}
			for _, id := range tc.want {
				if !got[id] {
					t.Fatalf("items=%v, missing %q", got, id)
				}
			}
		})
	}
}

func TestAssetFilterOptionsIgnoreActiveTagFilter(t *testing.T) {
	database := prepareAssetTagModeDB(t)
	assets := []model.Asset{
		{ID: "alpha", Category: "photo", Tags: []string{"red", "square"}},
		{ID: "beta", Category: "graphic", Tags: []string{"blue"}},
	}
	if err := database.Create(&assets).Error; err != nil {
		t.Fatal(err)
	}
	tags, categories, err := ListAssetFilters(model.Query{Tags: []string{"red"}, Category: "photo", TagMode: "all"})
	if err != nil {
		t.Fatal(err)
	}
	if len(tags) != 3 || len(categories) != 2 {
		t.Fatalf("tags=%v categories=%v", tags, categories)
	}
}
