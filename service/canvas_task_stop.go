package service

import (
	"context"
	"encoding/json"
	"strings"
	"sync"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type canvasTaskRun struct {
	ctx    context.Context
	cancel context.CancelFunc
	refs   int
}

var canvasTaskRuns sync.Map
var canvasTaskRunsMu sync.Mutex

// Match the existing failure-refund audit identity; repository reuses
// refundUserCredits inside the cancellation transaction.
func newAIRefundLog(userID, channelID, modelName, path string) model.CreditLog {
	extra, _ := json.Marshal(map[string]string{"channelId": channelID, "model": modelName, "path": path})
	return model.CreditLog{ID: newID("credit"), UserID: userID, Type: model.CreditLogTypeAIRefund, Remark: "模型调用失败返还 " + modelName, Extra: string(extra), CreatedAt: now()}
}

func canvasTaskKind(kind, taskID string) string {
	if kind == "workflow" {
		for _, capability := range []string{"image", "audio", "video"} {
			if strings.HasPrefix(taskID, "wf-"+capability+"-") {
				return capability
			}
		}
	}
	return kind
}

// Recheck durable state: a stop can win before the goroutine registers.
// Concurrent polls share a cancel scope; only the last release removes it.
func CanvasTaskContext(kind, userID, taskID string) (context.Context, func()) {
	kind = canvasTaskKind(strings.ToLower(strings.TrimSpace(kind)), taskID)
	key := kind + ":" + userID + ":" + taskID
	canvasTaskRunsMu.Lock()
	value, exists := canvasTaskRuns.Load(key)
	var run *canvasTaskRun
	if exists {
		run = value.(*canvasTaskRun)
	} else {
		ctx, cancel := context.WithCancel(context.Background())
		run = &canvasTaskRun{ctx: ctx, cancel: cancel}
		canvasTaskRuns.Store(key, run)
	}
	run.refs++
	canvasTaskRunsMu.Unlock()
	if status, found, err := canvasTaskStatus(kind, userID, taskID); err != nil || (found && IsTerminalGenerationTaskStatus(status)) {
		run.cancel()
	}
	return run.ctx, func() {
		canvasTaskRunsMu.Lock()
		defer canvasTaskRunsMu.Unlock()
		run.refs--
		if run.refs == 0 {
			canvasTaskRuns.CompareAndDelete(key, run)
			run.cancel()
		}
	}
}

func IsTerminalGenerationTaskStatus(status string) bool {
	return IsCompletedVideoTaskStatus(status) || IsFailedVideoTaskStatus(status) || IsCancelledVideoTaskStatus(status)
}

func canvasTaskStatus(kind, userID, taskID string) (string, bool, error) {
	switch kind {
	case "image":
		task, found, err := repository.GetUserCanvasImageTask(userID, taskID)
		return task.Status, found, err
	case "audio":
		task, found, err := repository.GetUserCanvasAudioTask(userID, taskID)
		return task.Status, found, err
	case "video":
		task, found, err := repository.GetUserVideoTask(userID, taskID)
		return task.Status, found, err
	}
	return "", false, nil
}

func StopCanvasTask(kind, userID, taskID string) (status string, stopped bool, refunded bool, err error) {
	kind, taskID, userID = strings.ToLower(strings.TrimSpace(kind)), strings.TrimSpace(taskID), strings.TrimSpace(userID)
	if kind == "workflow" && !strings.HasPrefix(taskID, "wf-") {
		for _, capability := range []string{"image", "audio", "video"} {
			if strings.Contains(taskID, "_"+capability+"_task_") {
				taskID = workflowTaskID(userID, capability, taskID)
				break
			}
		}
	}
	kind = canvasTaskKind(strings.ToLower(strings.TrimSpace(kind)), strings.TrimSpace(taskID))
	if kind == "video" {
		task, found, readErr := repository.GetUserVideoTask(userID, taskID)
		if readErr != nil || !found {
			return "", false, false, readErr
		}
		taskID = task.ID
	}
	// Interrupt in-flight network/persistence before waiting for the commit lock.
	// Never cancel another owner's run or a task already known to be terminal.
	if current, found, readErr := canvasTaskStatus(kind, userID, taskID); readErr != nil {
		return "", false, false, readErr
	} else if found && !IsTerminalGenerationTaskStatus(current) {
		if value, ok := canvasTaskRuns.Load(kind + ":" + userID + ":" + taskID); ok {
			value.(*canvasTaskRun).cancel()
		}
	}
	release := acquireWorkflowFinishLock(taskID)
	defer release()
	status, stopped, refunded, err = repository.CancelGenerationTaskAndRefund(kind, userID, taskID, now(), func(channelID, modelName, path, rawRef string) model.CreditLog {
		if rawRef != "" {
			var ref WorkflowRef
			_ = json.Unmarshal([]byte(rawRef), &ref)
			modelName = workflowBillingName(ref)
			path = "/api/v1/workflow-tasks"
		}
		return newAIRefundLog(userID, channelID, modelName, path)
	})
	if err == nil && status == "cancelled" {
		if value, found := canvasTaskRuns.Load(kind + ":" + userID + ":" + taskID); found {
			value.(*canvasTaskRun).cancel()
		}
	}
	return
}

// Serialize result persistence with stop; the durable CAS is the final guard.
func CanvasTaskResultGuard(ctx context.Context, kind, userID, taskID string) (func(), bool) {
	release := acquireWorkflowFinishLock(taskID)
	status, found, err := canvasTaskStatus(kind, userID, taskID)
	if ctx.Err() != nil || err != nil || !found || IsTerminalGenerationTaskStatus(status) {
		release()
		return func() {}, false
	}
	return release, true
}
