package service

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func mediaTestObject(data string) model.StorageObject {
	sum := sha256.Sum256([]byte(data))
	return model.StorageObject{ID: "object", CreatedBy: "owner", ProviderID: "cloud", ObjectKey: "canvas/owner/object.png", MimeType: "image/png", Bytes: int64(len(data)), SHA256: hex.EncodeToString(sum[:])}
}

func TestMediaVerifyThreeMissingCopyRepairs(t *testing.T) {
	for _, test := range []struct {
		name                       string
		localMissing, cloudMissing bool
		source                     string
	}{
		{"local", true, false, "own_cloud"}, {"cloud", false, true, ""}, {"both", true, true, "sibling_local"},
	} {
		t.Run(test.name, func(t *testing.T) {
			object := mediaTestObject("bytes")
			recovered, uploaded, finished := 0, 0, 0
			report := verifyStorageMedia(object, MediaVerifyOptions{Apply: true, WritesStopped: true}, mediaVerifyIO{
				local: func(model.StorageObject) (int64, string, error) {
					if test.localMissing {
						return 0, "", mediaIssue("missing", "无本地副本")
					}
					return object.Bytes, object.SHA256, nil
				},
				cloud: func(model.StorageObject) (int64, string, error) {
					if test.cloudMissing {
						return 0, "", mediaHTTPError(404)
					}
					return object.Bytes, object.SHA256, nil
				},
				recoverLocal: func(model.StorageObject, bool) (string, string, error) { recovered++; return test.source, "donor", nil },
				sync:         func() error { uploaded++; return nil },
				finish:       func(MediaVerifyReport) error { finished++; return nil },
			})
			if report.Status != "repaired" || report.LocalStatus != "ok" || report.CloudStatus != "ok" || finished != 1 {
				t.Fatalf("unexpected result: %+v", report)
			}
			if (recovered == 1) != test.localMissing || (uploaded == 1) != test.cloudMissing {
				t.Fatalf("unexpected repair calls: recovered=%d uploaded=%d", recovered, uploaded)
			}
			if test.localMissing && report.Source != test.source {
				t.Fatal("must identify the recovery source")
			}
		})
	}
}

func TestMediaVerifyDryRunNeverCallsWrites(t *testing.T) {
	object := mediaTestObject("bytes")
	report := verifyStorageMedia(object, MediaVerifyOptions{}, mediaVerifyIO{
		local: func(model.StorageObject) (int64, string, error) {
			return 0, "", mediaIssue("missing", "无本地副本")
		},
		cloud: func(model.StorageObject) (int64, string, error) { return 0, "", mediaHTTPError(404) },
		recoverLocal: func(_ model.StorageObject, apply bool) (string, string, error) {
			if apply {
				t.Fatal("dry-run tried restoring a file")
			}
			return "sibling_local", "donor", nil
		},
		sync:   func() error { t.Fatal("dry-run tried PUT"); return nil },
		finish: func(MediaVerifyReport) error { t.Fatal("dry-run tried updating DB"); return nil },
	})
	if report.Status != "planned" || len(report.CompletedActions) != 0 || len(report.PlannedActions) != 2 || report.BeforeLocalStatus != "missing" || report.BeforeCloudStatus != "missing" {
		t.Fatalf("wrong dry-run evidence: %+v", report)
	}
}

func TestMediaVerifyDoesNotOverwriteCorruptionOrInaccessibleCloud(t *testing.T) {
	object := mediaTestObject("bytes")
	for _, test := range []struct{ localErr, cloudErr error }{
		{nil, mediaHTTPError(403)}, {nil, mediaHTTPError(500)}, {nil, mediaIssue("mismatch", "冲突云文件")}, {mediaIssue("mismatch", "冲突本地文件"), nil},
	} {
		report := verifyStorageMedia(object, MediaVerifyOptions{Apply: true, WritesStopped: true}, mediaVerifyIO{
			local: func(model.StorageObject) (int64, string, error) { return object.Bytes, object.SHA256, test.localErr },
			cloud: func(model.StorageObject) (int64, string, error) { return object.Bytes, object.SHA256, test.cloudErr },
			recoverLocal: func(model.StorageObject, bool) (string, string, error) {
				t.Fatal("must not overwrite conflicting local file")
				return "", "", nil
			},
			sync:   func() error { t.Fatal("must not overwrite conflicting/unreachable cloud file"); return nil },
			finish: func(MediaVerifyReport) error { return nil },
		})
		if report.Status != "failed" {
			t.Fatalf("must distinguish failed verification: %+v", report)
		}
	}
}

func TestMediaVerifyRetainsDeliberatelyRemovedCopy(t *testing.T) {
	object := mediaTestObject("bytes")
	object.LocalCopyRemovedAt = "old"
	report := verifyStorageMedia(object, MediaVerifyOptions{Apply: true, WritesStopped: true}, mediaVerifyIO{
		local: func(model.StorageObject) (int64, string, error) { return 0, "", mediaIssue("missing", "无副本") },
		cloud: func(model.StorageObject) (int64, string, error) { return object.Bytes, object.SHA256, nil },
		recoverLocal: func(model.StorageObject, bool) (string, string, error) {
			t.Fatal("must preserve deliberate cleanup")
			return "", "", nil
		},
		finish: func(MediaVerifyReport) error { return nil },
	})
	if report.Status != "verified" || report.LocalStatus != "intentionally_removed" {
		t.Fatalf("unexpected cleanup handling: %+v", report)
	}
}

func TestMediaVerifyRejectsUnprovedDeletedAndUnconfirmedApply(t *testing.T) {
	object := mediaTestObject("bytes")
	for _, test := range []struct {
		object  model.StorageObject
		options MediaVerifyOptions
	}{
		{object, MediaVerifyOptions{Apply: true}}, {model.StorageObject{ID: "deleted", DeletedAt: "old"}, MediaVerifyOptions{}}, {model.StorageObject{ID: "unproved", Bytes: 10}, MediaVerifyOptions{}},
	} {
		report := verifyStorageMedia(test.object, test.options, mediaVerifyIO{})
		if report.Status != "failed" && report.Status != "skipped" {
			t.Fatalf("invalid input was accepted: %+v", report)
		}
	}
}

func TestVerifiedMediaCopyRejectsWrongDonorAndExcessBytes(t *testing.T) {
	object := mediaTestObject("bytes")
	for _, data := range []string{"bad!!", "byte", "bytesextra"} {
		if _, _, err := copyVerifiedMedia(object, io.Discard, strings.NewReader(data)); mediaErrorKind(err) != "mismatch" {
			t.Fatalf("wrong donor accepted: %q: %v", data, err)
		}
	}
	if _, _, err := copyVerifiedMedia(object, io.Discard, strings.NewReader("bytes")); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreLocalMediaAtomicAndNoOverwrite(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "test.db")
	t.Cleanup(func() { config.Cfg = previous })
	object := mediaTestObject("bytes")
	if err := restoreLocalMedia(object, strings.NewReader("bytes")); err != nil {
		t.Fatal(err)
	}
	if err := verifyLocalMedia(object); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(localMediaPath(object), []byte("other"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := restoreLocalMedia(object, strings.NewReader("bytes")); mediaErrorKind(err) != "mismatch" {
		t.Fatalf("conflict should be preserved: %v", err)
	}
	data, err := os.ReadFile(localMediaPath(object))
	if err != nil || string(data) != "other" {
		t.Fatal("conflicting file was overwritten")
	}
	entries, err := os.ReadDir(GeneratedMediaDir())
	if err != nil || len(entries) != 1 {
		t.Fatalf("temporary files leaked: %v %v", entries, err)
	}
}

type mediaTestTransport func(*http.Request) (*http.Response, error)

func (transport mediaTestTransport) RoundTrip(request *http.Request) (*http.Response, error) {
	return transport(request)
}

func TestExactCloudVerificationCannotUseHealthyLocalFallback(t *testing.T) {
	previousConfig, previousClient := config.Cfg, safeProxyHTTPClient
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "test.db")
	t.Cleanup(func() { config.Cfg, safeProxyHTTPClient = previousConfig, previousClient })
	object := mediaTestObject("bytes")
	object.Bucket = "media"
	if err := restoreLocalMedia(object, strings.NewReader("bytes")); err != nil {
		t.Fatal(err)
	}
	provider := model.StorageProvider{ID: object.ProviderID, Type: model.StorageProviderTypeS3, Enabled: true, Endpoint: "https://storage.example", Bucket: object.Bucket, Region: "auto", AccessKeyID: "test", SecretAccessKey: "test"}
	for _, test := range []struct {
		status         int
		body, expected string
	}{
		{404, "", "missing"}, {403, "", "blocked"}, {200, "bad!!", "mismatch"}, {200, "bytes", "ok"},
	} {
		safeProxyHTTPClient = &http.Client{Transport: mediaTestTransport(func(request *http.Request) (*http.Response, error) {
			if request.Method != http.MethodGet || request.Header.Get("Range") != "" || !strings.HasSuffix(request.URL.Path, object.ObjectKey) {
				t.Fatalf("verification must GET the full indexed object: %s", request.URL.Path)
			}
			return &http.Response{StatusCode: test.status, Header: http.Header{}, Body: io.NopCloser(strings.NewReader(test.body))}, nil
		})}
		if err := verifyExactCloudMedia(context.Background(), object, provider); mediaErrorKind(err) != test.expected {
			t.Fatalf("healthy local data masked cloud %d: %v", test.status, err)
		}
	}
}

func TestMediaRecoveryPreservesImageVideoAndAudioBytes(t *testing.T) {
	previous := config.Cfg
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "test.db")
	t.Cleanup(func() { config.Cfg = previous })
	for _, test := range []struct{ id, mime, extension, data string }{
		{"png", "image/png", ".png", "\x89PNG\r\n\x1a\n"},
		{"jpeg", "image/jpeg", ".jpg", "\xff\xd8\xff\xe0"},
		{"video", "video/mp4", ".mp4", "\x00\x00\x00\x18ftypmp42"},
		{"audio", "audio/wav", ".wav", "RIFF\x04\x00\x00\x00WAVE"},
	} {
		object := mediaTestObject(test.data)
		object.ID, object.MimeType = test.id, test.mime
		if err := restoreLocalMedia(object, strings.NewReader(test.data)); err != nil {
			t.Fatal(err)
		}
		data, err := os.ReadFile(filepath.Join(GeneratedMediaDir(), test.id+test.extension))
		if err != nil || string(data) != test.data || verifyLocalMedia(object) != nil {
			t.Fatalf("%s recovery changed bytes or MIME extension: %v", test.mime, err)
		}
	}
}
