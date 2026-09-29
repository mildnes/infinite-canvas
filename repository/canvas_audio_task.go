package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm/clause"
)

func SaveCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&task)
	if result.Error != nil || result.RowsAffected > 0 {
		return task, result.Error
	}
	var existing model.CanvasAudioTask
	if err := db.First(&existing, "id = ?", task.ID).Error; err != nil {
		return task, err
	}
	if existing.UserID != task.UserID {
		return task, errors.New("音频任务 ID 已被占用")
	}
	return existing, nil
}

func UpdateCanvasAudioTask(task model.CanvasAudioTask) (model.CanvasAudioTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	result := db.Model(&model.CanvasAudioTask{}).
		Where("user_id = ? AND id = ? AND status IN ?", task.UserID, task.ID, activeGenerationTaskStatuses).
		Select("*").
		Updates(&task)
	if result.Error != nil || result.RowsAffected > 0 {
		return task, result.Error
	}
	current, found, err := GetUserCanvasAudioTask(task.UserID, task.ID)
	if err != nil || !found {
		return task, err
	}
	return current, nil
}

func GetUserCanvasAudioTask(userID string, id string) (model.CanvasAudioTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasAudioTask{}, false, err
	}
	var task model.CanvasAudioTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if err != nil {
		return model.CanvasAudioTask{}, false, nil
	}
	return task, true, nil
}
