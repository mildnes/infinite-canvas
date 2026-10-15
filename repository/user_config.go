package repository

import (
	"errors"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func userConfigTimestamp() string {
	return time.Now().UTC().Format(time.RFC3339Nano)
}

func GetUserConfig(userID string) (model.UserConfig, bool, error) {
	db, err := DB()
	if err != nil {
		return model.UserConfig{}, false, err
	}

	var config model.UserConfig
	err = db.First(&config, "user_id = ?", userID).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return model.UserConfig{}, false, nil
	}
	if err != nil {
		return model.UserConfig{}, false, err
	}
	return config, true, nil
}

func SaveUserConfig(config model.UserConfig) (model.UserConfig, error) {
	db, err := DB()
	if err != nil {
		return config, err
	}

	config.UpdatedAt = userConfigTimestamp()
	return config, db.Save(&config).Error
}

// Skip a stale migration snapshot rather than overwrite a concurrent configuration save.
func SaveMigratedUserImageHistory(userID, previous, raw string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.UserConfig{}).
		Where("user_id = ? AND image_history = ?", userID, previous).
		Updates(map[string]interface{}{"image_history": raw, "updated_at": userConfigTimestamp()}).Error
}

// Update just asset_data; other configuration fields must survive concurrent saves.
// A nil previous value preserves the legacy last-write-wins API.
func SaveUserAssetData(userID, raw string, previous *string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	stamp := userConfigTimestamp()
	values := map[string]interface{}{"asset_data": raw, "updated_at": stamp}
	if previous != nil {
		result := db.Model(&model.UserConfig{}).Where("user_id = ? AND COALESCE(asset_data, '') = ?", userID, *previous).Updates(values)
		if result.Error != nil || result.RowsAffected > 0 {
			return result.RowsAffected > 0, result.Error
		}
		if *previous != "" {
			return false, nil
		}
		result = db.Clauses(clause.OnConflict{DoNothing: true}).Create(&model.UserConfig{UserID: userID, AssetData: raw, CreatedAt: stamp, UpdatedAt: stamp})
		return result.RowsAffected > 0, result.Error
	}
	result := db.Clauses(clause.OnConflict{Columns: []clause.Column{{Name: "user_id"}}, DoUpdates: clause.Assignments(values)}).Create(&model.UserConfig{UserID: userID, AssetData: raw, CreatedAt: stamp, UpdatedAt: stamp})
	return result.RowsAffected > 0, result.Error
}
