package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/google/uuid"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

const generatedMediaProviderID = "local-generated"

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
	if userID == "" || len(data) == 0 {
		return UploadedStorageObject{}, errors.New("生成媒体内容无效")
	}
	objectID := uuid.NewString()
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
	sum := sha256.Sum256(data)
	object := model.StorageObject{
		ID: objectID, ProviderID: generatedMediaProviderID, ObjectKey: name,
		MimeType: contentType, Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:]),
		CreatedBy: userID, CreatedAt: now(),
	}
	if _, err := repository.SaveStorageObject(object); err != nil {
		_ = os.Remove(filepath.Join(dir, name))
		return UploadedStorageObject{}, err
	}
	return UploadedStorageObject{
		ID: objectID, URL: "/api/files/" + objectID + "/content", StorageKey: "server:" + objectID,
		Bytes: object.Bytes, MimeType: contentType,
	}, nil
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

// SyncGeneratedMedia keeps the public object ID stable and retains the local
// copy as a read fallback. A failed upload never alters the local index.
func SyncGeneratedMedia(ctx context.Context, objectID string) error {
	object, err := repository.GetStorageObject(objectID)
	if err != nil || object.ProviderID != generatedMediaProviderID {
		return err
	}
	settings, err := repository.GetSettings()
	if err != nil {
		return err
	}
	storage := normalizePrivateStorageSetting(settings.Private.Storage)
	if !storage.AutoSyncAllAssets {
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
			return nil
		}
	}
	if provider.ID == "" {
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
	stream, err := readStorageObjectStreamFromProviders(remote, []model.StorageProvider{provider}, "")
	if err == nil {
		var copied []byte
		copied, err = io.ReadAll(io.LimitReader(stream.Body, int64(len(data))+1))
		_ = stream.Body.Close()
		if err == nil {
			remoteHash := sha256.Sum256(copied)
			if len(copied) != len(data) || hex.EncodeToString(remoteHash[:]) != object.SHA256 {
				err = errors.New("云端媒体校验失败")
			}
		}
	}
	if err != nil {
		_ = deleteStorageObjectData(provider, key)
		return err
	}
	if _, err := repository.SaveStorageObject(remote); err != nil {
		_ = deleteStorageObjectData(provider, key)
		return err
	}
	return nil
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
