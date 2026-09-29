package repository

import "github.com/tigerowo/infinite-canvas/model"

var activeGenerationTaskStatuses = []string{"queued", "processing", "running", "in_progress"}

func ListActiveCanvasImageTasks() ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var tasks []model.CanvasImageTask
	err = db.Where("status IN ?", activeGenerationTaskStatuses).Find(&tasks).Error
	return tasks, err
}

func ListActiveCanvasAudioTasks() ([]model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var tasks []model.CanvasAudioTask
	err = db.Where("status IN ?", activeGenerationTaskStatuses).Find(&tasks).Error
	return tasks, err
}

func ListActiveVideoTasks() ([]model.VideoTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var tasks []model.VideoTask
	err = db.Where("status IN ?", activeGenerationTaskStatuses).Find(&tasks).Error
	return tasks, err
}

func FailActiveCanvasImageTask(id, completedAt, message, detail string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.CanvasImageTask{}).
		Where("id = ? AND status IN ?", id, activeGenerationTaskStatuses).
		Updates(map[string]any{"status": "failed", "error": message, "error_detail": detail, "completed_at": completedAt, "updated_at": completedAt})
	return result.RowsAffected > 0, result.Error
}

func FailActiveCanvasAudioTask(id, completedAt, message, detail string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.CanvasAudioTask{}).
		Where("id = ? AND status IN ?", id, activeGenerationTaskStatuses).
		Updates(map[string]any{"status": "failed", "error": message, "error_detail": detail, "completed_at": completedAt, "updated_at": completedAt})
	return result.RowsAffected > 0, result.Error
}

func FailActiveVideoTask(id, completedAt, message string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.VideoTask{}).
		Where("id = ? AND status IN ?", id, activeGenerationTaskStatuses).
		Updates(map[string]any{"status": "failed", "error": message, "error_detail": "", "completed_at": completedAt, "updated_at": completedAt})
	return result.RowsAffected > 0, result.Error
}
