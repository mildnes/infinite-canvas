package service

import (
	"errors"
	"log"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/repository"
)

const GenerationTaskTimeout = 30 * time.Minute

const generationTaskFinalizeInterval = 10 * time.Minute
const interruptedGenerationTaskError = "任务已中断（服务重启或上游超时）"

var orphanTaskFinalizerOnce sync.Once

type OrphanTaskFinalizeResult struct {
	Images int
	Audio  int
	Videos int
}

func StartOrphanTaskFinalizer() {
	orphanTaskFinalizerOnce.Do(func() {
		finalizeOrphanedGenerationTasksAndLog()
		go func() {
			ticker := time.NewTicker(generationTaskFinalizeInterval)
			defer ticker.Stop()
			for range ticker.C {
				finalizeOrphanedGenerationTasksAndLog()
			}
		}()
	})
}

func FinalizeOrphanedGenerationTasks(current time.Time) (OrphanTaskFinalizeResult, error) {
	result := OrphanTaskFinalizeResult{}
	cutoff := current.Add(-GenerationTaskTimeout)
	completedAt := current.UTC().Format(time.RFC3339Nano)
	var errs []error

	images, err := repository.ListActiveCanvasImageTasks()
	if err != nil {
		errs = append(errs, err)
	} else {
		for _, task := range images {
			if !generationTaskStartedBefore(task.StartedAt, task.CreatedAt, cutoff) {
				continue
			}
			changed, finalizeErr := repository.FailActiveCanvasImageTask(task.ID, completedAt, interruptedGenerationTaskError, "")
			if finalizeErr != nil {
				errs = append(errs, finalizeErr)
				continue
			}
			if changed {
				result.Images++
				refundInterruptedTask(task.UserID, task.ChannelID, task.Model, task.Credits, generationTaskBillingPath(task.WorkflowRef, task.Endpoint))
			}
		}
	}

	audio, err := repository.ListActiveCanvasAudioTasks()
	if err != nil {
		errs = append(errs, err)
	} else {
		for _, task := range audio {
			if !generationTaskStartedBefore(task.StartedAt, task.CreatedAt, cutoff) {
				continue
			}
			changed, finalizeErr := repository.FailActiveCanvasAudioTask(task.ID, completedAt, interruptedGenerationTaskError, "")
			if finalizeErr != nil {
				errs = append(errs, finalizeErr)
				continue
			}
			if changed {
				result.Audio++
				refundInterruptedTask(task.UserID, task.ChannelID, task.Model, task.Credits, generationTaskBillingPath(task.WorkflowRef, task.Endpoint))
			}
		}
	}

	videos, err := repository.ListActiveVideoTasks()
	if err != nil {
		errs = append(errs, err)
	} else {
		for _, task := range videos {
			if !generationTaskStartedBefore(task.StartedAt, task.CreatedAt, cutoff) {
				continue
			}
			changed, finalizeErr := repository.FailActiveVideoTask(task.ID, completedAt, interruptedGenerationTaskError)
			if finalizeErr != nil {
				errs = append(errs, finalizeErr)
				continue
			}
			if changed {
				result.Videos++
				refundInterruptedTask(task.UserID, task.ChannelID, task.Model, task.Credits, generationTaskBillingPath(task.WorkflowRef, "/videos"))
			}
		}
	}
	return result, errors.Join(errs...)
}

func generationTaskStartedBefore(startedAt, createdAt string, cutoff time.Time) bool {
	value := strings.TrimSpace(startedAt)
	if value == "" {
		value = strings.TrimSpace(createdAt)
	}
	started, err := time.Parse(time.RFC3339Nano, value)
	return err == nil && !started.After(cutoff)
}

func refundInterruptedTask(userID, channelID, modelName string, credits int, path string) {
	if credits <= 0 {
		return
	}
	if err := RefundUserCredits(userID, channelID, modelName, credits, path); err != nil {
		log.Printf("refund interrupted generation task failed user=%s model=%s err=%v", userID, modelName, err)
	}
}

func generationTaskBillingPath(workflowRef, fallback string) string {
	if strings.TrimSpace(workflowRef) != "" {
		return "/api/v1/workflow-tasks"
	}
	return fallback
}

func finalizeOrphanedGenerationTasksAndLog() {
	result, err := FinalizeOrphanedGenerationTasks(time.Now())
	if err != nil {
		log.Printf("finalize orphaned generation tasks failed err=%v", err)
	}
	if result.Images+result.Audio+result.Videos > 0 {
		log.Printf("finalized orphaned generation tasks images=%d audio=%d videos=%d", result.Images, result.Audio, result.Videos)
	}
}
