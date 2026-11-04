package repository

import (
	"encoding/json"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func captureTaskSQL(t *testing.T, database *gorm.DB, operation string) *[]string {
	t.Helper()
	statements := []string{}
	name := "batch1-poll-fields-" + operation
	collect := func(tx *gorm.DB) { statements = append(statements, strings.ToLower(tx.Statement.SQL.String())) }
	if operation == "query" {
		if err := database.Callback().Query().After("gorm:query").Register(name, collect); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { database.Callback().Query().Remove(name) })
	} else {
		if err := database.Callback().Update().After("gorm:update").Register(name, collect); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { database.Callback().Update().Remove(name) })
	}
	return &statements
}

func TestBatch1VideoPollQueryLeavesPayloadsOnDisk(t *testing.T) {
	database := resultDB(t)
	request := strings.Repeat("R", 5<<20)
	created, err := SaveVideoTask(model.VideoTask{ID: "poll-video", UserID: "owner", Status: "processing", UpstreamTaskID: "upstream", RequestBody: request, ResponseBody: "original-response", LastResponse: "previous-poll-response", OriginalURL: "https://original.example/video.mp4", Source: "canvas", SourceID: "board", UserChannelID: "user-channel", ChannelName: "channel", CreatedAt: "1"})
	if err != nil || len(created.RequestBody) != len(request) {
		t.Fatal("creation lost the full request body", err)
	}
	sql := captureTaskSQL(t, database, "query")
	tasks, err := ListDueVideoTasks(10)
	if err != nil || len(tasks) != 1 {
		t.Fatalf("pending video not selected: count=%d err=%v", len(tasks), err)
	}
	if len(tasks[0].RequestBody) != 0 || tasks[0].ResponseBody != "" || tasks[0].WorkflowRef != "" {
		t.Errorf("poll snapshot still reads audit payloads: requestBytes=%d responseBytes=%d workflowBytes=%d", len(tasks[0].RequestBody), len(tasks[0].ResponseBody), len(tasks[0].WorkflowRef))
	}
	if tasks[0].LastResponse != created.LastResponse || tasks[0].OriginalURL != created.OriginalURL || tasks[0].Source != created.Source || tasks[0].SourceID != created.SourceID || tasks[0].UserChannelID != created.UserChannelID || tasks[0].ChannelName != created.ChannelName {
		t.Fatal("poll projection removed other fields used by shared update or response handling")
	}
	if len(*sql) != 1 {
		t.Fatalf("expected one poll query, got %d", len(*sql))
	}
	projection := strings.Split((*sql)[0], " from ")[0]
	for _, field := range []string{"*", "request_body", "response_body", "workflow_ref"} {
		if strings.Contains(projection, field) {
			t.Errorf("poll SELECT still includes %q: %s", field, projection)
		}
	}
	if !strings.Contains((*sql)[0], "workflow_ref") || !strings.Contains((*sql)[0], "upstream_task_id") {
		t.Fatal("field projection removed the existing routing WHERE predicates")
	}
	full, found, err := GetUserVideoTask("owner", created.ID)
	if err != nil || !found || full.RequestBody != request || full.ResponseBody != "original-response" {
		t.Fatal("poll projection changed the stored payload or full API read", err)
	}
}

func TestBatch1VideoPollUpdatePreservesCreationPayloads(t *testing.T) {
	database := resultDB(t)
	request := strings.Repeat("R", 5<<20)
	initial := model.VideoTask{ID: "video-update", UserID: "owner", Status: "processing", Progress: 10, WorkflowRef: `{"kind":"video"}`, RequestBody: request, ResponseBody: "creation-response"}
	if _, err := SaveVideoTask(initial); err != nil {
		t.Fatal(err)
	}
	sql := captureTaskSQL(t, database, "update")
	partial := model.VideoTask{ID: initial.ID, UserID: "owner", Status: "completed", Progress: 100, VideoURL: "/api/files/video/content", StorageKey: "server:video", Error: "", ErrorDetail: "", CompletedAt: "now", UpdatedAt: "now", LastPolledAt: "now", ResponseBody: "stale-response"}
	changed, err := SavePendingVideoTaskPoll(partial)
	if err != nil || !changed {
		t.Fatal("poll did not advance active video", err)
	}
	full, found, err := GetUserVideoTask("owner", initial.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if full.RequestBody != request || full.ResponseBody != initial.ResponseBody || full.WorkflowRef != initial.WorkflowRef {
		t.Errorf("poll overwrote immutable payloads: requestBytes=%d want=%d response=%q workflow=%q", len(full.RequestBody), len(request), full.ResponseBody, full.WorkflowRef)
	}
	if full.Status != "completed" || full.Progress != 100 || full.VideoURL != partial.VideoURL || full.StorageKey != partial.StorageKey || full.CompletedAt != "now" || full.LastPolledAt != "now" {
		t.Fatal("poll lost status, progress, media or time updates")
	}
	for _, statement := range *sql {
		set := strings.Split(statement, " where ")[0]
		for _, field := range []string{"request_body", "response_body", "workflow_ref"} {
			if strings.Contains(set, field) {
				t.Errorf("poll UPDATE still rewrites %q", field)
			}
		}
	}
	changed, err = SavePendingVideoTaskPoll(model.VideoTask{ID: initial.ID, Status: "processing", Progress: 5})
	if err != nil || changed {
		t.Fatal("late poll revived a terminal video", err)
	}
}

func TestBatch1VideoPendingUpdateStillBindsUpstreamAndClearsErrors(t *testing.T) {
	resultDB(t)
	initial := model.VideoTask{ID: "bind-upstream", UserID: "owner", Status: "queued", WorkflowRef: "workflow-ref", RequestBody: "creation-request", ResponseBody: "creation-response", Error: "old error", ErrorDetail: "old detail"}
	if _, err := SaveVideoTask(initial); err != nil {
		t.Fatal(err)
	}
	update := initial
	update.Status, update.Progress, update.UpstreamTaskID, update.UpstreamVideoID, update.StartedAt = "running", 10, "task-upstream", "video-upstream", "started"
	update.Error, update.ErrorDetail = "", ""
	if changed, err := SavePendingVideoTaskPoll(update); err != nil || !changed {
		t.Fatal("pending handoff was not saved", err)
	}
	stored, found, err := GetUserVideoTask("owner", initial.ID)
	if err != nil || !found || stored.UpstreamTaskID != "task-upstream" || stored.UpstreamVideoID != "video-upstream" || stored.StartedAt != "started" || stored.Error != "" || stored.ErrorDetail != "" {
		t.Fatal("pending update lost upstream binding, started time, or zero-value clearing", err)
	}
	if stored.WorkflowRef != initial.WorkflowRef || stored.RequestBody != initial.RequestBody || stored.ResponseBody != initial.ResponseBody {
		t.Fatal("upstream handoff changed creation payloads")
	}
}

func TestBatch1TaskCreationKeepsFullPayloads(t *testing.T) {
	resultDB(t)
	request, response, workflow := "complete request", "complete response", `{"kind":"workflow"}`
	video, err := SaveVideoTask(model.VideoTask{ID: "create-video", UserID: "owner", RequestBody: request, ResponseBody: response, WorkflowRef: workflow})
	if err != nil {
		t.Fatal(err)
	}
	video, found, err := GetUserVideoTask("owner", video.ID)
	if err != nil || !found || video.RequestBody != request || video.ResponseBody != response || video.WorkflowRef != workflow {
		t.Fatal("video creation was cropped", err)
	}
	image, err := SaveCanvasImageTask(model.CanvasImageTask{ID: "create-image", UserID: "owner", RequestBody: request, ResponseBody: response, WorkflowRef: workflow})
	if err != nil {
		t.Fatal(err)
	}
	image, found, err = GetUserCanvasImageTask("owner", image.ID)
	if err != nil || !found || image.RequestBody != request || image.ResponseBody != response || image.WorkflowRef != workflow {
		t.Fatal("image creation was cropped", err)
	}
	audio, err := SaveCanvasAudioTask(model.CanvasAudioTask{ID: "create-audio", UserID: "owner", RequestBody: request, ResponseBody: response, WorkflowRef: workflow})
	if err != nil {
		t.Fatal(err)
	}
	audio, found, err = GetUserCanvasAudioTask("owner", audio.ID)
	if err != nil || !found || audio.RequestBody != request || audio.ResponseBody != response || audio.WorkflowRef != workflow {
		t.Fatal("audio creation was cropped", err)
	}
}

func TestBatch1WorkflowPollingRemainsSeparateAndFullReadsKeepReference(t *testing.T) {
	database := resultDB(t)
	ref := `{"scope":"system","kind":"video","workflowId":"workflow"}`
	for _, task := range []model.VideoTask{
		{ID: "workflow", UserID: "owner", Status: "running", WorkflowRef: ref, UpstreamTaskID: "workflow-upstream", RequestBody: "workflow-request", ResponseBody: "workflow-response", CreatedAt: "1"},
		{ID: "regular", UserID: "owner", Status: "processing", UpstreamTaskID: "regular-upstream", CreatedAt: "2"},
		{ID: "null-ref", UserID: "owner", Status: "queued", UpstreamVideoID: "null-upstream", CreatedAt: "3"},
		{ID: "not-submitted", UserID: "owner", Status: "queued", CreatedAt: "4"},
	} {
		if _, err := SaveVideoTask(task); err != nil {
			t.Fatal(err)
		}
	}
	if err := database.Model(&model.VideoTask{}).Where("id = ?", "null-ref").UpdateColumn("workflow_ref", nil).Error; err != nil {
		t.Fatal(err)
	}
	regular, err := ListDueVideoTasks(100)
	if err != nil || len(regular) != 2 || regular[0].ID != "regular" || regular[1].ID != "null-ref" {
		t.Fatalf("normal/workflow routing changed: count=%d err=%v", len(regular), err)
	}
	workflow, err := ListDueRunningHubWorkflowTasks("", "", 100)
	if err != nil || len(workflow) != 1 || workflow[0].ID != "workflow" || workflow[0].WorkflowRef != ref {
		t.Fatal("nonempty workflow reference was lost from its actual poller", err)
	}
	full, found, err := GetUserVideoTask("owner", "workflow")
	if err != nil || !found || full.WorkflowRef != ref || full.RequestBody != "workflow-request" || full.ResponseBody != "workflow-response" {
		t.Fatal("single-task API no longer returns the complete workflow task", err)
	}
	listed, err := ListUserVideoTasks("owner", "", 100)
	if err != nil || len(listed) != 4 {
		t.Fatal("API list filtering changed", err)
	}
	for _, task := range listed {
		if task.ID == "workflow" && (task.WorkflowRef != ref || task.RequestBody != "workflow-request") {
			t.Fatal("poll-only projection leaked into the API list")
		}
	}
}

func TestBatch1ImageStatusUpdateWritesOnlyMutableFieldsAndKeepsArchiveCAS(t *testing.T) {
	database := resultDB(t)
	initial := resultTask("image-update-fields")
	initial.Status, initial.Progress, initial.CompletedAt = "processing", 5, ""
	initial.Prompt, initial.WorkflowRef, initial.ChannelID, initial.Credits = "original prompt", "original-workflow", "channel", 7
	if _, err := SaveCanvasImageTask(initial); err != nil {
		t.Fatal(err)
	}
	sql := captureTaskSQL(t, database, "update")
	update := initial
	update.Prompt, update.WorkflowRef, update.ChannelID, update.Credits, update.CreatedAt = "stale prompt", "", "", 0, ""
	update.Status, update.Progress, update.RequestBody, update.ResponseBody = "running", 10, "output-format notice", `{"upstreamTaskId":"workflow-job"}`
	update.StartedAt, update.UpdatedAt = "started", "updated"
	if _, err := UpdateCanvasImageTask(update); err != nil {
		t.Fatal(err)
	}
	stored, found, err := GetUserCanvasImageTask("owner", initial.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if stored.Prompt != initial.Prompt || stored.WorkflowRef != initial.WorkflowRef || stored.ChannelID != initial.ChannelID || stored.Credits != initial.Credits || stored.CreatedAt != initial.CreatedAt {
		t.Errorf("image status update rewrote creation fields: prompt=%q workflow=%q channel=%q credits=%v", stored.Prompt, stored.WorkflowRef, stored.ChannelID, stored.Credits)
	}
	if stored.Status != "running" || stored.Progress != 10 || stored.RequestBody != "output-format notice" || stored.ResponseBody != update.ResponseBody || stored.StartedAt != "started" {
		t.Fatal("image output-format notice or workflow handoff was lost")
	}
	workflow, err := ListDueRunningHubWorkflowTasks("", "", 100)
	if err != nil || len(workflow) != 1 || workflow[0].ID != initial.ID || workflow[0].WorkflowRef != initial.WorkflowRef || workflow[0].UpstreamTaskID != update.ResponseBody {
		t.Fatal("image response_body handoff is no longer discoverable by the workflow poller", err)
	}
	for _, statement := range *sql {
		set := strings.Split(statement, " where ")[0]
		for _, field := range []string{"`prompt`", "`workflow_ref`", "`credits`", "`channel_id`", "`created_at`"} {
			if strings.Contains(set, field) {
				t.Errorf("image UPDATE still includes immutable %s", field)
			}
		}
	}
	stored.Status, stored.Progress, stored.CompletedAt, stored.WorkflowRef = "completed", 100, "done", initial.WorkflowRef
	if _, err := UpdateCanvasImageTask(stored); err != nil {
		t.Fatal(err)
	}
	var archive model.CanvasImageTaskResult
	if err := database.First(&archive, "user_id = ? AND task_id = ?", "owner", initial.ID).Error; err != nil {
		t.Fatal("completion did not archive atomically", err)
	}
	var result model.CanvasImageTask
	if err := json.Unmarshal([]byte(archive.ResultJSON), &result); err != nil || result.StorageKey != initial.StorageKey || result.Status != "completed" {
		t.Fatal("completion archive changed", err)
	}
	stored.Status, stored.ImageURL = "processing", "/api/files/stale/content"
	late, err := UpdateCanvasImageTask(stored)
	if err != nil || late.Status != "completed" || late.ImageURL != initial.ImageURL {
		t.Fatal("late image update bypassed terminal CAS", err)
	}
}

func TestBatch1AudioStatusUpdatePreservesInputsAndWorkflowHandoff(t *testing.T) {
	database := resultDB(t)
	initial := model.CanvasAudioTask{ID: "audio-update-fields", UserID: "owner", Status: "queued", Prompt: "original prompt", RequestBody: "original request", WorkflowRef: "original workflow", ChannelID: "audio-channel", Credits: 3, CreatedAt: "created"}
	if _, err := SaveCanvasAudioTask(initial); err != nil {
		t.Fatal(err)
	}
	sql := captureTaskSQL(t, database, "update")
	update := initial
	update.Prompt, update.RequestBody, update.WorkflowRef, update.ChannelID, update.Credits, update.CreatedAt = "stale prompt", "", "", "", 0, ""
	update.Status, update.Progress, update.ResponseBody, update.StartedAt = "running", 10, `{"upstreamTaskId":"audio-job"}`, "started"
	if _, err := UpdateCanvasAudioTask(update); err != nil {
		t.Fatal(err)
	}
	stored, found, err := GetUserCanvasAudioTask("owner", initial.ID)
	if err != nil || !found {
		t.Fatal(err)
	}
	if stored.Prompt != initial.Prompt || stored.RequestBody != initial.RequestBody || stored.WorkflowRef != initial.WorkflowRef || stored.ChannelID != initial.ChannelID || stored.Credits != initial.Credits || stored.CreatedAt != initial.CreatedAt {
		t.Errorf("audio status update rewrote inputs: request=%q workflow=%q prompt=%q", stored.RequestBody, stored.WorkflowRef, stored.Prompt)
	}
	if stored.ResponseBody != update.ResponseBody || stored.Status != "running" || stored.Progress != 10 || stored.StartedAt != "started" {
		t.Fatal("audio workflow handoff or progress lost")
	}
	workflow, err := ListDueRunningHubWorkflowTasks("", "", 100)
	if err != nil || len(workflow) != 1 || workflow[0].ID != initial.ID || workflow[0].WorkflowRef != initial.WorkflowRef || workflow[0].UpstreamTaskID != update.ResponseBody {
		t.Fatal("audio response_body handoff is no longer discoverable by the workflow poller", err)
	}
	for _, statement := range *sql {
		set := strings.Split(statement, " where ")[0]
		for _, field := range []string{"`prompt`", "`request_body`", "`workflow_ref`", "`credits`", "`created_at`"} {
			if strings.Contains(set, field) {
				t.Errorf("audio UPDATE still includes immutable %s", field)
			}
		}
	}
	stored.Status, stored.Progress, stored.ResponseBody = "completed", 100, "[binary audio]"
	stored.AudioURL, stored.StorageKey, stored.MimeType, stored.Bytes, stored.CompletedAt = "/api/files/audio/content", "server:audio", "audio/wav", 100, "done"
	if _, err := UpdateCanvasAudioTask(stored); err != nil {
		t.Fatal(err)
	}
	stored.Status, stored.Progress = "processing", 0
	late, err := UpdateCanvasAudioTask(stored)
	if err != nil || late.Status != "completed" || late.AudioURL != "/api/files/audio/content" || late.StorageKey != "server:audio" {
		t.Fatal("late audio update bypassed terminal CAS", err)
	}
}
