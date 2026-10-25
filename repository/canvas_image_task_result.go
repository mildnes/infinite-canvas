package repository

import (
	"encoding/json"
	"strings"

	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

func stableCanvasImageResult(url, key string) bool {
	id := strings.TrimPrefix(key, "server:")
	return id != "" && id != key && !strings.ContainsAny(id, "/:?#") && url == "/api/files/"+id+"/content"
}

func archiveCanvasImageResult(tx *gorm.DB, task model.CanvasImageTask) error {
	if task.Source != "canvas" || task.Status != "completed" || task.SourceID == "" || task.NodeID == "" ||
		!stableCanvasImageResult(task.ImageURL, task.StorageKey) {
		return nil
	}
	// Deliberately construct an allowlisted snapshot: never retain input files, base64,
	// expiring upstream URLs, error bodies or credentials in the durable result index.
	result := model.CanvasImageTask{ID: task.ID, UserID: task.UserID, Source: task.Source, SourceID: task.SourceID, NodeID: task.NodeID,
		Model: task.Model, Status: "completed", Progress: 100, ImageURL: task.ImageURL, StorageKey: task.StorageKey,
		Width: task.Width, Height: task.Height, MimeType: task.MimeType, Bytes: task.Bytes,
		CreatedAt: task.CreatedAt, UpdatedAt: task.UpdatedAt, StartedAt: task.StartedAt, CompletedAt: task.CompletedAt}
	for _, image := range task.ImageStorage {
		if image == nil || !stableCanvasImageResult(image.URL, image.StorageKey) {
			continue
		}
		stored := *image
		result.ImageStorage = append(result.ImageStorage, &stored)
		result.ImageURLs = append(result.ImageURLs, stored.URL)
	}
	payload, err := json.Marshal(result)
	if err != nil {
		return err
	}
	row := model.CanvasImageTaskResult{UserID: task.UserID, TaskID: task.ID, ResultJSON: string(payload)}
	return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&row).Error
}

func archivedCanvasImageResults(db *gorm.DB, userID string, ids []string) ([]model.CanvasImageTask, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	var rows []model.CanvasImageTaskResult
	if err := db.Where("user_id = ? AND task_id IN ?", userID, ids).Find(&rows).Error; err != nil {
		return nil, err
	}
	tasks := make([]model.CanvasImageTask, 0, len(rows))
	for _, row := range rows {
		var task model.CanvasImageTask
		if err := json.Unmarshal([]byte(row.ResultJSON), &task); err != nil {
			return nil, err
		}
		if task.ID == row.TaskID && task.UserID == userID && task.Status == "completed" {
			tasks = append(tasks, task)
		}
	}
	return tasks, nil
}
