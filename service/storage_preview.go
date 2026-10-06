package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"image"
	"image/color"
	"image/draw"
	"image/jpeg"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	_ "golang.org/x/image/bmp"
	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/tiff"
	_ "golang.org/x/image/webp"
	"golang.org/x/sync/singleflight"
)

const StoragePreviewMaxBytes = 2 << 20
const storagePreviewSide = 1024
const storagePreviewSourceLimit = 128 << 20

var ErrStoragePreviewForbidden = errors.New("无权提交该对象预览")
var ErrStoragePreviewInvalid = errors.New("预览必须为不超过 2 MiB、最长边不超过 1024 的完整 JPEG")

var previewID = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
var previewWorkers = make(chan struct{}, 2)
var previewBuilds singleflight.Group
var previewQueue = struct {
	sync.Mutex
	pending map[string]bool
	failed  map[string]time.Time
}{pending: make(map[string]bool), failed: make(map[string]time.Time)}

// Previews are disposable display caches, never original-media copies.
func StoragePreviewPath(id string) string {
	if !previewID.MatchString(id) {
		return ""
	}
	return filepath.Join(GeneratedMediaDir(), "previews", id+".jpg")
}

func canWriteStoragePreview(object model.StorageObject, userID string) bool {
	return userID != "" && object.CreatedBy == userID && object.DeletedAt == "" && strings.HasPrefix(object.MimeType, "image/")
}

func SubmitStoragePreview(ctx context.Context, id string, data []byte) error {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return err
	}
	user, ok := UserFromContext(ctx)
	if !ok || !canWriteStoragePreview(object, user.ID) {
		return ErrStoragePreviewForbidden
	}
	if err := validateStoragePreview(data); err != nil {
		return ErrStoragePreviewInvalid
	}
	return writeStoragePreview(id, data)
}

func OpenStoragePreview(id string) (*os.File, error) {
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return nil, err
	}
	if object.DeletedAt != "" || !strings.HasPrefix(object.MimeType, "image/") {
		return nil, os.ErrNotExist
	}
	name := StoragePreviewPath(id)
	if name == "" {
		return nil, os.ErrNotExist
	}
	file, err := os.Open(name)
	if err != nil {
		QueueStoragePreview(id, 0)
	}
	return file, err
}

func validateStoragePreview(data []byte) error {
	if len(data) == 0 || len(data) > StoragePreviewMaxBytes {
		return errors.New("预览必须为不超过 2 MiB 的 JPEG")
	}
	meta, err := jpeg.DecodeConfig(bytes.NewReader(data))
	if err != nil || meta.Width < 1 || meta.Height < 1 || meta.Width > storagePreviewSide || meta.Height > storagePreviewSide {
		return errors.New("预览必须为最长边不超过 1024 的 JPEG")
	}
	if _, err := jpeg.Decode(bytes.NewReader(data)); err != nil {
		return errors.New("JPEG 预览不完整")
	}
	return nil
}

// A hard link publishes the complete file atomically; first valid write wins.
func writeStoragePreview(id string, data []byte) error {
	name := StoragePreviewPath(id)
	if name == "" {
		return errors.New("预览对象标识无效")
	}
	if err := validateStoragePreview(data); err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		return err
	}
	file, err := os.CreateTemp(filepath.Dir(name), ".preview-*")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	if _, err = file.Write(data); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	if err := os.Link(file.Name(), name); err != nil && !os.IsExist(err) {
		return err
	}
	return nil
}

func encodeStoragePreview(data []byte) ([]byte, error) {
	meta, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	// Bound decoded memory; very large/unsupported images retain original fallback.
	if meta.Width <= 0 || meta.Height <= 0 || int64(meta.Width) > (64<<20)/int64(meta.Height) {
		return nil, errors.New("图片超过服务端预览解码上限")
	}
	source, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return nil, err
	}
	width, height := meta.Width, meta.Height
	if width > storagePreviewSide || height > storagePreviewSide {
		if width >= height {
			height = max(1, height*storagePreviewSide/width)
			width = storagePreviewSide
		} else {
			width = max(1, width*storagePreviewSide/height)
			height = storagePreviewSide
		}
	}
	target := image.NewRGBA(image.Rect(0, 0, width, height))
	draw.Draw(target, target.Bounds(), image.NewUniform(color.White), image.Point{}, draw.Src)
	xdraw.ApproxBiLinear.Scale(target, target.Bounds(), source, source.Bounds(), draw.Over, nil)
	var output bytes.Buffer
	if err := jpeg.Encode(&output, target, &jpeg.Options{Quality: 80}); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

// Delay the fallback after save so a browser holding the original can win.
// Pending work is bounded, and failed lazy reads cool down for one minute.
func QueueStoragePreview(id string, delay time.Duration) {
	if StoragePreviewPath(id) == "" {
		return
	}
	previewQueue.Lock()
	if previewQueue.pending[id] || len(previewQueue.pending) >= 256 || time.Now().Before(previewQueue.failed[id]) {
		previewQueue.Unlock()
		return
	}
	previewQueue.pending[id] = true
	previewQueue.Unlock()
	time.AfterFunc(delay, func() {
		ctx, cancel := context.WithTimeout(context.Background(), 6*time.Minute)
		defer cancel()
		_, err := GenerateStoragePreview(ctx, id)
		previewQueue.Lock()
		delete(previewQueue.pending, id)
		// Keep the cooldown map bounded as well.
		for key, until := range previewQueue.failed {
			if !time.Now().Before(until) {
				delete(previewQueue.failed, key)
			}
		}
		if err != nil && len(previewQueue.failed) < 256 {
			previewQueue.failed[id] = time.Now().Add(time.Minute)
		}
		previewQueue.Unlock()
	})
}

// GenerateStoragePreview writes only a cache file and never updates storage_objects.
func GenerateStoragePreview(ctx context.Context, id string) (int64, error) {
	result := previewBuilds.DoChan(id, func() (any, error) { return generateStoragePreview(ctx, id) })
	select {
	case done := <-result:
		if done.Err != nil {
			return 0, done.Err
		}
		return done.Val.(int64), nil
	case <-ctx.Done():
		return 0, ctx.Err()
	}
}

func generateStoragePreview(ctx context.Context, id string) (int64, error) {
	select {
	case previewWorkers <- struct{}{}:
	case <-ctx.Done():
		return 0, ctx.Err()
	}
	defer func() { <-previewWorkers }()
	object, err := repository.GetStorageObject(id)
	if err != nil {
		return 0, err
	}
	if object.DeletedAt != "" || !strings.HasPrefix(object.MimeType, "image/") {
		return 0, errors.New("对象已删除或不是图片")
	}
	name := StoragePreviewPath(id)
	if name == "" {
		return 0, errors.New("预览对象标识无效")
	}
	if info, err := os.Stat(name); err == nil {
		return info.Size(), nil
	}
	var reader io.ReadCloser
	reader, err = openLocalMedia(object)
	if err != nil {
		download, readErr := DownloadStorageObject(id, "")
		if readErr != nil {
			return 0, readErr
		}
		reader = download.Stream
	}
	defer reader.Close()
	data, err := io.ReadAll(io.LimitReader(reader, storagePreviewSourceLimit+1))
	if err != nil {
		return 0, err
	}
	if len(data) > storagePreviewSourceLimit {
		return 0, errors.New("图片超过服务端预览读取上限")
	}
	if object.Bytes > 0 && object.Bytes != int64(len(data)) {
		return 0, errors.New("原图字节数校验失败")
	}
	if object.SHA256 != "" {
		sum := sha256.Sum256(data)
		if !strings.EqualFold(hex.EncodeToString(sum[:]), object.SHA256) {
			return 0, errors.New("原图 SHA-256 校验失败")
		}
	}
	preview, err := encodeStoragePreview(data)
	if err != nil {
		return 0, err
	}
	if err := ctx.Err(); err != nil {
		return 0, err
	}
	current, err := repository.GetStorageObject(id)
	if err != nil {
		return 0, err
	}
	if current.DeletedAt != "" || current.SHA256 != object.SHA256 {
		return 0, errors.New("生成预览期间原对象已改变")
	}
	if err := writeStoragePreview(id, preview); err != nil {
		return 0, err
	}
	info, err := os.Stat(name)
	if err != nil {
		return 0, err
	}
	return info.Size(), nil
}
