package repository

import (
	"errors"
	"strings"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"
)

// EnqueueMediaCleanupCandidates records stable server references after their
// owning history/task has been deleted. It does not delete an object or touch
// its provider. Unknown keys and objects owned by another account are ignored
// so a caller cannot enqueue an arbitrary provider path.
func EnqueueMediaCleanupCandidates(userID string, keys []string, requestedAt, eligibleAt string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	userID = strings.TrimSpace(userID)
	if userID == "" {
		return errors.New("媒体清理候选缺少用户")
	}
	keys = uniqueMediaCleanupKeys(keys...)
	if len(keys) == 0 {
		return nil
	}
	return db.Transaction(func(tx *gorm.DB) error {
		objectIDs := make([]string, 0, len(keys))
		keyByObjectID := make(map[string]string, len(keys))
		for _, key := range keys {
			objectID, ok := serverObjectID(key)
			if !ok {
				continue
			}
			objectIDs = append(objectIDs, objectID)
			keyByObjectID[objectID] = key
		}
		var objects []model.StorageObject
		if err := tx.Select("id").Where("id IN ? AND created_by = ?", objectIDs, userID).Find(&objects).Error; err != nil {
			return err
		}
		candidates := make([]model.MediaCleanupCandidate, 0, len(objects))
		for _, object := range objects {
			key := keyByObjectID[object.ID]
			candidates = append(candidates, model.MediaCleanupCandidate{
				ID:          "media-cleanup-" + uuid.NewString(),
				UserID:      userID,
				ObjectID:    object.ID,
				StorageKey:  key,
				RequestedAt: strings.TrimSpace(requestedAt),
				EligibleAt:  strings.TrimSpace(eligibleAt),
				Status:      model.MediaCleanupStatusPending,
				CreatedAt:   strings.TrimSpace(requestedAt),
				UpdatedAt:   strings.TrimSpace(requestedAt),
			})
		}
		if len(candidates) == 0 {
			return nil
		}
		// A previous request is deliberately retained. In particular, a
		// review result must not be reset by a repeated or concurrent delete.
		return tx.Clauses(clause.OnConflict{DoNothing: true}).Create(&candidates).Error
	})
}

func GetMediaCleanupCandidate(id string) (model.MediaCleanupCandidate, error) {
	db, err := DB()
	if err != nil {
		return model.MediaCleanupCandidate{}, err
	}
	var candidate model.MediaCleanupCandidate
	err = db.Where("id = ?", strings.TrimSpace(id)).First(&candidate).Error
	return candidate, err
}

// ListMediaCleanupCandidates returns candidates in stable ID order. A blank
// before value lists all unresolved candidates; callers can use a timestamp to
// restrict the result to candidates whose grace period has elapsed.
func ListMediaCleanupCandidates(after, before string, limit int) ([]model.MediaCleanupCandidate, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	if limit <= 0 {
		limit = 100
	}
	if limit > 500 {
		limit = 500
	}
	query := db.Where("resolved_at = '' AND id > ?", strings.TrimSpace(after))
	if strings.TrimSpace(before) != "" {
		query = query.Where("eligible_at <= ?", strings.TrimSpace(before))
	}
	var candidates []model.MediaCleanupCandidate
	err = query.Order("id").Limit(limit).Find(&candidates).Error
	return candidates, err
}

// RecordMediaCleanupReview stores only the review outcome. It never marks a
// candidate as deleted; destructive reclamation is intentionally unavailable
// while browser-only and legacy references cannot be globally observed.
func RecordMediaCleanupReview(id string, status model.MediaCleanupStatus, checkedAt, reason string) error {
	db, err := DB()
	if err != nil {
		return err
	}
	return db.Model(&model.MediaCleanupCandidate{}).
		Where("id = ? AND resolved_at = ''", strings.TrimSpace(id)).
		Updates(map[string]any{
			"status":          status,
			"last_checked_at": strings.TrimSpace(checkedAt),
			"review_reason":   strings.TrimSpace(reason),
			"attempt_count":   gorm.Expr("attempt_count + ?", 1),
			"updated_at":      strings.TrimSpace(checkedAt),
		}).Error
}

func serverObjectID(storageKey string) (string, bool) {
	key := strings.TrimSpace(storageKey)
	if !strings.HasPrefix(key, "server:") {
		return "", false
	}
	id := strings.TrimSpace(strings.TrimPrefix(key, "server:"))
	if id == "" || strings.ContainsAny(id, "/\\:?&#%") {
		return "", false
	}
	return id, true
}

func uniqueMediaCleanupKeys(keys ...string) []string {
	result := make([]string, 0, len(keys))
	seen := map[string]struct{}{}
	for _, key := range keys {
		key = strings.TrimSpace(key)
		if _, ok := serverObjectID(key); !ok {
			continue
		}
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, key)
	}
	return result
}

// FindMediaCleanupReferences scans server-side representations that can hold
// a storage key or URL. The scan is intentionally broad and may report false
// positives; false negatives are not accepted by the service review layer.
func FindMediaCleanupReferences(object model.StorageObject) ([]model.MediaCleanupReference, error) {
	db, err := DB()
	if err != nil {
		return nil, err
	}
	needles := mediaReferenceNeedles(object)
	result := make([]model.MediaCleanupReference, 0)
	appendMatches := func(table string, recordExpr string, target any, fields []string) error {
		matches, err := scanMediaCleanupFields(db, table, recordExpr, target, fields, needles)
		if err != nil {
			return err
		}
		result = append(result, matches...)
		return nil
	}

	if err := appendMatches("canvas_image_tasks", "id, user_id, '' AS path", &model.CanvasImageTask{}, []string{
		"storage_key", "image_url", "image_urls", "image_storage", "request_body", "response_body", "error", "error_detail", "prompt",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("canvas_audio_tasks", "id, user_id, '' AS path", &model.CanvasAudioTask{}, []string{
		"storage_key", "audio_url", "request_body", "response_body", "error", "error_detail", "prompt",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("video_tasks", "id, user_id, '' AS path", &model.VideoTask{}, []string{
		"video_url", "request_body", "response_body", "last_response", "error", "error_detail",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("image_generation_logs", "id, user_id, '' AS path", &model.ImageGenerationLog{}, []string{
		"image_id", "payload_json", "summary_json",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("video_generation_logs", "id, user_id, '' AS path", &model.VideoGenerationLog{}, []string{
		"video_id", "payload_json",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("canvas_projects", "id, user_id, deleted_at AS path", &model.CanvasProject{}, []string{
		"project_data",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("user_configs", "user_id AS id, user_id, '' AS path", &model.UserConfig{}, []string{
		"image_history", "asset_data", "storage_provider",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("assets", "id, '' AS user_id, '' AS path", &model.Asset{}, []string{
		"cover_url", "content", "url", "description",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("agent_skills", "id, owner_user_id AS user_id, '' AS path", &model.AgentSkill{}, []string{
		"cover_url", "cover_storage_key", "content", "description",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("agent_skill_files", "skill_id AS id, '' AS user_id, path", &model.AgentSkillFile{}, []string{
		"content",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("creative_workflows", "id, owner_user_id AS user_id, '' AS path", &model.CreativeWorkflow{}, []string{
		"data", "description",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("ai_call_logs", "id, user_id, '' AS path", &model.AICallLog{}, []string{
		"request_body", "response_body", "error",
	}); err != nil {
		return nil, err
	}
	if err := appendMatches("prompts", "id, '' AS user_id, '' AS path", &model.Prompt{}, []string{
		"cover_url", "prompt", "preview",
	}); err != nil {
		return nil, err
	}

	return dedupeMediaCleanupReferences(result), nil
}

type mediaCleanupRow struct {
	ID     string `gorm:"column:id"`
	UserID string `gorm:"column:user_id"`
	Path   string `gorm:"column:path"`
	Value  string `gorm:"column:media_cleanup_value"`
}

func scanMediaCleanupFields(db *gorm.DB, table, recordExpr string, target any, fields, needles []string) ([]model.MediaCleanupReference, error) {
	conditions := make([]string, 0, len(needles))
	args := make([]any, 0, len(needles))
	result := make([]model.MediaCleanupReference, 0)
	for _, field := range fields {
		conditions = conditions[:0]
		args = args[:0]
		for _, needle := range needles {
			conditions = append(conditions, field+" LIKE ?")
			args = append(args, "%"+needle+"%")
		}
		var rows []mediaCleanupRow
		query := db.Model(target).
			Select(recordExpr+", "+field+" AS media_cleanup_value").
			Where(field+" IS NOT NULL AND ("+strings.Join(conditions, " OR ")+")", args...)
		if err := query.Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, row := range rows {
			result = append(result, model.MediaCleanupReference{
				Table:    table,
				RecordID: mediaCleanupRecordID(row),
				Field:    field,
			})
		}
	}
	return result, nil
}

func mediaCleanupRecordID(row mediaCleanupRow) string {
	if strings.TrimSpace(row.Path) != "" {
		return strings.TrimSpace(row.ID) + ":" + strings.TrimSpace(row.Path)
	}
	if strings.TrimSpace(row.UserID) != "" && strings.TrimSpace(row.ID) != strings.TrimSpace(row.UserID) {
		return strings.TrimSpace(row.UserID) + ":" + strings.TrimSpace(row.ID)
	}
	return strings.TrimSpace(row.ID)
}

func mediaReferenceNeedles(object model.StorageObject) []string {
	values := []string{
		"server:" + strings.TrimSpace(object.ID),
		"/api/files/" + strings.TrimSpace(object.ID),
		strings.TrimSpace(object.PublicURL),
		strings.TrimSpace(object.ObjectKey),
		strings.TrimSpace(object.ID),
	}
	result := make([]string, 0, len(values))
	seen := map[string]struct{}{}
	for _, value := range values {
		if value == "" {
			continue
		}
		if _, ok := seen[value]; ok {
			continue
		}
		seen[value] = struct{}{}
		result = append(result, value)
	}
	return result
}

func dedupeMediaCleanupReferences(items []model.MediaCleanupReference) []model.MediaCleanupReference {
	result := make([]model.MediaCleanupReference, 0, len(items))
	seen := map[string]struct{}{}
	for _, item := range items {
		key := item.Table + "\x00" + item.RecordID + "\x00" + item.Field
		if _, ok := seen[key]; ok {
			continue
		}
		seen[key] = struct{}{}
		result = append(result, item)
	}
	return result
}
