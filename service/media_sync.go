package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log"
	"path"
	"strings"
	"sync"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const mediaSyncLeaseDuration = 3 * time.Minute
const mediaSyncTimeLayout = "2006-01-02T15:04:05.000000000Z"

var mediaSyncSlots = make(chan struct{}, 2)
var mediaSyncSchedulerOnce sync.Once
var mediaSyncRetryDelays = []time.Duration{time.Minute, 5 * time.Minute, 15 * time.Minute, time.Hour, 6 * time.Hour}

func mediaProviderFingerprint(provider model.StorageProvider) string {
	// Capacity measurements, labels and scheduling weights are not target changes.
	data, _ := json.Marshal([]any{provider.ID, provider.Type, provider.Endpoint, provider.Region, provider.Bucket, provider.PathPrefix, provider.Username, provider.Password, provider.AccessKeyID, provider.SecretAccessKey, provider.OwnerUserID, provider.PublicBaseURL})
	checksum := sha256.Sum256(data)
	return hex.EncodeToString(checksum[:])
}

func newMediaCloudKey(object model.StorageObject, provider model.StorageProvider) string {
	date := "generated"
	if len(object.CreatedAt) >= 10 {
		if created, err := time.Parse("2006-01-02", object.CreatedAt[:10]); err == nil {
			date = created.Format("2006/01/02")
		}
	}
	return strings.Trim(path.Join(provider.PathPrefix, object.CreatedBy, date, object.ID+extensionForContentType(object.MimeType)), "/")
}

func selectMediaSyncProvider(ctx context.Context, object model.StorageObject) (model.StorageProvider, bool, error) {
	owner, found, err := repository.GetUserByID(object.CreatedBy)
	if err != nil {
		return model.StorageProvider{}, false, err
	}
	if !found {
		return model.StorageProvider{}, false, mediaIssue("blocked", "媒体所属账号不存在")
	}
	if owner.Status == model.UserStatusBan || owner.Role == model.UserRoleGuest {
		return model.StorageProvider{}, false, mediaIssue("blocked", "媒体所属账号当前无同步权限")
	}
	ctx = WithUser(ctx, model.PublicUser(owner))
	settings, err := repository.GetSettings()
	if err != nil {
		return model.StorageProvider{}, false, err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	if !object.CloudSyncExplicit && !storage.AutoSyncAllAssets {
		return model.StorageProvider{}, true, nil
	}
	var providers []model.StorageProvider
	if storage.AllowUserProvider {
		config, found, err := repository.GetUserConfig(object.CreatedBy)
		if err != nil {
			return model.StorageProvider{}, false, err
		}
		if found {
			providers = userStorageProvidersForOwner(config.StorageProvider, object.CreatedBy)
		}
	}
	wanted := object.CloudTargetProviderID
	if object.ProviderID != generatedMediaProviderID {
		wanted = object.ProviderID
	}
	if canUseGlobalStorage(ctx, storage) {
		if wanted != "" {
			providers = append(providers, storage.Providers...)
		} else if provider, err := selectStorageProvider(storage); err == nil {
			providers = append(providers, provider)
		}
	}
	for _, provider := range providers {
		if (wanted == "" || wanted == provider.ID) && provider.Enabled && storageProviderConfigured(provider) {
			if object.ProviderID != generatedMediaProviderID && provider.Type == model.StorageProviderTypeS3 {
				provider.Bucket = object.Bucket
				if provider.Bucket == "" {
					return provider, false, mediaIssue("blocked", "对象未记录原 S3 bucket")
				}
			}
			return provider, false, nil
		}
	}
	return model.StorageProvider{}, false, mediaIssue("blocked", "当前账号没有可用的目标云存储提供方")
}

func syncGeneratedMedia(ctx context.Context, objectID string, explicit bool) error {
	object, err := repository.GetStorageObject(objectID)
	if err != nil {
		return err
	}
	original := object
	user, ok := UserFromContext(ctx)
	if !ok || user.ID != object.CreatedBy || object.DeletedAt != "" {
		return mediaIssue("blocked", "对象账号不匹配或已删除")
	}
	if !explicit && object.ProviderID != generatedMediaProviderID {
		return nil
	}
	if object.CloudSyncStatus == "syncing" && object.CloudSyncLeaseUntil > time.Now().UTC().Format(mediaSyncTimeLayout) {
		if explicit {
			return mediaIssue("busy", "对象已有同步租约，请稍后重试")
		}
		return nil
	}
	if !explicit && (object.CloudSyncStatus == "pending" || object.CloudSyncStatus == "retry" || object.CloudSyncStatus == "syncing") {
		if object.CloudSyncNextRetryAt > time.Now().UTC().Format(mediaSyncTimeLayout) {
			return nil
		}
		return executeMediaSync(ctx, object)
	}
	if !explicit && object.CloudSyncStatus == "blocked" {
		return mediaIssue("blocked", object.CloudSyncError)
	}
	object.CloudSyncExplicit = explicit
	// An explicit action can confirm changed credentials, but cannot move an indexed cloud object.
	if explicit {
		object.CloudTargetConfigHash = ""
	}
	provider, paused, err := selectMediaSyncProvider(ctx, object)
	if paused {
		return nil
	}
	if err != nil {
		if writeErr := repository.UpdateStorageObjectSnapshot(original, map[string]any{"cloud_sync_status": "blocked", "cloud_sync_error": mediaSafeError(err), "cloud_sync_explicit": explicit, "cloud_sync_lease_token": "", "cloud_sync_lease_until": ""}); writeErr != nil {
			return writeErr
		}
		return err
	}
	key := object.ObjectKey
	if object.ProviderID == generatedMediaProviderID {
		if object.CloudTargetProviderID == provider.ID && object.CloudTargetKey != "" {
			key = object.CloudTargetKey
		} else {
			key = newMediaCloudKey(object, provider)
		}
	}
	updates := map[string]any{"cloud_sync_status": "pending", "cloud_sync_error": "", "cloud_sync_next_retry_at": "", "cloud_sync_lease_until": "", "cloud_sync_lease_token": "", "cloud_sync_explicit": explicit,
		"cloud_target_provider_id": provider.ID, "cloud_target_bucket": provider.Bucket, "cloud_target_key": key, "cloud_target_config_hash": mediaProviderFingerprint(provider)}
	if explicit {
		updates["cloud_sync_attempts"] = 0
	}
	if err = repository.UpdateStorageObjectSnapshot(original, updates); err != nil {
		return err
	}
	object, err = repository.GetStorageObject(object.ID)
	if err != nil {
		return err
	}
	return executeMediaSync(ctx, object)
}

// PUT outcomes are confirmed by a complete read, including an uncertain timeout.
func ensureMediaCloud(ctx context.Context, source, target model.StorageObject, provider model.StorageProvider) error {
	return ensureMediaCloudWithIO(func() error { return verifyExactCloudMedia(ctx, target, provider) }, func() error { return uploadLocalMedia(ctx, source, target, provider) })
}

type mediaSyncAttemptError struct {
	CloudStatus string
	Err         error
}

func (err *mediaSyncAttemptError) Error() string { return mediaSafeError(err.Err) }
func (err *mediaSyncAttemptError) Unwrap() error { return err.Err }

func ensureMediaCloudWithIO(verify, upload func() error) error {
	err := verify()
	if err == nil {
		return nil
	}
	if mediaErrorKind(err) != "missing" {
		return &mediaSyncAttemptError{mediaErrorKind(err), err}
	}
	putErr := upload()
	verifyErr := verify()
	if verifyErr == nil {
		return nil
	}
	if putErr != nil {
		return &mediaSyncAttemptError{mediaErrorKind(verifyErr), putErr}
	}
	return &mediaSyncAttemptError{mediaErrorKind(verifyErr), verifyErr}
}

func mediaSyncFailureUpdates(object model.StorageObject, err error, current time.Time) map[string]any {
	updates := map[string]any{"cloud_sync_error": mediaSafeError(err), "cloud_sync_lease_token": "", "cloud_sync_lease_until": "", "cloud_sync_next_retry_at": "", "cloud_sync_status": "blocked"}
	var attemptError *mediaSyncAttemptError
	if errors.As(err, &attemptError) {
		for key, value := range checkedCloudUpdates(attemptError.CloudStatus, current) {
			updates[key] = value
		}
	}
	kind := mediaErrorKind(err)
	if kind == "paused" {
		updates["cloud_sync_status"] = "pending"
	}
	if (kind == "unreachable" || kind == "missing") && object.CloudSyncAttempts <= len(mediaSyncRetryDelays) {
		attempt := object.CloudSyncAttempts
		if attempt < 1 {
			attempt = 1
		}
		// Stable object jitter avoids synchronized retries without storing random state.
		sum := sha256.Sum256([]byte(object.ID))
		delay := mediaSyncRetryDelays[attempt-1] + time.Duration(sum[0])*time.Second/10
		updates["cloud_sync_status"] = "retry"
		updates["cloud_sync_next_retry_at"] = current.Add(delay).UTC().Format(mediaSyncTimeLayout)
	}
	return updates
}

func executeMediaSync(ctx context.Context, object model.StorageObject) error {
	select {
	case mediaSyncSlots <- struct{}{}:
		defer func() { <-mediaSyncSlots }()
	case <-ctx.Done():
		return ctx.Err()
	}
	provider, paused, err := selectMediaSyncProvider(ctx, object)
	if paused {
		return nil
	}
	if err == nil && mediaProviderFingerprint(provider) != object.CloudTargetConfigHash {
		err = mediaIssue("blocked", "云存储配置已变化，请显式重试确认目标")
	}
	if err == nil && object.CloudSyncAttempts > len(mediaSyncRetryDelays) {
		err = mediaIssue("blocked", "同步尝试次数已耗尽，请显式重试")
	}
	if err != nil {
		return errors.Join(err, repository.UpdateStorageObjectSnapshot(object, mediaSyncFailureUpdates(object, err, time.Now())))
	}
	current := time.Now().UTC()
	token := uuid.NewString()
	claimed, err := repository.ClaimStorageObjectSync(object, token, current.Format(mediaSyncTimeLayout), current.Add(mediaSyncLeaseDuration).Format(mediaSyncTimeLayout))
	if err != nil {
		return err
	}
	if !claimed {
		return mediaIssue("busy", "对象同步已被其他任务接管或状态已变化")
	}
	object.CloudSyncLeaseToken, object.CloudSyncStatus = token, "syncing"
	object.CloudSyncAttempts++
	workCtx, cancel := context.WithTimeout(ctx, 20*time.Minute)
	defer cancel()
	stopRenew := make(chan struct{})
	defer close(stopRenew)
	go func() {
		ticker := time.NewTicker(time.Minute)
		defer ticker.Stop()
		for {
			select {
			case <-stopRenew:
				return
			case <-workCtx.Done():
				return
			case <-ticker.C:
				ok, err := repository.RenewStorageObjectSyncLease(object.ID, token, time.Now().UTC().Add(mediaSyncLeaseDuration).Format(mediaSyncTimeLayout))
				if err != nil || !ok {
					cancel()
					return
				}
			}
		}
	}()
	target := object
	target.ProviderID, target.Bucket, target.ObjectKey = object.CloudTargetProviderID, object.CloudTargetBucket, object.CloudTargetKey
	target.PublicURL = objectURL(provider, target.ObjectKey)
	err = ensureMediaCloud(workCtx, object, target, provider)
	if err == nil {
		// Re-read authorization/configuration after I/O, not just before it.
		latestProvider, paused, checkErr := selectMediaSyncProvider(ctx, object)
		if paused {
			err = mediaIssue("paused", "自动上云已关闭，任务已暂停")
		} else if checkErr != nil || mediaProviderFingerprint(latestProvider) != object.CloudTargetConfigHash {
			err = mediaIssue("blocked", "账号权限或云存储配置已变化，未回写同步结果")
		}
	}
	if err != nil {
		writeErr := repository.UpdateStorageObjectSnapshot(object, mediaSyncFailureUpdates(object, err, time.Now()))
		return errors.Join(err, writeErr)
	}
	updates := checkedCloudUpdates("ok", time.Now())
	updates["provider_id"], updates["bucket"], updates["object_key"], updates["public_url"] = target.ProviderID, target.Bucket, target.ObjectKey, target.PublicURL
	updates["cloud_synced_at"] = updates["cloud_verified_at"]
	updates["cloud_sync_status"], updates["cloud_sync_error"], updates["cloud_sync_next_retry_at"] = "verified", "", ""
	updates["cloud_sync_lease_token"], updates["cloud_sync_lease_until"] = "", ""
	return repository.UpdateStorageObjectSnapshot(object, updates)
}

func StartMediaSyncScheduler() {
	mediaSyncSchedulerOnce.Do(func() {
		go func() {
			ticker := time.NewTicker(time.Minute)
			defer ticker.Stop()
			for {
				var objects []model.StorageObject
				settings, err := repository.GetSettings()
				if err == nil {
					objects, err = repository.ListDueStorageObjectSyncs(time.Now().UTC().Format(mediaSyncTimeLayout), 50, settings.Private.Storage.AutoSyncAllAssets)
				}
				if err != nil {
					log.Printf("load media sync queue failed: %v", err)
				}
				var workers sync.WaitGroup
				jobs := make(chan model.StorageObject)
				for i := 0; i < 2; i++ {
					workers.Add(1)
					go func() {
						defer workers.Done()
						for object := range jobs {
							user, found, err := repository.GetUserByID(object.CreatedBy)
							if err == nil && !found {
								err = mediaIssue("blocked", "媒体所属账号不存在")
							}
							if err == nil {
								err = executeMediaSync(WithUser(context.Background(), model.PublicUser(user)), object)
							} else {
								_ = repository.UpdateStorageObjectSnapshot(object, mediaSyncFailureUpdates(object, err, time.Now()))
							}
							if err != nil {
								log.Printf("media sync object=%s: %s", object.ID, mediaSafeError(err))
							}
						}
					}()
				}
				for _, object := range objects {
					jobs <- object
				}
				close(jobs)
				workers.Wait()
				<-ticker.C
			}
		}()
	})
}
