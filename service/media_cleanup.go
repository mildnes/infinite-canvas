package service

import (
	"errors"
	"strings"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

// MediaCleanupGracePeriod is the minimum delay between a history/task delete
// and a server-side reclamation review. It is intentionally longer than the
// browser's normal undo window.
const MediaCleanupGracePeriod = 30 * 24 * time.Hour

var ErrMediaCleanupNotSafe = errors.New("媒体仍可能被浏览器离线数据或未知旧记录引用，禁止自动删除")

// QueueImageMediaCleanup records stable server object references for a later
// review. It is safe to call before or after the transaction that removes the
// owning history/task: the reference sweep will see a pre-commit reference
// and leave the candidate protected. This function never deletes a file.
func QueueImageMediaCleanup(userID string, keys []string) error {
	now := time.Now().UTC()
	return repository.EnqueueMediaCleanupCandidates(
		userID,
		keys,
		now.Format(time.RFC3339Nano),
		now.Add(MediaCleanupGracePeriod).Format(time.RFC3339Nano),
	)
}

// ReviewMediaCleanupCandidate performs a fail-closed server-side review. It
// records the outcome for operators but intentionally never exposes a delete
// path while browser-only and legacy references are not globally observable.
func ReviewMediaCleanupCandidate(id string) (model.MediaCleanupReport, error) {
	candidate, err := repository.GetMediaCleanupCandidate(id)
	if err != nil {
		return model.MediaCleanupReport{}, err
	}
	reviewedAt := time.Now().UTC()
	report := model.MediaCleanupReport{
		Candidate:  candidate,
		References: make([]model.MediaCleanupReference, 0),
		UnknownReasons: []string{
			"浏览器 IndexedDB、离线画布和未同步的本地项目不在服务端可观测范围内",
			"仅能匹配已知对象 ID、URL 和存储键，未知旧格式字符串无法证明不存在",
		},
		ReviewedAt: reviewedAt.Format(time.RFC3339Nano),
	}

	eligibleAt, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(candidate.EligibleAt))
	if parseErr != nil {
		report.ProtectedReason = "候选保留期时间无效，未执行任何删除"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusUnknown)
	}
	if reviewedAt.Before(eligibleAt) {
		report.Eligible = false
		report.ProtectedReason = "媒体仍在 30 天保留期内"
		if err := repository.RecordMediaCleanupReview(candidate.ID, model.MediaCleanupStatusNotDue, report.ReviewedAt, report.ProtectedReason); err != nil {
			return model.MediaCleanupReport{}, err
		}
		report.Candidate.Status = model.MediaCleanupStatusNotDue
		report.Candidate.LastCheckedAt = report.ReviewedAt
		report.Candidate.ReviewReason = report.ProtectedReason
		return report, nil
	}
	report.Eligible = true

	object, err := repository.GetStorageObject(candidate.ObjectID)
	if errors.Is(err, gorm.ErrRecordNotFound) {
		report.ProtectedReason = "存储对象索引不存在，未执行任何删除"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusNotFound)
	}
	if err != nil {
		return model.MediaCleanupReport{}, err
	}
	report.ObjectFound = true
	if object.ID != candidate.ObjectID || object.CreatedBy != candidate.UserID {
		report.ProtectedReason = "对象所有者与候选不一致"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusProtected)
	}
	if object.ProviderID == generatedMediaProviderID || object.CloudSyncedAt == "" {
		report.ProtectedReason = "对象尚未完成云端同步，保留现有副本"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusProtected)
	}
	provider, err := generatedCloudProvider(object)
	if err != nil {
		report.ProtectedReason = "原云存储提供方不可用或已切换，保留现有副本"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusProtected)
	}
	if err := verifyGeneratedCloudObject(object, provider); err != nil {
		report.ProtectedReason = "云端媒体校验失败，保留现有副本"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusProtected)
	}
	report.CloudVerified = true

	references, err := repository.FindMediaCleanupReferences(object)
	if err != nil {
		return model.MediaCleanupReport{}, err
	}
	report.References = references
	if len(references) > 0 {
		report.ProtectedReason = "仍存在服务端记录引用"
		return recordMediaCleanupReview(report, model.MediaCleanupStatusReferenced)
	}
	// UnknownReasons is deliberately non-empty even when the indexed scan is
	// empty. Consequently this version cannot transition a candidate to a
	// deletable state.
	report.ProtectedReason = ErrMediaCleanupNotSafe.Error()
	return recordMediaCleanupReview(report, model.MediaCleanupStatusUnknown)
}

// ReviewDueMediaCleanup reviews a bounded page for maintenance tooling. It is
// a dry-run operation; no provider DELETE request is made.
func ReviewDueMediaCleanup(limit int) ([]model.MediaCleanupReport, error) {
	now := time.Now().UTC()
	candidates, err := repository.ListMediaCleanupCandidates("", now.Format(time.RFC3339Nano), limit)
	if err != nil {
		return nil, err
	}
	reports := make([]model.MediaCleanupReport, 0, len(candidates))
	for _, candidate := range candidates {
		report, reviewErr := ReviewMediaCleanupCandidate(candidate.ID)
		if reviewErr != nil {
			return nil, reviewErr
		}
		reports = append(reports, report)
	}
	return reports, nil
}

// DeleteMediaCleanupCandidate is intentionally unavailable until the
// application can observe browser-only/offline references. Keeping this
// explicit prevents a future CLI from accidentally turning a dry run into a
// destructive operation.
func DeleteMediaCleanupCandidate(_ string) error {
	return ErrMediaCleanupNotSafe
}

func recordMediaCleanupReview(report model.MediaCleanupReport, status model.MediaCleanupStatus) (model.MediaCleanupReport, error) {
	reason := strings.TrimSpace(report.ProtectedReason)
	if err := repository.RecordMediaCleanupReview(report.Candidate.ID, status, report.ReviewedAt, reason); err != nil {
		return model.MediaCleanupReport{}, err
	}
	report.Candidate.Status = status
	report.Candidate.LastCheckedAt = report.ReviewedAt
	report.Candidate.ReviewReason = reason
	report.Candidate.AttemptCount++
	return report, nil
}
