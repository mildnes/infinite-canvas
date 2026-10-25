package repository

import (
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func SaveCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}
	result := db.Clauses(clause.OnConflict{DoNothing: true}).Create(&task)
	if result.Error != nil || result.RowsAffected > 0 {
		return task, result.Error
	}
	var existing model.CanvasImageTask
	if err := db.First(&existing, "id = ?", task.ID).Error; err != nil {
		return task, err
	}
	if existing.UserID != task.UserID {
		return task, errors.New("图片任务 ID 已被占用")
	}
	return existing, nil
}

func UpdateCanvasImageTask(task model.CanvasImageTask) (model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return task, err
	}

	changed := false
	err = db.Transaction(func(tx *gorm.DB) error {
		result := tx.Model(&model.CanvasImageTask{}).
			Where("user_id = ? AND id = ? AND status IN ?", task.UserID, task.ID, activeGenerationTaskStatuses).
			Select("*").Updates(&task)
		if result.Error != nil {
			return result.Error
		}
		changed = result.RowsAffected > 0
		if changed {
			return archiveCanvasImageResult(tx, task)
		}
		return nil
	})
	if err != nil || changed {
		return task, err
	}
	current, found, err := GetUserCanvasImageTask(task.UserID, task.ID)
	if err != nil || !found {
		return task, err
	}
	return current, nil
}

func GetUserCanvasImageTask(userID string, id string) (model.CanvasImageTask, bool, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasImageTask{}, false, err
	}
	var task model.CanvasImageTask
	err = db.First(&task, "user_id = ? AND id = ?", userID, id).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		results, readErr := archivedCanvasImageResults(db, userID, []string{id})
		if readErr != nil || len(results) == 0 {
			return model.CanvasImageTask{}, false, readErr
		}
		return results[0], true, nil
	}
	if err != nil {
		return model.CanvasImageTask{}, false, err
	}
	return task, true, nil
}

func ListUserCanvasImageTasks(userID string, sources []string, limit int) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	var tasks []model.CanvasImageTask
	query := db.Where("user_id = ?", userID)
	if len(sources) > 0 {
		query = query.Where("source IN ?", sources)
	}
	err = query.
		Where("status IN ?", []string{"queued", "processing", "running", "in_progress"}).
		Order("created_at DESC").
		Limit(limit).
		Find(&tasks).Error
	return tasks, err
}

func BatchUserCanvasImageTasks(userID string, ids []string) ([]model.CanvasImageTask, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	keys := uniqueTrimmedValues(ids...)
	if len(keys) == 0 {
		return []model.CanvasImageTask{}, nil
	}
	var tasks []model.CanvasImageTask
	err = db.Where("user_id = ? AND id IN ?", userID, keys).Find(&tasks).Error
	if err != nil {
		return nil, err
	}
	found := make(map[string]bool, len(tasks))
	for _, task := range tasks {
		found[task.ID] = true
	}
	missing := make([]string, 0, len(keys))
	for _, id := range keys {
		if !found[id] {
			missing = append(missing, id)
		}
	}
	archived, err := archivedCanvasImageResults(db, userID, missing)
	return append(tasks, archived...), err
}

func DeleteUserCanvasImageTask(userID string, id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	id = strings.TrimSpace(id)
	return db.Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("user_id = ? AND task_id = ?", userID, id).Delete(&model.CanvasImageTaskResult{}).Error; err != nil {
			return err
		}
		return tx.Where("user_id = ? AND id = ?", userID, id).Delete(&model.CanvasImageTask{}).Error
	})
}

func HasActiveCanvasImageTasks() (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.CanvasImageTask{}).
		Where("status IN ?", []string{"queued", "processing", "running", "in_progress"}).
		Count(&count).Error
	return count > 0, err
}

func DeleteFinishedCanvasImageTasksBefore(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		query := tx.Where("completed_at <> ? AND completed_at < ?", "", before).
			Where("status IN ?", []string{"completed", "failed", "cancelled"}).
			Where("source NOT IN ?", []string{"image-workbench", "workflow"})
		// Upgrade safety: archive already-completed rows before deleting their details.
		var tasks []model.CanvasImageTask
		if err := query.Find(&tasks).Error; err != nil {
			return err
		}
		for _, task := range tasks {
			if err := archiveCanvasImageResult(tx, task); err != nil {
				return err
			}
		}
		return query.Delete(&model.CanvasImageTask{}).Error
	})
}

func DeleteUserCanvasTasks(userID string, sourceID string, nodeIDs []string) error {
	// A node is a UI reference, not task ownership. Keep active runners and
	// terminal billing/audit records until the shared retention cleaner runs.
	// Project deletion still uses its own existing scheduled cleanup.
	return nil
}

func uniqueTrimmedValues(values ...string) []string {
	result := make([]string, 0, len(values))
	seen := map[string]bool{}
	for _, value := range values {
		value = strings.TrimSpace(value)
		if value != "" && !seen[value] {
			result = append(result, value)
			seen[value] = true
		}
	}
	return result
}
