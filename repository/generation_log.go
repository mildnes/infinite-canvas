package repository

import (
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

func ListVideoGenerationLogs(userID string, limit int) ([]model.VideoGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 500
	}
	var logs []model.VideoGenerationLog
	err = db.Where("user_id = ? AND deleted_at = ?", userID, "").Order("created_at DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

func HasAnyVideoGenerationLog(userID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.VideoGenerationLog{}).Where("user_id = ?", userID).Count(&count).Error
	return count > 0, err
}

func UpsertVideoGenerationLogs(userID string, logs []model.VideoGenerationLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	for _, log := range logs {
		log.UserID = userID
		if strings.TrimSpace(log.ID) == "" || isDeletedVideoGenerationLog(userID, log) {
			continue
		}
		var existing model.VideoGenerationLog
		found := false
		if err := db.Where("user_id = ? AND id = ?", userID, log.ID).First(&existing).Error; err == nil {
			found = true
		} else if log.TaskID != "" {
			if err := db.Where("user_id = ? AND deleted_at = ? AND task_id = ?", userID, "", log.TaskID).First(&existing).Error; err == nil {
				found = true
			}
		}
		if !found && log.VideoID != "" {
			if err := db.Where("user_id = ? AND deleted_at = ? AND video_id = ?", userID, "", log.VideoID).First(&existing).Error; err == nil {
				found = true
			}
		}
		if found {
			if generationLogStatusIsTerminal(existing.Status) && !generationLogStatusIsTerminal(log.Status) {
				continue
			}
			log.ID = existing.ID
			log.UserID = userID
			log.DeletedAt = ""
		}
		if err := db.Save(&log).Error; err != nil {
			return err
		}
	}
	return nil
}

func SoftDeleteVideoGenerationLog(userID string, id string, deletedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	var log model.VideoGenerationLog
	err = db.Where("user_id = ? AND (id = ? OR task_id = ? OR video_id = ?)", userID, id, id, id).First(&log).Error
	if err != nil {
		return nil
	}
	return db.Model(&log).Updates(map[string]any{
		"deleted_at":   deletedAt,
		"updated_at":   deletedAt,
		"payload_json": "",
	}).Error
}

func SoftDeleteVideoGenerationLogs(userID string, ids []string, deletedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	keys := generationLogIdentityValues(ids...)
	if len(keys) == 0 {
		return nil
	}
	return db.Model(&model.VideoGenerationLog{}).
		Where("user_id = ? AND (id IN ? OR task_id IN ? OR video_id IN ?)", userID, keys, keys, keys).
		Updates(map[string]any{
			"deleted_at":   deletedAt,
			"updated_at":   deletedAt,
			"payload_json": "",
		}).Error
}

func CleanupDeletedVideoGenerationLogs(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("deleted_at <> ? AND deleted_at < ?", "", before).Delete(&model.VideoGenerationLog{}).Error
}

func ListImageGenerationLogs(userID string, limit int) ([]model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 500
	}
	var logs []model.ImageGenerationLog
	err = db.Where("user_id = ? AND deleted_at = ?", userID, "").Order("created_at DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

// PageImageGenerationLogs never selects the potentially large legacy payload.
func PageImageGenerationLogs(userID, createdAt, id string, limit int) ([]model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	query := db.Model(&model.ImageGenerationLog{}).Select("id", "user_id", "task_id", "image_id", "status", "created_at", "summary_json").
		Where("user_id = ? AND deleted_at = ? AND summary_json <> ?", userID, "", "")
	if createdAt != "" && id != "" {
		query = query.Where("created_at < ? OR (created_at = ? AND id < ?)", createdAt, createdAt, id)
	}
	var logs []model.ImageGenerationLog
	err = query.Order("created_at DESC, id DESC").Limit(limit).Find(&logs).Error
	return logs, err
}

func GetImageGenerationLog(userID, id string) (model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return model.ImageGenerationLog{}, err
	}
	var log model.ImageGenerationLog
	err = db.Where("user_id = ? AND id = ? AND deleted_at = ?", userID, id, "").First(&log).Error
	return log, err
}

func ListImageGenerationLogsForCleanup(userID string, ids []string) ([]model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	keys := generationLogIdentityValues(ids...)
	if len(keys) == 0 {
		return []model.ImageGenerationLog{}, nil
	}
	var logs []model.ImageGenerationLog
	err = db.Model(&model.ImageGenerationLog{}).Select("id", "summary_json").
		Where("user_id = ? AND deleted_at = ? AND (id IN ? OR task_id IN ? OR image_id IN ?)", userID, "", keys, keys, keys).
		Find(&logs).Error
	if err != nil {
		return nil, err
	}
	missing := make([]string, 0)
	for _, log := range logs {
		if strings.TrimSpace(log.SummaryJSON) == "" {
			missing = append(missing, log.ID)
		}
	}
	if len(missing) == 0 {
		return logs, nil
	}
	var payloads []model.ImageGenerationLog
	if err = db.Model(&model.ImageGenerationLog{}).Select("id", "payload_json").
		Where("user_id = ? AND deleted_at = ? AND id IN ?", userID, "", missing).
		Find(&payloads).Error; err != nil {
		return nil, err
	}
	byID := make(map[string]string, len(payloads))
	for _, log := range payloads {
		byID[log.ID] = log.PayloadJSON
	}
	for index := range logs {
		logs[index].PayloadJSON = byID[logs[index].ID]
	}
	return logs, err
}

func SaveImageGenerationSummary(userID, id, summary string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.ImageGenerationLog{}).
		Where("user_id = ? AND id = ? AND deleted_at = ? AND (summary_json = ? OR summary_json IS NULL)", userID, id, "", "").
		Update("summary_json", summary).Error
}

// ListImageLogsForSummary reads at most one small batch of legacy payloads.
func ListImageLogsForSummary(after string, limit int) ([]model.ImageGenerationLog, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var logs []model.ImageGenerationLog
	err = db.Model(&model.ImageGenerationLog{}).Select("id", "user_id", "payload_json").
		Where("id > ? AND deleted_at = ? AND (summary_json = ? OR summary_json IS NULL)", after, "", "").
		Order("id").Limit(limit).Find(&logs).Error
	return logs, err
}

// DeleteWorkbenchImageLogs atomically hides account logs and their own workbench tasks.
func DeleteWorkbenchImageLogs(userID string, ids, taskIDs []string, deletedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		if len(ids) > 0 {
			if err := tx.Model(&model.ImageGenerationLog{}).Where("user_id = ? AND (id IN ? OR task_id IN ? OR image_id IN ?)", userID, ids, ids, ids).
				Updates(map[string]any{"deleted_at": deletedAt, "updated_at": deletedAt, "payload_json": "", "summary_json": ""}).Error; err != nil {
				return err
			}
		}
		if len(taskIDs) > 0 {
			return tx.Where("user_id = ? AND id IN ? AND source IN ?", userID, taskIDs, []string{"image-workbench", "workflow"}).Delete(&model.CanvasImageTask{}).Error
		}
		return nil
	})
}

func HasAnyImageGenerationLog(userID string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	var count int64
	err = db.Model(&model.ImageGenerationLog{}).Where("user_id = ?", userID).Count(&count).Error
	return count > 0, err
}

func UpsertImageGenerationLogs(userID string, logs []model.ImageGenerationLog) error {
	db, err := DB()
	if err != nil {
		return err
	}
	for _, log := range logs {
		log.UserID = userID
		if strings.TrimSpace(log.ID) == "" || isDeletedImageGenerationLog(userID, log) {
			continue
		}
		var existing model.ImageGenerationLog
		found := false
		if err := db.Where("user_id = ? AND id = ?", userID, log.ID).First(&existing).Error; err == nil {
			found = true
		} else if log.TaskID != "" {
			if err := db.Where("user_id = ? AND deleted_at = ? AND task_id = ?", userID, "", log.TaskID).First(&existing).Error; err == nil {
				found = true
			}
		}
		if !found && log.ImageID != "" {
			if err := db.Where("user_id = ? AND deleted_at = ? AND image_id = ?", userID, "", log.ImageID).First(&existing).Error; err == nil {
				found = true
			}
		}
		if found {
			if generationLogStatusIsTerminal(existing.Status) && !generationLogStatusIsTerminal(log.Status) {
				continue
			}
			log.ID = existing.ID
			log.UserID = userID
			log.DeletedAt = ""
		}
		if err := db.Save(&log).Error; err != nil {
			return err
		}
	}
	return nil
}

func generationLogStatusIsTerminal(status string) bool {
	switch strings.ToLower(strings.TrimSpace(status)) {
	case "成功", "失败", "success", "succeeded", "completed", "failed", "error", "cancelled", "canceled":
		return true
	default:
		return false
	}
}

func SoftDeleteImageGenerationLog(userID string, id string, deletedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	var log model.ImageGenerationLog
	err = db.Where("user_id = ? AND (id = ? OR task_id = ? OR image_id = ?)", userID, id, id, id).First(&log).Error
	if err != nil {
		return nil
	}
	return db.Model(&log).Updates(map[string]any{
		"deleted_at":   deletedAt,
		"updated_at":   deletedAt,
		"payload_json": "",
		"summary_json": "",
	}).Error
}

func SoftDeleteImageGenerationLogs(userID string, ids []string, deletedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	keys := generationLogIdentityValues(ids...)
	if len(keys) == 0 {
		return nil
	}
	return db.Model(&model.ImageGenerationLog{}).
		Where("user_id = ? AND (id IN ? OR task_id IN ? OR image_id IN ?)", userID, keys, keys, keys).
		Updates(map[string]any{
			"deleted_at":   deletedAt,
			"updated_at":   deletedAt,
			"payload_json": "",
			"summary_json": "",
		}).Error
}

func CleanupDeletedImageGenerationLogs(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Where("deleted_at <> ? AND deleted_at < ?", "", before).Delete(&model.ImageGenerationLog{}).Error
}

func isDeletedVideoGenerationLog(userID string, log model.VideoGenerationLog) bool {
	db, err := DB()
	if err != nil {
		return false
	}
	keys := generationLogIdentityValues(log.ID, log.TaskID, log.VideoID)
	if len(keys) == 0 {
		return false
	}
	var count int64
	_ = db.Model(&model.VideoGenerationLog{}).
		Where("user_id = ? AND deleted_at <> ? AND (id IN ? OR task_id IN ? OR video_id IN ?)", userID, "", keys, keys, keys).
		Count(&count).Error
	return count > 0
}

func isDeletedImageGenerationLog(userID string, log model.ImageGenerationLog) bool {
	db, err := DB()
	if err != nil {
		return false
	}
	keys := generationLogIdentityValues(log.ID, log.TaskID, log.ImageID)
	if len(keys) == 0 {
		return false
	}
	var count int64
	_ = db.Model(&model.ImageGenerationLog{}).
		Where("user_id = ? AND deleted_at <> ? AND (id IN ? OR task_id IN ? OR image_id IN ?)", userID, "", keys, keys, keys).
		Count(&count).Error
	return count > 0
}

func generationLogIdentityValues(values ...string) []string {
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
