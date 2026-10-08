package repository

import (
	"errors"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
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
	err = db.Where("provider_id = ? AND id > ? AND deleted_at = ?", "local-generated", after, "").Order("id").Limit(limit).Find(&objects).Error
	return objects, err
}

// ListGeneratedCloudCopies pages media that passed cloud verification and grace period.
func ListGeneratedCloudCopies(after, before string, limit int) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	err = db.Where("cloud_synced_at <> ? AND cloud_synced_at <= ? AND local_copy_removed_at = ? AND id > ? AND deleted_at = ?", "", before, "", after, "").
		Order("id").Limit(limit).Find(&objects).Error
	return objects, err
}

type StorageObjectFilter struct {
	After, UserID, ProviderID, ObjectID string
	Limit                               int
}

func ListStorageObjectsForVerification(filter StorageObjectFilter) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	query := db.Where("deleted_at = ? AND id > ?", "", filter.After)
	if filter.UserID != "" {
		query = query.Where("created_by = ?", filter.UserID)
	}
	if filter.ProviderID != "" {
		query = query.Where("provider_id = ?", filter.ProviderID)
	}
	if filter.ObjectID != "" {
		query = query.Where("id = ?", filter.ObjectID)
	}
	var objects []model.StorageObject
	err = query.Order("id").Limit(filter.Limit).Find(&objects).Error
	return objects, err
}

// ListStorageObjectSiblings pages all donors, rather than silently truncating recovery candidates.
func ListStorageObjectSiblings(object model.StorageObject, after string, limit int) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	err = db.Where("LOWER(sha256) = LOWER(?) AND bytes = ? AND id <> ? AND id > ? AND deleted_at = ?", object.SHA256, object.Bytes, object.ID, after, "").Order("id").Limit(limit).Find(&objects).Error
	return objects, err
}

// ListStorageObjectsByFingerprint finds non-deleted objects owned by one user
// with the same content fingerprint. The caller still verifies readability.
func ListStorageObjectsByFingerprint(createdBy, checksum string, bytes int64) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	err = db.Where(
		"created_by = ? AND LOWER(sha256) = LOWER(?) AND bytes = ? AND deleted_at = ?",
		createdBy, checksum, bytes, "",
	).Order("created_at, id").Find(&objects).Error
	return objects, err
}

// Updates never resurrect a deleted object or overwrite a different provider/content/lease.
func storageObjectSnapshot(db *gorm.DB, object model.StorageObject) *gorm.DB {
	return db.Model(&model.StorageObject{}).Where("id = ? AND created_by = ? AND provider_id = ? AND bucket = ? AND object_key = ? AND sha256 = ? AND bytes = ? AND mime_type = ? AND deleted_at = ? AND COALESCE(cloud_sync_lease_token, '') = ? AND COALESCE(cloud_sync_status, '') = ? AND COALESCE(cloud_sync_attempts, 0) = ? AND COALESCE(cloud_sync_next_retry_at, '') = ? AND COALESCE(cloud_target_provider_id, '') = ? AND COALESCE(cloud_target_bucket, '') = ? AND COALESCE(cloud_target_key, '') = ? AND COALESCE(cloud_target_config_hash, '') = ?", object.ID, object.CreatedBy, object.ProviderID, object.Bucket, object.ObjectKey, object.SHA256, object.Bytes, object.MimeType, "", object.CloudSyncLeaseToken, object.CloudSyncStatus, object.CloudSyncAttempts, object.CloudSyncNextRetryAt, object.CloudTargetProviderID, object.CloudTargetBucket, object.CloudTargetKey, object.CloudTargetConfigHash)
}

func UpdateStorageObjectSnapshot(object model.StorageObject, updates map[string]any) error {
	db, err := DB()
	if err != nil {
		return err
	}
	result := storageObjectSnapshot(db, object).Updates(updates)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("存储对象已删除或状态发生变化，未回写结果")
	}
	return nil
}

func ClaimStorageObjectSync(object model.StorageObject, token, current, until string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := storageObjectSnapshot(db, object).Where("COALESCE(cloud_sync_lease_until, '') = ? OR cloud_sync_lease_until <= ?", "", current).Updates(map[string]any{
		"cloud_sync_lease_token": token, "cloud_sync_lease_until": until, "cloud_sync_status": "syncing",
		"cloud_sync_last_attempt_at": current, "cloud_sync_attempts": object.CloudSyncAttempts + 1,
	})
	return result.RowsAffected == 1, result.Error
}

func RenewStorageObjectSyncLease(id, token, until string) (bool, error) {
	db, err := DB()
	if err != nil {
		return false, err
	}
	result := db.Model(&model.StorageObject{}).Where("id = ? AND deleted_at = ? AND cloud_sync_status = ? AND cloud_sync_lease_token = ?", id, "", "syncing", token).Update("cloud_sync_lease_until", until)
	return result.RowsAffected == 1, result.Error
}

func ListDueStorageObjectSyncs(current string, limit int, automaticEnabled bool) ([]model.StorageObject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var objects []model.StorageObject
	query := db.Where("deleted_at = ? AND ((cloud_sync_status IN ? AND (cloud_sync_next_retry_at = ? OR cloud_sync_next_retry_at <= ?)) OR (cloud_sync_status = ? AND cloud_sync_lease_until <= ?))", "", []string{"pending", "retry"}, "", current, "syncing", current)
	if !automaticEnabled {
		query = query.Where("cloud_sync_explicit = ?", true)
	}
	err = query.Order("cloud_sync_next_retry_at, id").Limit(limit).Find(&objects).Error
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
