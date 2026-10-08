package repository

import "github.com/tigerowo/infinite-canvas/model"

func ListStorageObjectAliases() ([]model.StorageObjectAlias, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	var aliases []model.StorageObjectAlias
	err = db.Find(&aliases).Error
	return aliases, err
}
