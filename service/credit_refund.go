package service

import (
	"encoding/json"

	"github.com/tigerowo/infinite-canvas/model"
)

func newAIRefundLog(userID, channelID, modelName, path, remarkPrefix string) model.CreditLog {
	extra, _ := json.Marshal(map[string]string{"channelId": channelID, "model": modelName, "path": path})
	return model.CreditLog{
		ID:        newID("credit"),
		UserID:    userID,
		Type:      model.CreditLogTypeAIRefund,
		Remark:    remarkPrefix + modelName,
		Extra:     string(extra),
		CreatedAt: now(),
	}
}
