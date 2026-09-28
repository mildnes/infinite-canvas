package repository

import (
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
)

// LookupWorkflowTaskUserID resolves the owner of a generated workflow task
// without trusting the Bridge owner scope. System-owned Bridges still execute
// tasks for an individual account, so media must be recorded under that user.
func LookupWorkflowTaskUserID(taskID string) (string, error) {
	db, err := DB()
	if err != nil {
		return "", err
	}
	taskID = strings.TrimSpace(taskID)
	if taskID == "" {
		return "", errors.New("工作流任务缺少 ID")
	}
	var row struct {
		UserID string `gorm:"column:user_id"`
	}
	var table any
	switch {
	case strings.HasPrefix(taskID, "wf-image-"):
		table = &model.CanvasImageTask{}
	case strings.HasPrefix(taskID, "wf-video-"):
		table = &model.VideoTask{}
	case strings.HasPrefix(taskID, "wf-audio-"):
		table = &model.CanvasAudioTask{}
	default:
		return "", errors.New("工作流任务 ID 无效")
	}
	if err := db.Model(table).Select("user_id").Where("id = ?", taskID).Scan(&row).Error; err != nil {
		return "", err
	}
	if strings.TrimSpace(row.UserID) == "" {
		return "", errors.New("工作流任务用户不存在")
	}
	return strings.TrimSpace(row.UserID), nil
}
