package repository

import (
	"errors"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

type CanvasProjectConflictError struct {
	Current model.CanvasProject
}

func (e *CanvasProjectConflictError) Error() string {
	return "画布已在其他设备更新，请重试"
}

func GetUserCanvasProject(userID, id string) (model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return model.CanvasProject{}, err
	}
	var project model.CanvasProject
	err = db.First(&project, "user_id = ? AND id = ?", strings.TrimSpace(userID), strings.TrimSpace(id)).Error
	return project, err
}

func ListUserCanvasProjects(userID string) ([]model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}

	var projects []model.CanvasProject
	err = db.Where(
		"user_id = ? AND deleted_at = ''",
		strings.TrimSpace(userID),
	).Order("updated_at DESC").Find(&projects).Error
	return projects, err
}

func ListCanvasProjectsForMediaRepair(afterUserID, afterID string, limit int) ([]model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit < 1 || limit > 1000 {
		limit = 100
	}
	query := db.Where("deleted_at = ''")
	if afterUserID != "" || afterID != "" {
		query = query.Where("user_id > ? OR (user_id = ? AND id > ?)", afterUserID, afterUserID, afterID)
	}
	var projects []model.CanvasProject
	err = query.Order("user_id ASC, id ASC").Limit(limit).Find(&projects).Error
	return projects, err
}

func SaveUserCanvasProject(
	project model.CanvasProject,
) (model.CanvasProject, error) {
	db, err := DB()
	if err != nil {
		return project, err
	}

	project.UserID = strings.TrimSpace(project.UserID)
	project.ID = strings.TrimSpace(project.ID)

	var current model.CanvasProject
	err = db.First(
		&current,
		"user_id = ? AND id = ?",
		project.UserID,
		project.ID,
	).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return project, db.Create(&project).Error
	}
	if err != nil {
		return project, err
	}
	if current.DeletedAt != "" || current.UpdatedAt > project.UpdatedAt {
		return current, nil
	}

	result := db.Model(&model.CanvasProject{}).
		Where(
			"user_id = ? AND id = ? AND deleted_at = '' AND updated_at <= ?",
			project.UserID,
			project.ID,
			project.UpdatedAt,
		).
		Updates(map[string]any{
			"project_data": project.ProjectData,
			"updated_at":   project.UpdatedAt,
		})
	if result.Error != nil {
		return project, result.Error
	}
	if result.RowsAffected == 0 {
		if err := db.First(
			&current,
			"user_id = ? AND id = ?",
			project.UserID,
			project.ID,
		).Error; err != nil {
			return project, err
		}
		return current, nil
	}
	return project, nil
}

func SaveUserCanvasProjects(
	userID string,
	projects []model.CanvasProject,
) ([]model.CanvasProject, error) {
	for _, project := range projects {
		project.UserID = userID
		if _, err := SaveUserCanvasProject(project); err != nil {
			return nil, err
		}
	}
	return ListUserCanvasProjects(userID)
}

// SaveUserCanvasProjectsWithVersions applies every write or none of them.
func SaveUserCanvasProjectsWithVersions(projects []model.CanvasProject, versions map[string]string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Transaction(func(tx *gorm.DB) error {
		for _, project := range projects {
			var result *gorm.DB
			base := versions[project.ID]
			if base == "" {
				result = tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&project)
			} else {
				result = tx.Model(&model.CanvasProject{}).
					Where("user_id = ? AND id = ? AND deleted_at = '' AND updated_at = ?", project.UserID, project.ID, base).
					Updates(map[string]any{"project_data": project.ProjectData, "updated_at": project.UpdatedAt})
			}
			if result.Error != nil {
				return result.Error
			}
			if result.RowsAffected != 1 {
				var current model.CanvasProject
				if err := tx.First(&current, "user_id = ? AND id = ?", project.UserID, project.ID).Error; err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
					return err
				}
				return &CanvasProjectConflictError{Current: current}
			}
		}
		return nil
	})
}

// ReplaceCanvasProjectDataForMaintenance refuses to overwrite a changed or deleted project.
func ReplaceCanvasProjectDataForMaintenance(project model.CanvasProject, data, updatedAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	result := db.Model(&model.CanvasProject{}).
		Where("user_id = ? AND id = ? AND deleted_at = '' AND updated_at = ? AND project_data = ?", project.UserID, project.ID, project.UpdatedAt, project.ProjectData).
		Updates(map[string]any{"project_data": data, "updated_at": updatedAt})
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected != 1 {
		return errors.New("画布已变化或被删除，请重新 dry-run")
	}
	return nil
}

func SoftDeleteUserCanvasProjects(
	userID string,
	ids []string,
	deletedAt string,
) error {
	ids = uniqueTrimmedValues(ids...)
	if len(ids) == 0 {
		return nil
	}

	db, err := DB()
	if err != nil {
		return err
	}

	records := make([]model.CanvasProject, 0, len(ids))
	for _, id := range ids {
		records = append(records, model.CanvasProject{
			UserID:    strings.TrimSpace(userID),
			ID:        id,
			CreatedAt: deletedAt,
			UpdatedAt: deletedAt,
			DeletedAt: deletedAt,
		})
	}

	return db.Clauses(clause.OnConflict{
		Columns: []clause.Column{
			{Name: "user_id"},
			{Name: "id"},
		},
		DoUpdates: clause.AssignmentColumns([]string{
			"project_data",
			"updated_at",
			"deleted_at",
		}),
	}).Create(&records).Error
}

func CleanupDeletedCanvasProjects(before string) error {
	db, err := DB()
	if err != nil {
		return err
	}

	return db.Where(
		"deleted_at <> '' AND deleted_at < ?",
		before,
	).Delete(&model.CanvasProject{}).Error
}
