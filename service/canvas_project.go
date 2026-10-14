package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

type canvasProjectMetadata struct {
	ID        string `json:"id"`
	CreatedAt string `json:"createdAt"`
	UpdatedAt string `json:"updatedAt"`
}

type CanvasProjectConflictError struct {
	CurrentProject json.RawMessage
}

func (e *CanvasProjectConflictError) Error() string {
	return "画布已在其他设备更新，请重试"
}

func canvasProjectWithTimestamps(project model.CanvasProject) (json.RawMessage, error) {
	if project.ProjectData == "" || project.DeletedAt != "" {
		return nil, nil
	}
	var data map[string]json.RawMessage
	if err := json.Unmarshal([]byte(project.ProjectData), &data); err != nil {
		return nil, err
	}
	data["createdAt"], _ = json.Marshal(project.CreatedAt)
	data["updatedAt"], _ = json.Marshal(project.UpdatedAt)
	return json.Marshal(data)
}

func canvasProjectConflict(project model.CanvasProject) error {
	current, err := canvasProjectWithTimestamps(project)
	if err != nil {
		return err
	}
	return &CanvasProjectConflictError{CurrentProject: current}
}

func prepareCanvasProjectSave(userID string, raw json.RawMessage, baseUpdatedAt *string) (model.CanvasProject, string, error) {
	raw, err := RewriteStorageObjectAliases(raw)
	if err != nil {
		return model.CanvasProject{}, "", err
	}
	project, err := canvasProjectFromRaw(userID, raw)
	if err != nil {
		return project, "", err
	}
	current, err := repository.GetUserCanvasProject(userID, project.ID)
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return project, "", err
	}
	version := current.UpdatedAt
	if current.DeletedAt != "" || (baseUpdatedAt != nil && *baseUpdatedAt != version) {
		return project, "", canvasProjectConflict(current)
	}
	project.UpdatedAt = time.Now().UTC().Format(time.RFC3339Nano)
	project.CreatedAt = current.CreatedAt
	if errors.Is(err, gorm.ErrRecordNotFound) {
		project.CreatedAt = project.UpdatedAt
	}
	canonical, err := canvasProjectWithTimestamps(project)
	project.ProjectData = string(canonical)
	return project, version, err
}

func saveCanvasProjectsWithVersions(projects []model.CanvasProject, versions map[string]string) error {
	err := repository.SaveUserCanvasProjectsWithVersions(projects, versions)
	var conflict *repository.CanvasProjectConflictError
	if errors.As(err, &conflict) {
		return canvasProjectConflict(conflict.Current)
	}
	return err
}

func canvasProjectFromRaw(
	userID string,
	raw json.RawMessage,
) (model.CanvasProject, error) {
	var metadata canvasProjectMetadata
	if len(raw) == 0 || json.Unmarshal(raw, &metadata) != nil {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	metadata.ID = strings.TrimSpace(metadata.ID)
	metadata.CreatedAt = strings.TrimSpace(metadata.CreatedAt)
	metadata.UpdatedAt = strings.TrimSpace(metadata.UpdatedAt)
	if metadata.ID == "" || metadata.CreatedAt == "" ||
		metadata.UpdatedAt == "" {
		return model.CanvasProject{}, errors.New("画布项目数据无效")
	}

	return model.CanvasProject{
		UserID:      strings.TrimSpace(userID),
		ID:          metadata.ID,
		ProjectData: string(raw),
		CreatedAt:   metadata.CreatedAt,
		UpdatedAt:   metadata.UpdatedAt,
	}, nil
}

func canvasProjectData(
	projects []model.CanvasProject,
) []json.RawMessage {
	result := make([]json.RawMessage, 0, len(projects))
	for _, project := range projects {
		if strings.TrimSpace(project.ProjectData) != "" {
			result = append(
				result,
				json.RawMessage(project.ProjectData),
			)
		}
	}
	return result
}

func CurrentUserCanvasProjects(
	ctx context.Context,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects, err := repository.ListUserCanvasProjects(user.ID)
	if err != nil {
		return nil, err
	}
	data := canvasProjectData(projects)
	for index, raw := range data {
		data[index], err = RewriteStorageObjectAliases(raw)
		if err != nil {
			return nil, err
		}
	}
	return data, nil
}

func SaveCurrentUserCanvasProject(
	ctx context.Context,
	raw json.RawMessage,
	baseUpdatedAt ...string,
) (json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	var base *string
	if len(baseUpdatedAt) > 0 {
		base = &baseUpdatedAt[0]
	}
	project, version, err := prepareCanvasProjectSave(user.ID, raw, base)
	if err != nil {
		return nil, err
	}
	if err := saveCanvasProjectsWithVersions([]model.CanvasProject{project}, map[string]string{project.ID: version}); err != nil {
		return nil, err
	}
	return json.RawMessage(project.ProjectData), nil
}

func SyncCurrentUserCanvasProjects(
	ctx context.Context,
	rawProjects []json.RawMessage,
	baseUpdatedAts ...map[string]string,
) ([]json.RawMessage, error) {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return nil, errors.New("请先登录")
	}

	projects := make([]model.CanvasProject, 0, len(rawProjects))
	versions := make(map[string]string, len(rawProjects))
	for _, raw := range rawProjects {
		var base *string
		if len(baseUpdatedAts) > 0 {
			var metadata canvasProjectMetadata
			if err := json.Unmarshal(raw, &metadata); err != nil {
				return nil, errors.New("画布项目数据无效")
			}
			if value, ok := baseUpdatedAts[0][strings.TrimSpace(metadata.ID)]; ok {
				base = &value
			}
		}
		project, version, err := prepareCanvasProjectSave(user.ID, raw, base)
		if err != nil {
			return nil, err
		}
		projects = append(projects, project)
		versions[project.ID] = version
	}

	if err := saveCanvasProjectsWithVersions(projects, versions); err != nil {
		return nil, err
	}
	return CurrentUserCanvasProjects(ctx)
}

func DeleteCurrentUserCanvasProjects(
	ctx context.Context,
	projectIDs []string,
) error {
	user, ok := UserFromContext(ctx)
	if !ok || user.ID == "" {
		return errors.New("请先登录")
	}

	ids := make([]string, 0, len(projectIDs))
	for _, id := range projectIDs {
		if id = strings.TrimSpace(id); id != "" {
			ids = append(ids, id)
		}
	}
	if len(ids) == 0 {
		return errors.New("画布项目参数无效")
	}
	return repository.SoftDeleteUserCanvasProjects(user.ID, ids, time.Now().UTC().Format(time.RFC3339Nano))
}
