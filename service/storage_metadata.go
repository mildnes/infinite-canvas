package service

import (
	"context"
	"path"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

type StorageObjectMetadata struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	MimeType  string `json:"mimeType"`
	Bytes     int64  `json:"bytes"`
	Width     int    `json:"width"`
	Height    int    `json:"height"`
	CreatedAt string `json:"createdAt"`
	PublicURL string `json:"publicUrl"`
	Direct    bool   `json:"direct"`
	ObjectKey string `json:"objectKey,omitempty"`
}

func StorageObjectInfo(id string, contexts ...context.Context) (StorageObjectMetadata, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return StorageObjectMetadata{}, err
	}
	if object.DeletedAt != "" {
		return StorageObjectMetadata{}, gorm.ErrRecordNotFound
	}
	info := StorageObjectMetadata{
		ID: object.ID, Name: path.Base(object.ObjectKey), MimeType: NormalizeStorageMIME(object.MimeType),
		Bytes: object.Bytes, Width: object.Width, Height: object.Height, CreatedAt: object.CreatedAt,
		PublicURL: object.PublicURL, Direct: object.Direct,
	}
	if len(contexts) > 0 {
		if user, ok := UserFromContext(contexts[0]); ok && user.ID != "" && user.Role != model.UserRoleGuest && (user.ID == object.CreatedBy || user.Role == model.UserRoleAdmin) {
			info.ObjectKey = object.ObjectKey
		}
	}
	return info, nil
}
