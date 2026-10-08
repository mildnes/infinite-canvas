package repository

import (
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestAssetDataCASPreservesOtherFieldsAndRejectsStaleSaves(t *testing.T) {
	prepareStorageSyncDB(t, false)
	if err := db.AutoMigrate(&model.UserConfig{}); err != nil {
		t.Fatal(err)
	}
	original := model.UserConfig{UserID: "owner", AssetData: `{"assets":[]}`, ModelConfig: `{"model":"kept"}`}
	if err := db.Create(&original).Error; err != nil {
		t.Fatal(err)
	}
	previous := original.AssetData
	if saved, err := SaveUserAssetData("owner", `{"assets":[{"id":"new"}]}`, &previous); err != nil || !saved {
		t.Fatalf("initial save: %v %v", saved, err)
	}
	if saved, err := SaveUserAssetData("owner", `{"assets":[]}`, &previous); err != nil || saved {
		t.Fatalf("stale save overwrote newer assets: %v %v", saved, err)
	}
	if saved, err := SaveUserAssetData("owner", `{"assets":[{"id":"legacy"}]}`, nil); err != nil || !saved {
		t.Fatalf("legacy save: %v %v", saved, err)
	}
	latest, _, err := GetUserConfig("owner")
	if err != nil || latest.ModelConfig != original.ModelConfig || latest.AssetData != `{"assets":[{"id":"legacy"}]}` {
		t.Fatalf("unrelated configuration changed: %+v %v", latest, err)
	}
}

func TestAssetDataCASOnlyOneConcurrentFirstSaveSucceeds(t *testing.T) {
	prepareStorageSyncDB(t, false)
	if err := db.AutoMigrate(&model.UserConfig{}); err != nil {
		t.Fatal(err)
	}
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
	previous := ""
	results := make(chan bool, 2)
	var workers sync.WaitGroup
	for _, raw := range []string{`{"assets":[{"id":"a"}]}`, `{"assets":[{"id":"b"}]}`} {
		workers.Add(1)
		go func(raw string) {
			defer workers.Done()
			saved, err := SaveUserAssetData("owner", raw, &previous)
			if err != nil {
				t.Error(err)
			}
			results <- saved
		}(raw)
	}
	workers.Wait()
	close(results)
	winners := 0
	for saved := range results {
		if saved {
			winners++
		}
	}
	if winners != 1 {
		t.Fatalf("got %d winners, expected one", winners)
	}
}
