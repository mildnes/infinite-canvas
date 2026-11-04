package service

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

func TestBatch1VideoServicePollPreservesPayloadAndPreviousResponse(t *testing.T) {
	if os.Getenv("IC_BATCH1_POLL_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestBatch1VideoServicePollPreservesPayloadAndPreviousResponse$", "-test.v")
		command.Env = append(os.Environ(), "IC_BATCH1_POLL_FIXTURE=1")
		output, err := command.CombinedOutput()
		if err != nil {
			t.Fatalf("poll fixture: %v\n%s", err, output)
		}
		t.Log(string(output))
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "poll.db")
	request := strings.Repeat("R", 5<<20)
	initial := model.VideoTask{ID: "service-poll", UserID: "owner", Status: "processing", Progress: 10, RequestBody: request, ResponseBody: "creation response", LastResponse: "old poll response", UpstreamTaskID: "upstream", StorageKey: "server:existing", MimeType: "video/mp4", Bytes: 12}
	if _, err := repository.SaveVideoTask(initial); err != nil {
		t.Fatal(err)
	}
	snapshot := func() model.VideoTask {
		t.Helper()
		tasks, err := repository.ListDueVideoTasks(1)
		if err != nil || len(tasks) != 1 {
			t.Fatalf("pending projection missing: count=%d err=%v", len(tasks), err)
		}
		return tasks[0]
	}
	if err := UpdateVideoTaskFromPoll(snapshot(), VideoTaskPollUpdate{Status: "processing", Progress: 65, ResponseBody: "new poll response"}); err != nil {
		t.Fatal(err)
	}
	if err := UpdateVideoTaskFromPoll(snapshot(), VideoTaskPollUpdate{Status: "processing", ErrorDetail: "temporary transport error"}); err != nil {
		t.Fatal(err)
	}
	current, found, err := repository.GetUserVideoTask("owner", initial.ID)
	if err != nil || !found || current.Progress != 65 || current.LastResponse != "new poll response" || current.ErrorDetail != "temporary transport error" {
		t.Fatalf("partial poll or no-response retry lost prior state: progress=%d last=%q detail=%q err=%v", current.Progress, current.LastResponse, current.ErrorDetail, err)
	}
	if current.RequestBody != request || current.ResponseBody != initial.ResponseBody {
		t.Errorf("service poll erased audit payloads: requestBytes=%d expected=%d response=%q", len(current.RequestBody), len(request), current.ResponseBody)
	}
	pending := snapshot()
	if err := UpdateVideoTaskFromPoll(pending, VideoTaskPollUpdate{Status: "completed", VideoURL: "/api/files/existing/content"}); err != nil {
		t.Fatal(err)
	}
	completed, _, err := repository.GetUserVideoTask("owner", initial.ID)
	if err != nil || completed.Status != "completed" || completed.Progress != 100 || completed.VideoURL != "/api/files/existing/content" || completed.StorageKey != initial.StorageKey || completed.Error != "" || completed.ErrorDetail != "" || completed.CompletedAt == "" {
		t.Fatal("service completion lost result metadata or failed to clear errors", err)
	}
	response := VideoTaskResponse(completed)
	if response["request_body"] != request || completed.RequestBody != request || completed.ResponseBody != initial.ResponseBody || completed.LastResponse != "new poll response" {
		t.Fatal("poll-only projection changed the complete frontend response or final audit payload")
	}
	if err := UpdateVideoTaskFromPoll(pending, VideoTaskPollUpdate{Status: "processing", Progress: 1}); err != nil {
		t.Fatal(err)
	}
	late, _, err := repository.GetUserVideoTask("owner", initial.ID)
	if err != nil || late.Status != "completed" || late.Progress != 100 {
		t.Fatal("late service poll revived a terminal task", err)
	}
	t.Logf("request body preserved across progress, transient error, completion and late result: %d bytes", len(late.RequestBody))

	image, err := repository.SaveCanvasImageTask(model.CanvasImageTask{ID: "service-image", UserID: "owner", Source: "canvas", SourceID: "board", NodeID: "node", Status: "processing", RequestBody: `{"_image_output_format":"png-transparent"}`})
	if err != nil {
		t.Fatal(err)
	}
	image.Status, image.Progress = "running", 90
	image.RequestBody = `{"_image_output_format":"png-transparent","_image_output_notice":"上游未返回透明通道。","_image_output_notice_code":"upstream-no-alpha"}`
	image.ResponseBody = `{"upstreamTaskId":"image-job"}`
	if _, err := SaveCanvasImageTask(image); err != nil {
		t.Fatal(err)
	}
	listed, err := repository.ListUserCanvasImageTasks("owner", nil, 100)
	if err != nil || len(listed) != 1 {
		t.Fatal("active image list changed", err)
	}
	batched, err := repository.BatchUserCanvasImageTasks("owner", []string{image.ID})
	if err != nil || len(batched) != 1 {
		t.Fatal("image batch read changed", err)
	}
	storedImage, found, err := repository.GetUserCanvasImageTask("owner", image.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	for _, item := range []model.CanvasImageTask{storedImage, listed[0], batched[0]} {
		response := CanvasImageTaskResponse(item)
		if response["imageOutputFormat"] != "png-transparent" || response["imageOutputNotice"] != "上游未返回透明通道。" || response["imageOutputNoticeCode"] != "upstream-no-alpha" {
			t.Fatal("poll field allowlist lost post-generation output notices in GET/list/batch responses")
		}
	}
	storedImage.Status, storedImage.Progress, storedImage.ResponseBody = "completed", 100, ""
	storedImage.ImageURL, storedImage.StorageKey, storedImage.CompletedAt = "/api/files/image/content", "server:image", "completed"
	storedImage.Error, storedImage.ErrorDetail = "", ""
	if _, err := SaveCanvasImageTask(storedImage); err != nil {
		t.Fatal(err)
	}
	completedImage, _, err := repository.GetUserCanvasImageTask("owner", image.ID)
	if err != nil || completedImage.ResponseBody != "" || completedImage.Status != "completed" {
		t.Fatal("image completion no longer clears the workflow response body", err)
	}
}
