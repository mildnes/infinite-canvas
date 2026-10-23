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
	"strings"
	"time"

	"github.com/studio-b12/gowebdav"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
)

// Errors stored in the DB/reports never include credentials, URLs or response bodies.
type mediaProblem struct {
	Kind, Message string
	Code          int
}

func (err *mediaProblem) Error() string {
	if err.Code != 0 {
		return fmt.Sprintf("%s（HTTP %d）", err.Message, err.Code)
	}
	return err.Message
}
func mediaIssue(kind, message string) error { return &mediaProblem{Kind: kind, Message: message} }
func mediaErrorKind(err error) string {
	if err == nil {
		return "ok"
	}
	var problem *mediaProblem
	if errors.As(err, &problem) {
		return problem.Kind
	}
	return "unreachable"
}
func mediaSafeError(err error) string {
	var problem *mediaProblem
	if errors.As(err, &problem) {
		return problem.Error()
	}
	if errors.Is(err, context.Canceled) {
		return "媒体操作已取消"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "媒体操作超时"
	}
	return "媒体读写失败，请检查网络、磁盘及存储配置"
}
func mediaHTTPError(code int) error {
	kind := "unreachable"
	if code == http.StatusNotFound {
		kind = "missing"
	}
	if code == http.StatusUnauthorized || code == http.StatusForbidden {
		kind = "blocked"
	}
	return &mediaProblem{Kind: kind, Message: "云端媒体请求失败", Code: code}
}

func mediaHasProof(object model.StorageObject) bool {
	checksum, err := hex.DecodeString(object.SHA256)
	return object.Bytes > 0 && object.Bytes < 1<<63-1 && err == nil && len(checksum) == sha256.Size
}

// Copying is bounded and validates the complete content, including excess bytes.
func copyVerifiedMedia(object model.StorageObject, dst io.Writer, src io.Reader) (int64, string, error) {
	if !mediaHasProof(object) {
		return 0, "", mediaIssue("unverifiable", "对象缺少可靠字节数或 SHA-256")
	}
	hash := sha256.New()
	count, err := io.Copy(io.MultiWriter(dst, hash), io.LimitReader(src, object.Bytes+1))
	checksum := hex.EncodeToString(hash.Sum(nil))
	if err != nil {
		return count, checksum, err
	}
	if count != object.Bytes || !strings.EqualFold(checksum, object.SHA256) {
		return count, checksum, mediaIssue("mismatch", "媒体字节数或 SHA-256 不匹配")
	}
	return count, checksum, nil
}

func localMediaPath(object model.StorageObject) string {
	object.ObjectKey = object.ID + extensionForContentType(object.MimeType)
	return generatedMediaPath(object)
}

func openLocalMedia(object model.StorageObject) (*os.File, error) {
	name := localMediaPath(object)
	if name == "" {
		return nil, mediaIssue("blocked", "本地媒体路径无效")
	}
	info, err := os.Lstat(name)
	if os.IsNotExist(err) {
		return nil, mediaIssue("missing", "本地副本缺失")
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, mediaIssue("mismatch", "本地副本不是普通文件")
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, err
	}
	actual, err := file.Stat()
	if err != nil || !os.SameFile(info, actual) {
		file.Close()
		return nil, mediaIssue("mismatch", "本地副本在读取前发生变化")
	}
	return file, nil
}

func verifyLocalMedia(object model.StorageObject) error {
	file, err := openLocalMedia(object)
	if err != nil {
		return err
	}
	defer file.Close()
	_, _, err = copyVerifiedMedia(object, io.Discard, file)
	return err
}

// Only the indexed provider is considered here, regardless of CloudSyncedAt.
func mediaProviderForObject(object model.StorageObject) (model.StorageProvider, error) {
	settings, err := repository.GetSettings()
	if err != nil {
		return model.StorageProvider{}, err
	}
	providers := normalizePrivateStorageSetting(settings.Private.Storage).Providers
	if saved, found, loadErr := repository.GetUserConfig(object.CreatedBy); loadErr != nil {
		return model.StorageProvider{}, loadErr
	} else if found {
		providers = append(userStorageProvidersForOwner(saved.StorageProvider, object.CreatedBy), providers...)
	}
	for _, provider := range providers {
		if provider.ID == object.ProviderID && provider.Enabled && storageProviderConfigured(provider) {
			if provider.Type == model.StorageProviderTypeS3 {
				provider.Bucket = object.Bucket
				if provider.Bucket == "" {
					return provider, mediaIssue("blocked", "对象未记录原 S3 bucket")
				}
			}
			return provider, nil
		}
	}
	return model.StorageProvider{}, mediaIssue("blocked", "对象原存储提供方不可用")
}

type mediaContextTransport struct {
	context   context.Context
	transport http.RoundTripper
	status    *int
}

func (rt mediaContextTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	response, err := rt.transport.RoundTrip(request.WithContext(rt.context))
	if response != nil {
		*rt.status = response.StatusCode
	}
	return response, err
}
func mediaWebDAVClient(ctx context.Context, provider model.StorageProvider, status *int) (*gowebdav.Client, error) {
	client, err := newWebDAVClient(provider)
	if err != nil {
		return nil, mediaIssue("blocked", "WebDAV 配置无效")
	}
	client.SetTransport(mediaContextTransport{ctx, webDAVStorageTransport(provider), status})
	return client, nil
}

func readExactCloudMedia(ctx context.Context, object model.StorageObject, provider model.StorageProvider) (io.ReadCloser, error) {
	if object.ProviderID != provider.ID || !provider.Enabled || !storageProviderConfigured(provider) {
		return nil, mediaIssue("blocked", "对象与云端提供方不匹配")
	}
	if provider.Type == model.StorageProviderTypeWebDAV {
		status := 0
		client, err := mediaWebDAVClient(ctx, provider, &status)
		if err != nil {
			return nil, err
		}
		key, err := cleanStoragePath(object.ObjectKey)
		if err != nil {
			return nil, mediaIssue("blocked", "云端对象路径无效")
		}
		stream, err := client.ReadStream(key)
		if err != nil && status >= 400 {
			return nil, mediaHTTPError(status)
		}
		return stream, err
	}
	if provider.Type != model.StorageProviderTypeS3 {
		return nil, mediaIssue("blocked", "云端存储类型不支持")
	}
	provider.Bucket = object.Bucket
	request, err := newS3Request(http.MethodGet, provider, object.ObjectKey, nil, 0)
	if err != nil {
		return nil, mediaIssue("blocked", "S3 请求配置无效")
	}
	response, err := SafeProxyHTTPClient().Do(request.WithContext(ctx))
	if err != nil {
		return nil, err
	}
	if response.StatusCode != http.StatusOK {
		response.Body.Close()
		return nil, mediaHTTPError(response.StatusCode)
	}
	return response.Body, nil
}

func verifyExactCloudMedia(ctx context.Context, object model.StorageObject, provider model.StorageProvider) error {
	stream, err := readExactCloudMedia(ctx, object, provider)
	if err != nil {
		return err
	}
	defer stream.Close()
	_, _, err = copyVerifiedMedia(object, io.Discard, stream)
	return err
}

func uploadLocalMedia(ctx context.Context, source, target model.StorageObject, provider model.StorageProvider) error {
	file, err := openLocalMedia(source)
	if err != nil {
		return err
	}
	defer file.Close()
	if _, _, err = copyVerifiedMedia(source, io.Discard, file); err != nil {
		return err
	}
	if _, err = file.Seek(0, io.SeekStart); err != nil {
		return err
	}
	if provider.Type == model.StorageProviderTypeWebDAV {
		status := 0
		client, err := mediaWebDAVClient(ctx, provider, &status)
		if err != nil {
			return err
		}
		key, err := cleanStoragePath(target.ObjectKey)
		if err != nil {
			return mediaIssue("blocked", "云端对象路径无效")
		}
		if err = client.MkdirAll(path.Dir(key), 0755); err == nil {
			client.SetHeader("Content-Type", source.MimeType)
			err = client.WriteStream(key, file, 0644)
		}
		if err != nil && status >= 400 {
			return mediaHTTPError(status)
		}
		return err
	}
	provider.Bucket = target.Bucket
	request, err := newS3Request(http.MethodPut, provider, target.ObjectKey, file, source.Bytes)
	if err != nil {
		return mediaIssue("blocked", "S3 请求配置无效")
	}
	request.Header.Set("Content-Type", source.MimeType)
	response, err := SafeProxyHTTPClient().Do(request.WithContext(ctx))
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return mediaHTTPError(response.StatusCode)
	}
	return nil
}

// An existing conflicting file is never overwritten, including a racing installer.
func restoreLocalMedia(object model.StorageObject, stream io.Reader) error {
	if err := os.MkdirAll(GeneratedMediaDir(), 0700); err != nil {
		return err
	}
	name := localMediaPath(object)
	if name == "" {
		return mediaIssue("blocked", "本地媒体路径无效")
	}
	file, err := os.CreateTemp(GeneratedMediaDir(), ".media-repair-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	defer file.Close()
	if _, _, err = copyVerifiedMedia(object, file, stream); err != nil {
		return err
	}
	if err = file.Sync(); err != nil {
		return err
	}
	if err = file.Close(); err != nil {
		return err
	}
	if err = os.Link(file.Name(), name); err != nil {
		if os.IsExist(err) {
			return verifyLocalMedia(object)
		}
		return err
	}
	directory, err := os.Open(GeneratedMediaDir())
	if err != nil {
		return err
	}
	defer directory.Close()
	return directory.Sync()
}

func checkedCloudUpdates(kind string, current time.Time) map[string]any {
	updates := map[string]any{"cloud_checked_at": current.UTC().Format(time.RFC3339Nano), "cloud_check_status": kind}
	if kind == "ok" {
		updates["cloud_verified_at"] = updates["cloud_checked_at"]
	}
	return updates
}
