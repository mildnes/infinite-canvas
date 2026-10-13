package repository

import "github.com/tigerowo/infinite-canvas/model"

// Keep the existing poller awake until terminal-only queues expire as well.
// Without this, deleting the last node could leave its history forever.
func HasFinishedGenerationTasks() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	for _, record := range []any{&model.CanvasImageTask{}, &model.CanvasAudioTask{}, &model.VideoTask{}} {
		var count int64
		if err = db.Model(record).Where("status IN ? AND completed_at <> ?", []string{"completed", "failed", "cancelled", "canceled"}, "").Count(&count).Error; err != nil {
			return false, err
		}
		if count > 0 {
			return true, nil
		}
	}
	return false, nil
}
