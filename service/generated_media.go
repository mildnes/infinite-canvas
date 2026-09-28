package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"image"
	_ "image/gif"
	_ "image/jpeg"
	_ "image/png"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

const generatedMediaProviderID = "local-generated"

var (
	generatedMediaSaveMu sync.Mutex
	generatedMediaSyncMu sync.Mutex
)

// GeneratedMediaDir is persisted alongside the SQLite database in Docker.
// Non-SQLite deployments must mount data/ or /app/data as persistent storage.
func GeneratedMediaDir() string {
	dsn := strings.TrimSpace(config.Cfg.DatabaseDSN)
	driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
	if (driver == "" || driver == "sqlite") && filepath.IsAbs(dsn) && !strings.HasPrefix(dsn, "file:") {
		return filepath.Join(filepath.Dir(strings.SplitN(dsn, "?", 2)[0]), "generated-media")
	}
	if info, err := os.Stat("/app/data"); err == nil && info.IsDir() {
		return "/app/data/generated-media"
	}
	return "data/generated-media"
}

// SaveGeneratedMedia persists bytes before writing the task's short reference.
func SaveGeneratedMedia(userID, contentType string, data []byte) (UploadedStorageObject, error) {
	return saveGeneratedMedia(userID, contentType, data, uuid.NewString(), "")
}

// SaveGeneratedMediaDeduplicated stores one content-addressed copy per user.
// sourceURL is audit-only and is never used as the returned long-term reference.
func SaveGeneratedMediaDeduplicated(userID, contentType string, data []byte, sourceURL string) (UploadedStorageObject, error) {
	sum := sha256.Sum256(data)
	objectID := GeneratedMediaObjectID(userID, hex.EncodeToString(sum[:]))
	return saveGeneratedMedia(userID, contentType, data, objectID, sourceURL)
}

func GeneratedMediaObjectID(userID, checksum string) string {
	stableKey := strings.TrimSpace(userID) + ":sha256:" + strings.ToLower(strings.TrimSpace(checksum))
	return uuid.NewSHA1(uuid.NameSpaceURL, []byte("infinite-canvas/generated-media/content/"+stableKey)).String()
}

// SaveGeneratedMediaStable uses a deterministic result key for retried uploads.
// The caller must scope stableKey to the owning task and output identifier.
func SaveGeneratedMediaStable(userID, contentType string, data []byte, stableKey string) (UploadedStorageObject, error) {
	stableKey = strings.TrimSpace(stableKey)
	if stableKey == "" {
		return UploadedStorageObject{}, errors.New("生成媒体结果标识无效")
	}
	objectID := uuid.NewSHA1(uuid.NameSpaceURL, []byte("infinite-canvas/generated-media/"+stableKey)).String()
	return saveGeneratedMedia(userID, contentType, data, objectID, "")
}

func saveGeneratedMedia(userID, contentType string, data []byte, objectID string, sourceURL string) (UploadedStorageObject, error) {
	generatedMediaSaveMu.Lock()
	defer generatedMediaSaveMu.Unlock()
	if userID == "" || len(data) == 0 {
		return UploadedStorageObject{}, errors.New("生成媒体内容无效")
	}
	contentType = strings.TrimSpace(strings.Split(contentType, ";")[0])
	if contentType == "" {
		contentType = "application/octet-stream"
	}
	sum := sha256.Sum256(data)
	checksum := hex.EncodeToString(sum[:])
	if existing, err := repository.GetStorageObject(objectID); err == nil {
		if existing.CreatedBy != userID || existing.DeletedAt != "" || existing.SHA256 != checksum || existing.MimeType != contentType || existing.Bytes != int64(len(data)) {
			return UploadedStorageObject{}, errors.New("生成媒体结果标识已被其他内容占用")
		}
		if existing.SourceURL == "" && strings.TrimSpace(sourceURL) != "" {
			existing.SourceURL = strings.TrimSpace(sourceURL)
			_, _ = repository.SaveStorageObject(existing)
		}
		return UploadedStorageObject{
			ID: objectID, URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
			Bytes: existing.Bytes, MimeType: existing.MimeType, Width: existing.Width, Height: existing.Height,
		}, nil
	} else if !errors.Is(err, gorm.ErrRecordNotFound) {
		return UploadedStorageObject{}, err
	}
	name := objectID + extensionForContentType(contentType)
	dir := GeneratedMediaDir()
	if err := os.MkdirAll(dir, 0700); err != nil {
		return UploadedStorageObject{}, err
	}
	tmp, err := os.CreateTemp(dir, ".generated-*")
	if err != nil {
		return UploadedStorageObject{}, err
	}
	tmpName := tmp.Name()
	defer os.Remove(tmpName)
	if _, err = tmp.Write(data); err != nil {
		_ = tmp.Close()
		return UploadedStorageObject{}, err
	}
	if err = tmp.Sync(); err != nil {
		_ = tmp.Close()
		return UploadedStorageObject{}, err
	}
	if err = tmp.Close(); err != nil {
		return UploadedStorageObject{}, err
	}
	if err = os.Rename(tmpName, filepath.Join(dir, name)); err != nil {
		return UploadedStorageObject{}, err
	}
	if directory, openErr := os.Open(dir); openErr == nil {
		err = directory.Sync()
		_ = directory.Close()
	} else {
		err = openErr
	}
	if errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.ENOTSUP) {
		err = nil // Some local filesystems do not support syncing directories.
	}
	if err != nil {
		_ = os.Remove(filepath.Join(dir, name))
		return UploadedStorageObject{}, err
	}
	width, height := generatedMediaDimensions(data)
	object := model.StorageObject{
		ID: objectID, ProviderID: generatedMediaProviderID, ObjectKey: name,
		MimeType: contentType, Bytes: int64(len(data)), SHA256: checksum, Width: width, Height: height,
		CreatedBy: userID, CreatedAt: now(), SourceURL: strings.TrimSpace(sourceURL),
	}
	if _, err := repository.SaveStorageObject(object); err != nil {
		_ = os.Remove(filepath.Join(dir, name))
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{
		ID: objectID, URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
		Bytes: object.Bytes, MimeType: contentType, Width: width, Height: height,
	}, nil
}

func generatedMediaDimensions(data []byte) (int, int) {
	config, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || config.Width <= 0 || config.Height <= 0 {
		return 0, 0
	}
	return config.Width, config.Height
}

// DiscardGeneratedMedia is used only when persisting the owning task failed.
func DiscardGeneratedMedia(objectID string) {
	object, err := repository.GetStorageObject(objectID)
	if err != nil || object.ProviderID != generatedMediaProviderID {
		return
	}
	if err := repository.DeleteStorageObjectRecord(objectID); err == nil {
		_ = os.Remove(generatedMediaPath(object))
	}
}

func generatedMediaPath(object model.StorageObject) string {
	if object.ObjectKey == "" || filepath.Base(object.ObjectKey) != object.ObjectKey || !strings.HasPrefix(object.ObjectKey, object.ID+".") {
		return ""
	}
	return filepath.Join(GeneratedMediaDir(), object.ObjectKey)
}

// SyncGeneratedMedia honors the administrator's automatic-sync switch.
func SyncGeneratedMedia(ctx context.Context, objectID string) error {
	return syncGeneratedMedia(ctx, objectID, false)
}

// PromoteGeneratedMedia explicitly backfills a local object into its owner's
// configured cloud storage. It does not depend on the automatic-sync switch.
func PromoteGeneratedMedia(ctx context.Context, objectID string) error {
	return syncGeneratedMedia(ctx, objectID, true)
}

// syncGeneratedMedia keeps the public object ID stable and retains the local
// copy as a read fallback. A failed upload never alters the local index.
func syncGeneratedMedia(ctx context.Context, objectID string, explicit bool) error {
	generatedMediaSyncMu.Lock()
	defer generatedMediaSyncMu.Unlock()
	object, err := repository.GetStorageObject(objectID)
	if err != nil {
		return err
	}
	if object.ProviderID != generatedMediaProviderID {
		return nil // A completed prior run is safe to retry.
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	if !explicit && !storage.AutoSyncAllAssets {
		return nil
	}
	var provider model.StorageProvider
	if storage.AllowUserProvider {
		if saved, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr == nil && found {
			for _, candidate := range userStorageProvidersForOwner(saved.StorageProvider, object.CreatedBy) {
				if candidate.Enabled && storageProviderConfigured(candidate) {
					provider = candidate
					break
				}
			}
		}
	}
	if provider.ID == "" && canUseGlobalStorage(ctx, storage) {
		provider, err = selectStorageProvider(storage)
		if err != nil {
			if explicit {
				return errors.New("当前账号没有可用的云存储提供方")
			}
			return nil
		}
	}
	if provider.ID == "" {
		if explicit {
			return errors.New("当前账号没有可用的云存储提供方")
		}
		return nil
	}
	data, err := os.ReadFile(generatedMediaPath(object))
	if err != nil {
		return err
	}
	key := strings.Trim(strings.Trim(provider.PathPrefix, "/")+"/"+object.CreatedBy+"/"+time.Now().Format("2006/01/02")+"/"+object.ObjectKey, "/")
	if err := putStorageObject(provider, key, object.MimeType, data); err != nil {
		_ = deleteStorageObjectData(provider, key) // Upload may have committed before a timeout.
		return storageUploadError(provider, err)
	}
	remote := object
	remote.ProviderID, remote.Bucket, remote.ObjectKey, remote.PublicURL = provider.ID, provider.Bucket, path.Clean(key), objectURL(provider, key)
	err = verifyGeneratedCloudObject(remote, provider)
	if err != nil {
		_ = deleteStorageObjectData(provider, key)
		return err
	}
	remote.CloudSyncedAt = time.Now().UTC().Format(time.RFC3339Nano)
	if _, err := repository.SaveStorageObject(remote); err != nil {
		_ = deleteStorageObjectData(provider, key)
		return err
	}
	return nil
}

func verifyGeneratedCloudObject(object model.StorageObject, provider model.StorageProvider) error {
	if object.Bytes <= 0 || object.SHA256 == "" || provider.ID != object.ProviderID || !provider.Enabled || !storageProviderConfigured(provider) {
		return errors.New("云端媒体或提供方信息不完整")
	}
	stream, err := readStorageObjectStreamFromProviders(object, []model.StorageProvider{provider}, "")
	if err != nil {
		return err
	}
	defer stream.Body.Close()
	if stream.StatusCode < 200 || stream.StatusCode >= 300 {
		return errors.New("云端媒体响应状态异常")
	}
	hash := sha256.New()
	count, err := io.Copy(hash, io.LimitReader(stream.Body, object.Bytes+1))
	if err != nil {
		return err
	}
	if count != object.Bytes || hex.EncodeToString(hash.Sum(nil)) != object.SHA256 {
		return errors.New("云端媒体内容或 SHA-256 不匹配")
	}
	return nil
}

func generatedCloudProvider(object model.StorageObject) (model.StorageProvider, error) {
	if object.ProviderID == generatedMediaProviderID || object.CloudSyncedAt == "" {
		return model.StorageProvider{}, errors.New("对象尚未上云")
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return model.StorageProvider{}, err
	}
	providers := normalizePrivateStorageSetting(settings.Private.Storage).Providers
	if owner, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr != nil {
		return model.StorageProvider{}, loadErr
	} else if found {
		providers = append(userStorageProvidersForOwner(owner.StorageProvider, object.CreatedBy), providers...)
	}
	for _, provider := range providers {
		if provider.ID == object.ProviderID && provider.Enabled && storageProviderConfigured(provider) {
			return provider, nil
		}
	}
	return model.StorageProvider{}, errors.New("原云存储提供方不可用，保留本地副本")
}

// RemoveVerifiedGeneratedCopy removes only a redundant local copy after a
// grace period. It never removes the cloud object or changes its public ID.
func RemoveVerifiedGeneratedCopy(objectID string, minAge time.Duration) error {
	object, err := repository.GetStorageObject(objectID)
	if err != nil {
		return err
	}
	if !generatedCopyReady(object, time.Now(), minAge) {
		return errors.New("本地副本仍在保留期或对象尚未完成云端同步")
	}
	provider, err := generatedCloudProvider(object)
	if err != nil {
		return err
	}
	if err := verifyGeneratedCloudObject(object, provider); err != nil {
		return err
	}
	local := object
	local.ObjectKey = object.ID + extensionForContentType(object.MimeType)
	filePath := generatedMediaPath(local)
	info, err := os.Lstat(filePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() || info.Size() != object.Bytes {
		return errors.New("本地副本类型或大小不匹配")
	}
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	hash := sha256.New()
	_, err = io.Copy(hash, file)
	_ = file.Close()
	if err != nil || hex.EncodeToString(hash.Sum(nil)) != object.SHA256 {
		return errors.New("本地副本 SHA-256 不匹配")
	}
	latest, err := repository.GetStorageObject(object.ID)
	if err != nil || latest.ProviderID != object.ProviderID || latest.CloudSyncedAt != object.CloudSyncedAt || latest.LocalCopyRemovedAt != "" {
		return errors.New("对象索引发生变化，未清理本地副本")
	}
	if err := os.Remove(filePath); err != nil {
		return err
	}
	latest.LocalCopyRemovedAt = time.Now().UTC().Format(time.RFC3339Nano)
	_, err = repository.SaveStorageObject(latest)
	return err
}

func generatedCopyReady(object model.StorageObject, current time.Time, minAge time.Duration) bool {
	syncedAt, err := time.Parse(time.RFC3339Nano, object.CloudSyncedAt)
	return err == nil && object.ProviderID != generatedMediaProviderID && object.LocalCopyRemovedAt == "" &&
		minAge >= 7*24*time.Hour && !current.Before(syncedAt.Add(minAge))
}

func generatedMediaFallback(object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	fallback := object
	fallback.ObjectKey = object.ID + extensionForContentType(object.MimeType)
	result, err := downloadGeneratedMedia(fallback, rangeHeader)
	result.Object = object
	return result, err
}

func hasGeneratedMediaCopy(object model.StorageObject) bool {
	fallback := object
	fallback.ObjectKey = object.ID + extensionForContentType(object.MimeType)
	_, err := os.Stat(generatedMediaPath(fallback))
	return err == nil
}

type generatedMediaStream struct {
	io.Reader
	file *os.File
}

func (stream generatedMediaStream) Close() error { return stream.file.Close() }

func downloadGeneratedMedia(object model.StorageObject, rangeHeader string) (DownloadedStorageObject, error) {
	filePath := generatedMediaPath(object)
	if filePath == "" {
		return DownloadedStorageObject{}, errors.New("生成媒体路径无效")
	}
	file, err := os.Open(filePath)
	if err != nil {
		return DownloadedStorageObject{}, err
	}
	info, err := file.Stat()
	if err != nil {
		_ = file.Close()
		return DownloadedStorageObject{}, err
	}
	size := info.Size()
	result := DownloadedStorageObject{Object: object, AcceptRanges: true, StatusCode: http.StatusOK, ContentLength: size}
	if strings.TrimSpace(rangeHeader) != "" {
		part, valid := parseStorageByteRange(rangeHeader, size)
		if !valid {
			result.StatusCode = http.StatusRequestedRangeNotSatisfiable
			result.ContentLength = 0
			result.ContentRange = fmt.Sprintf("bytes */%d", size)
			result.Stream = generatedMediaStream{Reader: strings.NewReader(""), file: file}
			return result, nil
		}
		result.StatusCode = http.StatusPartialContent
		result.ContentLength = part.length
		result.ContentRange = fmt.Sprintf("bytes %d-%d/%d", part.offset, part.offset+part.length-1, size)
		result.Stream = generatedMediaStream{Reader: io.NewSectionReader(file, part.offset, part.length), file: file}
		return result, nil
	}
	result.Stream = file
	return result, nil
}
