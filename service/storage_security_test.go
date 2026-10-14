package service

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"gorm.io/gorm"
)

func TestStorageSecurityBoundaries(t *testing.T) {
	if os.Getenv("IC_STORAGE_SECURITY_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestStorageSecurityBoundaries$", "-test.v")
		command.Env = append(os.Environ(), "IC_STORAGE_SECURITY_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("storage security fixture: %v\n%s", err, output)
		}
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "security.db")
	db, err := repository.DB()
	if err != nil {
		t.Fatal(err)
	}
	var mu sync.Mutex
	objects := map[string][]byte{}
	puts := 0
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		defer mu.Unlock()
		switch r.Method {
		case http.MethodPut:
			objects[r.URL.Path], _ = io.ReadAll(r.Body)
			puts++
		case http.MethodDelete:
			delete(objects, r.URL.Path)
		default:
			if data, ok := objects[r.URL.Path]; ok {
				_, _ = w.Write(data)
			} else {
				w.WriteHeader(404)
			}
		}
	}))
	defer upstream.Close()
	// Only this subprocess uses a localhost cloud fixture.
	safeProxyHTTPClient = upstream.Client()
	settings := model.Settings{}
	settings.Private.Storage = model.PrivateStorageSetting{AllowUserGlobalProvider: true, Providers: []model.StorageProvider{{ID: "fixture", Type: model.StorageProviderTypeS3, Enabled: true, Endpoint: upstream.URL, Bucket: "media", AccessKeyID: "fixture", SecretAccessKey: "fixture"}}}
	if _, err := repository.SaveSettings(settings, "now"); err != nil {
		t.Fatal(err)
	}
	ctx := WithUser(context.Background(), model.AuthUser{ID: "owner", Role: model.UserRoleUser})
	t.Run("upload rejects declared and disguised active content before cloud writes", func(t *testing.T) {
		for _, mime := range []string{"text/html", "image/svg+xml", "image/png", "video/unknown", "audio/unknown"} {
			before := puts
			var rowsBefore, rowsAfter int64
			db.Model(&model.StorageObject{}).Count(&rowsBefore)
			_, err := UploadStorageObject(ctx, "unsafe.png", mime, []byte("<html>unsafe</html>"))
			db.Model(&model.StorageObject{}).Count(&rowsAfter)
			if err == nil || puts != before || rowsBefore != rowsAfter {
				t.Errorf("unsafe upload accepted mime=%s err=%v cloud_writes=%d rows=%d", mime, err, puts-before, rowsAfter-rowsBefore)
			}
		}
	})
	t.Run("detected PNG is accepted and deduplicated", func(t *testing.T) {
		var data bytes.Buffer
		_ = png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 2, 2)))
		first, err := UploadStorageObject(ctx, "image.png", "", data.Bytes())
		if err != nil || first.MimeType != "image/png" {
			t.Fatalf("detected PNG: %+v %v", first, err)
		}
		second, err := UploadStorageObject(ctx, "same.png", "image/png", data.Bytes())
		if err != nil || second.ID != first.ID {
			t.Fatalf("PNG dedup: %+v %v", second, err)
		}
	})
	t.Run("upload never reuses a legacy unsafe MIME index", func(t *testing.T) {
		var data bytes.Buffer
		_ = png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 4, 4)))
		sum := sha256.Sum256(data.Bytes())
		_, err := repository.SaveStorageObject(model.StorageObject{
			ID: "unsafe-mime-index", ObjectKey: "unsafe-mime-index.png", MimeType: "image/svg+xml", CreatedBy: "owner",
			SHA256: hex.EncodeToString(sum[:]), Bytes: int64(data.Len()), CloudSyncStatus: "verified",
		})
		if err != nil {
			t.Fatal(err)
		}
		uploaded, err := UploadStorageObject(ctx, "safe.png", "image/png", data.Bytes())
		if err != nil || uploaded.ID == "unsafe-mime-index" || uploaded.MimeType != "image/png" {
			t.Fatalf("unsafe legacy MIME reused: %+v %v", uploaded, err)
		}
	})
	object := model.StorageObject{ID: "metadata", ObjectKey: "private/object.png", ProviderID: "fixture", Bucket: "secret", MimeType: "image/png", SourceURL: "https://private.example/source?secret=yes", SHA256: "private-hash", CreatedBy: "owner", PublicURL: "https://media.example/image.png"}
	if _, err := repository.SaveStorageObject(object); err != nil {
		t.Fatal(err)
	}
	t.Run("public metadata omits infrastructure and source", func(t *testing.T) {
		info, err := StorageObjectInfo(object.ID)
		if err != nil {
			t.Fatal(err)
		}
		raw, _ := json.Marshal(info)
		for _, field := range []string{"objectKey", "providerId", "bucket", "sourceUrl", "sha256", "createdBy", "cloudTarget"} {
			if strings.Contains(string(raw), field) {
				t.Errorf("public metadata leaks %s: %s", field, raw)
			}
		}
	})
	t.Run("only owner and admin receive the WebDAV object key", func(t *testing.T) {
		for _, sample := range []struct {
			user    model.AuthUser
			allowed bool
		}{
			{model.AuthUser{ID: "owner", Role: model.UserRoleUser}, true},
			{model.AuthUser{ID: "other", Role: model.UserRoleUser}, false},
			{model.AuthUser{ID: "admin", Role: model.UserRoleAdmin}, true},
		} {
			info, err := StorageObjectInfo(object.ID, WithUser(context.Background(), sample.user))
			if err != nil || (info.ObjectKey != "") != sample.allowed {
				t.Errorf("metadata ownership: %+v %v", info, err)
			}
		}
	})
	t.Run("direct registration rejects HTML even under an image MIME", func(t *testing.T) {
		settings.Private.Storage.AllowUserProvider = true
		_, _ = repository.SaveSettings(settings, "now")
		objects["/direct/owner/disguised.png"] = []byte("<html>unsafe</html>")
		_, err := RegisterDirectStorageObject(ctx, DirectStorageObjectInput{
			Provider:  StorageObjectProviderInput{Type: "webdav", Endpoint: upstream.URL, Username: "fixture", Password: "fixture", PathPrefix: "direct"},
			ObjectKey: "direct/owner/disguised.png", MimeType: "image/png", Bytes: int64(len(objects["/direct/owner/disguised.png"])),
		})
		if err == nil {
			t.Fatal("direct registration accepted disguised HTML")
		}
	})
	t.Run("anonymous own-provider upload keeps sentinel without dedup or global access", func(t *testing.T) {
		guest := WithUser(context.Background(), model.AuthUser{ID: "anonymous-session", Role: model.UserRoleGuest})
		if err := AuthorizeStorageUpload(guest, nil); err == nil {
			t.Fatal("guest acquired global cloud access")
		}
		provider := &StorageObjectProviderInput{Type: "s3", Endpoint: upstream.URL, Bucket: "media", AccessKeyID: "fixture", SecretAccessKey: "fixture"}
		var data bytes.Buffer
		_ = png.Encode(&data, image.NewNRGBA(image.Rect(0, 0, 3, 3)))
		first, err := UploadStorageObjectWithProvider(guest, "guest.png", "image/png", data.Bytes(), provider)
		if err != nil {
			t.Fatal(err)
		}
		second, err := UploadStorageObjectWithProvider(guest, "guest.png", "image/png", data.Bytes(), provider)
		if err != nil || first.ID == second.ID {
			t.Fatalf("anonymous dedup crossed sessions: %+v %+v %v", first, second, err)
		}
		object, err := repository.GetStorageObject(first.ID)
		if err != nil || object.CreatedBy != "anonymous" || !anonymousStorageOwner(object.CreatedBy) {
			t.Fatalf("anonymous sentinel changed: %+v %v", object, err)
		}
		if err := DeleteStorageObject(guest, first.ID, provider); err == nil || err.Error() != "无权删除该对象" {
			t.Fatalf("legacy anonymous ownership guessed from cookie: %v", err)
		}
	})
	t.Run("deleted metadata and content are missing", func(t *testing.T) {
		deleted := object
		deleted.ID, deleted.ObjectKey, deleted.DeletedAt = "deleted", "deleted.png", "deleted"
		_, _ = repository.SaveStorageObject(deleted)
		if _, err := StorageObjectInfo(deleted.ID); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Errorf("deleted info: %v", err)
		}
		if _, err := DownloadStorageObject(deleted.ID, ""); !errors.Is(err, gorm.ErrRecordNotFound) {
			t.Errorf("deleted content: %v", err)
		}
	})
	t.Run("deletion fails closed", func(t *testing.T) {
		if err := DeleteStorageObject(context.Background(), "missing", nil); err == nil {
			t.Error("missing object bypassed deletion authentication")
		}
		for _, sample := range []struct {
			name, owner string
			ctx         context.Context
		}{
			{"unauthenticated", "owner", context.Background()},
			{"empty-owner", "", ctx},
			{"foreign", "other", ctx},
			{"legacy-anonymous", "anonymous", WithUser(context.Background(), model.AuthUser{ID: "anonymous-session", Role: model.UserRoleGuest})},
		} {
			item := model.StorageObject{ID: sample.name, ObjectKey: sample.name, CreatedBy: sample.owner}
			_, _ = repository.SaveStorageObject(item)
			if err := DeleteStorageObject(sample.ctx, item.ID, nil); err == nil || err.Error() != "无权删除该对象" {
				t.Errorf("%s deletion: %v", sample.name, err)
			}
		}
	})
}
