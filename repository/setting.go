package repository

import (
	"encoding/json"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// GetSettings 返回 public 和 private 两行配置。
func GetSettings() (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return model.Settings{}, err
	}
	var items []model.Setting
	if err := db.Find(&items).Error; err != nil {
		return model.Settings{}, err
	}
	result := model.Settings{}
	for _, item := range items {
		if item.Key == model.SettingKeyPrivate {
			_ = json.Unmarshal(item.Value, &result.Private)
		} else if item.Key == model.SettingKeyPublic {
			_ = json.Unmarshal(item.Value, &result.Public)
		}
	}
	return result, nil
}

// SaveSettings 保存 public 和 private 两行配置。
func SaveSettings(settings model.Settings, now string) (model.Settings, error) {
	db, err := DB()
	if err != nil {
		return settings, err
	}
	publicValue, _ := json.Marshal(settings.Public)
	privateValue, _ := json.Marshal(settings.Private)
	items := []model.Setting{
		{Key: model.SettingKeyPublic, Value: publicValue, CreatedAt: now, UpdatedAt: now},
		{Key: model.SettingKeyPrivate, Value: privateValue, CreatedAt: now, UpdatedAt: now},
	}
	err = db.Transaction(func(tx *gorm.DB) error {
		var current model.Setting
		if err := tx.Where("key = ?", model.SettingKeyPublic).First(&current).Error; err != nil && err != gorm.ErrRecordNotFound {
			return err
		}
		var previous model.PublicSetting
		if len(current.Value) > 0 {
			if err := json.Unmarshal(current.Value, &previous); err != nil {
				return err
			}
		}
		kept := map[string]bool{}
		for _, group := range settings.Public.ModelChannel.UserGroups {
			kept[group.ID] = true
		}
		for _, group := range previous.ModelChannel.UserGroups {
			if !kept[group.ID] {
				if err := tx.Model(&model.User{}).Where("group_id = ?", group.ID).Updates(map[string]any{"group_id": "", "updated_at": now}).Error; err != nil {
					return err
				}
			}
		}
		return tx.Clauses(clause.OnConflict{
			Columns:   []clause.Column{{Name: "key"}},
			DoUpdates: clause.AssignmentColumns([]string{"value", "updated_at"}),
		}).Create(&items).Error
	})
	return settings, err
}
