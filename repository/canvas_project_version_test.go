package repository

import (
	"errors"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestCanvasVersionedBatchRollsBackAfterConditionalWriteConflict(t *testing.T) {
	current := prepareCanvasMaintenanceDB(t, false)
	insert := model.CanvasProject{UserID: current.UserID, ID: "new-project", ProjectData: `{"id":"new-project"}`, UpdatedAt: "new"}
	changed := current
	changed.ProjectData, changed.UpdatedAt = `{"nodes":["stale"]}`, "new"
	err := SaveUserCanvasProjectsWithVersions([]model.CanvasProject{insert, changed}, map[string]string{
		insert.ID: "", current.ID: "stale-version",
	})
	var conflict *CanvasProjectConflictError
	if !errors.As(err, &conflict) || conflict.Current.ProjectData != current.ProjectData {
		t.Fatalf("expected canonical conditional-write conflict: %v", err)
	}
	var rows int64
	if err := db.Model(&model.CanvasProject{}).Where("user_id = ? AND id = ?", insert.UserID, insert.ID).Count(&rows).Error; err != nil || rows != 0 {
		t.Fatalf("preceding insert was not rolled back: rows=%d err=%v", rows, err)
	}
	unchanged, err := GetUserCanvasProject(current.UserID, current.ID)
	if err != nil || unchanged.ProjectData != current.ProjectData || unchanged.UpdatedAt != current.UpdatedAt {
		t.Fatalf("conflict altered canonical project: %+v %v", unchanged, err)
	}
}

func TestCanvasVersionedConcurrentEditorsHaveExactlyOneWinner(t *testing.T) {
	current := prepareCanvasMaintenanceDB(t, false)
	connection, err := db.DB()
	if err != nil {
		t.Fatal(err)
	}
	connection.SetMaxOpenConns(1)
	ready := make(chan struct{})
	errorsFromWrites := make(chan error, 2)
	for _, name := range []string{"editor-a", "editor-b"} {
		go func(name string) {
			<-ready
			changed := current
			changed.ProjectData, changed.UpdatedAt = name, name
			errorsFromWrites <- SaveUserCanvasProjectsWithVersions([]model.CanvasProject{changed}, map[string]string{current.ID: current.UpdatedAt})
		}(name)
	}
	close(ready)
	winners, conflicts := 0, 0
	for range 2 {
		err := <-errorsFromWrites
		var conflict *CanvasProjectConflictError
		switch {
		case err == nil:
			winners++
		case errors.As(err, &conflict):
			conflicts++
		default:
			t.Fatalf("unexpected write error: %v", err)
		}
	}
	if winners != 1 || conflicts != 1 {
		t.Fatalf("CAS lost update protection: winners=%d conflicts=%d", winners, conflicts)
	}
}
