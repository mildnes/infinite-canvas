package repository

import (
	"github.com/tigerowo/infinite-canvas/model"
)

// SaveStorageObject 保存存储对象记录。
func SaveStorageObject(object model.StorageObject) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	return object, db.Save(&object).Error
}

// GetStorageObject 根据 ID 获取存储对象。
func GetStorageObject(id string) (model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return model.StorageObject{}, err
	}
	var object model.StorageObject
	err = db.First(&object, "id = ?", id).Error
	return object, err
}

// ListLocalGeneratedObjects pages only the still-local generated media.
func ListLocalGeneratedObjects(after string, limit int) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	err = db.Where("provider_id = ? AND id > ?", "local-generated", after).Order("id").Limit(limit).Find(&objects).Error
	return objects, err
}

// ListGeneratedCloudCopies pages media that passed cloud verification and grace period.
func ListGeneratedCloudCopies(after, before string, limit int) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	err = db.Where("cloud_synced_at <> ? AND cloud_synced_at <= ? AND local_copy_removed_at = ? AND id > ?", "", before, "", after).
		Order("id").Limit(limit).Find(&objects).Error
	return objects, err
}

// DeleteStorageObjectRecord 删除存储对象记录（软删除）。
func DeleteStorageObjectRecord(id string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Delete(&model.StorageObject{}, "id = ?", id).Error
}
