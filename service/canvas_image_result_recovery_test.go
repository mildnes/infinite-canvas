package service

import (
	"context"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestCanvasSaveRecoversExactCompletedImageResult(t *testing.T) {
	if os.Getenv("IC_CANVAS_RESULT_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestCanvasSaveRecoversExactCompletedImageResult$", "-test.v")
		command.Env = append(os.Environ(), "IC_CANVAS_RESULT_FIXTURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("result save fixture: %v\n%s", err, output)
		}
		t.Logf("%s", output)
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "result-save.db")
	database, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	ctx := WithUser(context.Background(), model.AuthUser{ID: "owner"})
	old := time.Now().UTC().Add(-20 * time.Minute).Format(time.RFC3339Nano)
	for _, sample := range []struct {
		name, status                                  string
		pollError                                     bool
		want                                          bool
		taskID, owner, sourceID, nodeID, content, key string
	}{
		{name: "poll-error", status: "error", pollError: true, want: true},
		{name: "loading", status: "loading", want: true},
		{name: "success-missing", status: "success", want: true},
		{name: "cancelled", status: "cancelled"},
		{name: "explicit-failed", status: "error"},
		{name: "new-task", status: "loading", taskID: "other-task"},
		{name: "foreign", status: "loading", owner: "other"},
		{name: "other-board", status: "loading", sourceID: "other-board"},
		{name: "other-node", status: "loading", nodeID: "other-node"},
		{name: "has-content", status: "error", pollError: true, content: "keep-existing"},
		{name: "has-key", status: "error", pollError: true, key: "server:keep"},
	} {
		t.Run(sample.name, func(t *testing.T) {
			taskID := "result-" + sample.name
			board := "board-" + sample.name
			owner := sample.owner
			if owner == "" {
				owner = "owner"
			}
			sourceID := sample.sourceID
			if sourceID == "" {
				sourceID = board
			}
			nodeID := sample.nodeID
			if nodeID == "" {
				nodeID = "node"
			}
			task := model.CanvasImageTask{ID: taskID, UserID: owner, Source: "canvas", SourceID: sourceID, NodeID: nodeID, Status: "processing", CreatedAt: old}
			if err := database.Create(&task).Error; err != nil {
				t.Fatal(err)
			}
			task.Status = "completed"
			task.ImageURL = "/api/files/object/content"
			task.StorageKey = "server:object"
			task.CompletedAt = old
			task.Width = 3840
			task.Height = 2160
			if _, err := repository.UpdateCanvasImageTask(task); err != nil {
				t.Fatal(err)
			}
			if err := repository.DeleteFinishedCanvasImageTasksBefore(time.Now().UTC().Format(time.RFC3339Nano)); err != nil {
				t.Fatal(err)
			}
			currentID := taskID
			if sample.taskID != "" {
				currentID = sample.taskID
			}
			raw := json.RawMessage(`{"id":"` + board + `","createdAt":"old","updatedAt":"old","nodes":[{"id":"node","type":"image","width":420,"height":236,"position":{"x":4176,"y":8112},"metadata":{"content":"` + sample.content + `","storageKey":"` + sample.key + `","imageTaskId":"` + currentID + `","status":"` + sample.status + `","taskPollError":` + map[bool]string{true: "true", false: "false"}[sample.pollError] + `,"errorDetails":"old polling error","custom":9007199254740993}}],"connections":[],"unknown":{"keep":true}}`)
			base := ""
			saved, err := SaveCurrentUserCanvasProject(ctx, raw, base)
			if err != nil {
				t.Fatal(err)
			}
			if !strings.Contains(string(saved), "9007199254740993") {
				t.Fatal("unknown numeric metadata was rounded")
			}
			var project struct {
				Nodes []struct {
					Width, Height int
					Position      struct{ X, Y int }
					Metadata      struct {
						Content, StorageKey, Status string
						TaskPollError               bool
						ErrorDetails                string
					}
				}
			}
			if err := json.Unmarshal(saved, &project); err != nil {
				t.Fatal(err)
			}
			node := project.Nodes[0]
			if node.Width != 420 || node.Height != 236 || node.Position.X != 4176 || node.Position.Y != 8112 {
				t.Fatal("recovery changed layout")
			}
			if sample.want {
				if node.Metadata.Content != task.ImageURL || node.Metadata.StorageKey != task.StorageKey || node.Metadata.Status != "success" || node.Metadata.TaskPollError || node.Metadata.ErrorDetails != "" {
					t.Fatalf("completed image not recovered on save: %s", saved)
				}
			} else if node.Metadata.Content != sample.content || node.Metadata.StorageKey != sample.key || node.Metadata.Status != sample.status {
				t.Fatalf("unrelated/terminal node changed: %s", saved)
			}
		})
	}
}
