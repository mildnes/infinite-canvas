package service

import (
	"context"
	"errors"
	"io"
	"net/http"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

type MediaVerifyOptions struct {
	Apply, WritesStopped, RestoreRemovedLocal, SyncLocal bool
}

type MediaVerifyReport struct {
	ObjectID          string   `json:"objectId"`
	UserID            string   `json:"userId"`
	ProviderID        string   `json:"providerId"`
	ObjectKey         string   `json:"objectKey"`
	MimeType          string   `json:"mimeType"`
	Bytes             int64    `json:"bytes"`
	SHA256            string   `json:"sha256"`
	LocalStatus       string   `json:"localStatus"`
	CloudStatus       string   `json:"cloudStatus"`
	BeforeLocalStatus string   `json:"beforeLocalStatus"`
	BeforeCloudStatus string   `json:"beforeCloudStatus"`
	TargetProviderID  string   `json:"targetProviderId,omitempty"`
	TargetObjectKey   string   `json:"targetObjectKey,omitempty"`
	ActualLocalBytes  int64    `json:"actualLocalBytes,omitempty"`
	ActualLocalSHA256 string   `json:"actualLocalSha256,omitempty"`
	ActualCloudBytes  int64    `json:"actualCloudBytes,omitempty"`
	ActualCloudSHA256 string   `json:"actualCloudSha256,omitempty"`
	Source            string   `json:"source,omitempty"`
	SourceBytes       int64    `json:"sourceBytes,omitempty"`
	SourceSHA256      string   `json:"sourceSha256,omitempty"`
	SiblingID         string   `json:"siblingId,omitempty"`
	PlannedActions    []string `json:"plannedActions"`
	CompletedActions  []string `json:"completedActions"`
	Status            string   `json:"status"`
	Reason            string   `json:"reason,omitempty"`
	Apply             bool     `json:"apply"`
	ElapsedMS         int64    `json:"elapsedMs"`
}

// Small I/O boundary lets regression tests inject real failure sequences without a production DB.
type mediaVerifyIO struct {
	local        func(model.StorageObject) (int64, string, error)
	cloud        func(model.StorageObject) (int64, string, error)
	recoverLocal func(model.StorageObject, bool) (string, string, error)
	sync         func() error
	finish       func(MediaVerifyReport) error
}

func VerifyStorageMedia(ctx context.Context, object model.StorageObject, options MediaVerifyOptions) MediaVerifyReport {
	if object.DeletedAt != "" || (options.Apply && !options.WritesStopped) || !mediaHasProof(object) {
		return verifyStorageMedia(object, options, mediaVerifyIO{})
	}
	var provider model.StorageProvider
	var providerErr error
	promotionAttempted := false
	target := object
	if object.ProviderID != generatedMediaProviderID {
		provider, providerErr = mediaProviderForObject(object)
	} else if options.SyncLocal {
		candidate := object
		candidate.CloudSyncExplicit = true
		provider, _, providerErr = selectMediaSyncProvider(ctx, candidate)
		if providerErr == nil {
			target = mediaSyncTarget(object, provider)
		}
	}
	report := verifyStorageMedia(object, options, mediaVerifyIO{
		local: func(item model.StorageObject) (int64, string, error) {
			file, err := openLocalMedia(item)
			if err != nil {
				return 0, "", err
			}
			defer file.Close()
			return copyVerifiedMedia(item, io.Discard, file)
		},
		cloud: func(item model.StorageObject) (int64, string, error) {
			if object.ProviderID == generatedMediaProviderID && !options.SyncLocal {
				return 0, "", mediaIssue("not_applicable", "本地对象未选择上云")
			}
			if providerErr != nil {
				return 0, "", providerErr
			}
			stream, err := readExactCloudMedia(ctx, target, provider)
			if err != nil {
				return 0, "", err
			}
			defer stream.Close()
			return copyVerifiedMedia(item, io.Discard, stream)
		},
		recoverLocal: func(_ model.StorageObject, apply bool) (string, string, error) {
			return recoverVerifiedLocalMedia(ctx, target, provider, apply)
		},
		sync: func() error {
			if providerErr != nil {
				return providerErr
			}
			if object.ProviderID == generatedMediaProviderID {
				owner, found, err := repository.GetUserByID(object.CreatedBy)
				if err != nil {
					return err
				}
				if !found {
					return mediaIssue("blocked", "媒体所属账号不存在")
				}
				if object.CloudSyncStatus == "syncing" {
					// apply requires stopped writes: retire the old process's lease, using its snapshot.
					if err := repository.UpdateStorageObjectSnapshot(object, map[string]any{"cloud_sync_status": "pending", "cloud_sync_lease_token": "", "cloud_sync_lease_until": ""}); err != nil {
						return err
					}
				}
				promotionAttempted = true
				return PromoteGeneratedMedia(WithUser(ctx, model.PublicUser(owner)), object.ID)
			}
			return ensureMediaCloud(ctx, object, object, provider)
		},
		finish: func(report MediaVerifyReport) error {
			if promotionAttempted {
				// Promotion writes its own guarded index; never overwrite it with the old local snapshot.
				return nil
			}
			updates := checkedCloudUpdates(report.CloudStatus, time.Now())
			if report.LocalStatus == "ok" {
				updates["local_copy_removed_at"] = ""
			}
			if report.CloudStatus == "ok" {
				updates["cloud_sync_status"], updates["cloud_sync_error"] = "verified", ""
				updates["cloud_sync_lease_until"], updates["cloud_sync_lease_token"], updates["cloud_sync_next_retry_at"] = "", "", ""
				for _, action := range report.CompletedActions {
					if action == "upload_cloud" {
						updates["cloud_synced_at"] = updates["cloud_verified_at"]
					}
				}
			} else if report.CloudStatus != "not_applicable" {
				updates["cloud_sync_status"], updates["cloud_sync_error"] = "blocked", report.Reason
				updates["cloud_sync_lease_until"], updates["cloud_sync_lease_token"], updates["cloud_sync_next_retry_at"] = "", "", ""
			}
			return repository.UpdateStorageObjectSnapshot(object, updates)
		},
	})
	if providerErr == nil && provider.ID != "" {
		report.TargetProviderID, report.TargetObjectKey = provider.ID, target.ObjectKey
	}
	return report
}

func mediaSyncTarget(object model.StorageObject, provider model.StorageProvider) model.StorageObject {
	target := object
	target.ProviderID, target.Bucket = provider.ID, provider.Bucket
	if object.ProviderID == generatedMediaProviderID {
		if object.CloudTargetProviderID == provider.ID && object.CloudTargetKey != "" {
			target.ObjectKey = object.CloudTargetKey
		} else {
			target.ObjectKey = newMediaCloudKey(object, provider)
		}
	}
	target.PublicURL = objectURL(provider, target.ObjectKey)
	return target
}

func verifyStorageMedia(object model.StorageObject, options MediaVerifyOptions, operations mediaVerifyIO) (report MediaVerifyReport) {
	start := time.Now()
	report = MediaVerifyReport{ObjectID: object.ID, UserID: object.CreatedBy, ProviderID: object.ProviderID, ObjectKey: object.ObjectKey, MimeType: object.MimeType, Bytes: object.Bytes, SHA256: object.SHA256, Apply: options.Apply, Status: "verified", PlannedActions: []string{}, CompletedActions: []string{}}
	defer func() { report.ElapsedMS = time.Since(start).Milliseconds() }()
	if object.DeletedAt != "" || (options.Apply && !options.WritesStopped) {
		report.Status, report.Reason = "failed", "对象已删除或未确认停止写入"
		return
	}
	if !mediaHasProof(object) {
		report.Status, report.Reason = "skipped", "对象缺少可靠字节数或 SHA-256"
		return
	}
	localBytes, localSHA, localErr := operations.local(object)
	report.ActualLocalBytes, report.ActualLocalSHA256, report.LocalStatus = localBytes, localSHA, mediaErrorKind(localErr)
	cloudBytes, cloudSHA, cloudErr := operations.cloud(object)
	report.ActualCloudBytes, report.ActualCloudSHA256, report.CloudStatus = cloudBytes, cloudSHA, mediaErrorKind(cloudErr)
	report.BeforeLocalStatus, report.BeforeCloudStatus = report.LocalStatus, report.CloudStatus
	if report.LocalStatus == "missing" && object.LocalCopyRemovedAt != "" && report.CloudStatus == "ok" && !options.RestoreRemovedLocal {
		report.LocalStatus = "intentionally_removed"
	} else if report.LocalStatus == "missing" {
		source, sibling, err := operations.recoverLocal(object, options.Apply)
		if err != nil {
			localErr = err
		} else {
			report.Source, report.SiblingID = source, sibling
			report.SourceBytes, report.SourceSHA256 = object.Bytes, object.SHA256
			report.PlannedActions = append(report.PlannedActions, "restore_local")
			if options.Apply {
				report.CompletedActions = append(report.CompletedActions, "restore_local")
				report.LocalStatus = "ok"
			}
			localErr = nil
		}
	}
	if localErr == nil && report.CloudStatus == "missing" {
		report.PlannedActions = append(report.PlannedActions, "upload_cloud")
		if options.Apply {
			cloudErr = operations.sync()
			if cloudErr == nil {
				report.CompletedActions = append(report.CompletedActions, "upload_cloud")
				report.CloudStatus = "ok"
				report.ActualCloudBytes, report.ActualCloudSHA256 = object.Bytes, object.SHA256
			} else {
				var attemptError *mediaSyncAttemptError
				if errors.As(cloudErr, &attemptError) {
					report.CloudStatus = attemptError.CloudStatus
				} else {
					report.CloudStatus = mediaErrorKind(cloudErr)
				}
			}
		}
	}
	if localErr == nil && object.ProviderID == generatedMediaProviderID && options.SyncLocal && report.BeforeCloudStatus == "ok" {
		report.PlannedActions = append(report.PlannedActions, "promote_index")
		if options.Apply {
			cloudErr = operations.sync()
			if cloudErr == nil {
				report.CompletedActions = append(report.CompletedActions, "promote_index")
			}
		}
	}
	if report.LocalStatus == "intentionally_removed" {
		localErr = nil
	}
	if localErr != nil || (cloudErr != nil && report.CloudStatus != "not_applicable" && !(report.CloudStatus == "missing" && len(report.PlannedActions) > 0 && !options.Apply)) {
		report.Status = "failed"
		if localErr != nil {
			report.Reason = mediaSafeError(localErr)
		} else {
			report.Reason = mediaSafeError(cloudErr)
		}
	} else if len(report.PlannedActions) > 0 {
		if options.Apply {
			report.Status = "repaired"
		} else {
			report.Status = "planned"
		}
	}
	if options.Apply {
		if err := operations.finish(report); err != nil {
			report.Status, report.Reason = "failed", mediaSafeError(err)
		}
	}
	return
}

func recoverVerifiedLocalMedia(ctx context.Context, object model.StorageObject, provider model.StorageProvider, apply bool) (string, string, error) {
	try := func(open func() (io.ReadCloser, error)) error {
		stream, err := open()
		if err != nil {
			return err
		}
		defer stream.Close()
		if apply {
			return restoreLocalMedia(object, stream)
		}
		_, _, err = copyVerifiedMedia(object, io.Discard, stream)
		return err
	}
	if provider.ID != "" {
		if err := try(func() (io.ReadCloser, error) { return readExactCloudMedia(ctx, object, provider) }); err == nil {
			return "own_cloud", "", nil
		}
	}
	if object.PublicURL != "" {
		err := try(func() (io.ReadCloser, error) {
			request, err := http.NewRequestWithContext(ctx, http.MethodGet, object.PublicURL, nil)
			if err != nil {
				return nil, mediaIssue("blocked", "公开媒体地址无效")
			}
			response, err := SafeProxyHTTPClient().Do(request)
			if err != nil {
				return nil, err
			}
			if response.StatusCode != http.StatusOK {
				response.Body.Close()
				return nil, mediaHTTPError(response.StatusCode)
			}
			return response.Body, nil
		})
		if err == nil {
			return "public_url", "", nil
		}
	}
	for after := ""; ; {
		if err := ctx.Err(); err != nil {
			return "", "", err
		}
		siblings, err := repository.ListStorageObjectSiblings(object, after, 50)
		if err != nil {
			return "", "", err
		}
		for _, sibling := range siblings {
			if err := try(func() (io.ReadCloser, error) { return openLocalMedia(sibling) }); err == nil {
				return "sibling_local", sibling.ID, nil
			}
			if donorProvider, err := mediaProviderForObject(sibling); err == nil {
				if err = try(func() (io.ReadCloser, error) { return readExactCloudMedia(ctx, sibling, donorProvider) }); err == nil {
					return "sibling_cloud", sibling.ID, nil
				}
			}
		}
		if len(siblings) < 50 {
			break
		}
		after = siblings[len(siblings)-1].ID
	}
	return "", "", mediaIssue("missing", "本地、云端及同 SHA-256 副本均无法恢复")
}
