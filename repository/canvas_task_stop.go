package repository

import (
	"errors"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
)

// The CAS and existing refund operation share a transaction. A failure rolls
// back cancellation so retrying cannot double-refund or leave it unpaid.
func CancelGenerationTaskAndRefund(kind, userID, id, completedAt string, newLog func(string, string, string, string) model.CreditLog) (status string, changed, refunded bool, err error) {
	db, err := DB()
	if err != nil {
		return "", false, false, err
	}
	var record any
	var cancelTask func(string, string, ...*gorm.DB) (bool, error)
	switch kind {
	case "image":
		record = &model.CanvasImageTask{}
		cancelTask = CancelActiveCanvasImageTask
	case "audio":
		record = &model.CanvasAudioTask{}
		cancelTask = CancelActiveCanvasAudioTask
	case "video":
		record = &model.VideoTask{}
		cancelTask = CancelActiveVideoTask
	default:
		return "", false, false, errors.New("不支持的任务类型")
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var row struct {
			Status                                                 string
			Credits                                                int
			ChannelID, UserChannelID, Model, Endpoint, WorkflowRef string
		}
		query := tx.Model(record).Select("status, credits, channel_id, user_channel_id, model, workflow_ref")
		if kind != "video" {
			query = query.Select("status, credits, channel_id, user_channel_id, model, workflow_ref, endpoint")
		}
		result := query.Where("id = ? AND user_id = ?", id, userID).Take(&row)
		if errors.Is(result.Error, gorm.ErrRecordNotFound) {
			return nil
		}
		if result.Error != nil {
			return result.Error
		}
		status = row.Status
		won, err := cancelTask(id, completedAt, tx)
		if err != nil {
			return err
		}
		if !won {
			if err := query.Where("id = ? AND user_id = ?", id, userID).Take(&row).Error; err != nil {
				return err
			}
			status = row.Status
			return nil
		}
		status, changed = "cancelled", true
		if row.UserChannelID != "" || row.Credits <= 0 {
			return nil
		}
		path := row.Endpoint
		if kind == "video" {
			path = "/videos"
		}
		user, found, err := refundUserCredits(tx, userID, row.Credits, completedAt)
		if err != nil {
			return err
		}
		if !found {
			return errors.New("用户不存在")
		}
		entry := newLog(row.ChannelID, row.Model, path, row.WorkflowRef)
		entry.Amount, entry.Balance = row.Credits, user.Credits
		if err = tx.Create(&entry).Error; err != nil {
			return err
		}
		refunded = true
		return nil
	})
	if err != nil {
		changed, refunded = false, false
	}
	return
}
