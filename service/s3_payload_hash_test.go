package service

import (
	"bytes"
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
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
)

// This verifier deliberately does not call the production signing helpers.
func batch2S3Digest(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func batch2S3Authorization(request *http.Request, provider model.StorageProvider, payloadHash string) string {
	date := request.Header.Get("X-Amz-Date")
	scope := date[:8] + "/" + provider.Region + "/s3/aws4_request"
	headers := "host:" + request.Host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + date + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonical := strings.Join([]string{request.Method, request.URL.EscapedPath(), request.URL.RawQuery, headers, signedHeaders, payloadHash}, "\n")
	key := []byte("AWS4" + provider.SecretAccessKey)
	for _, value := range []string{date[:8], provider.Region, "s3", "aws4_request", "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + batch2S3Digest([]byte(canonical))} {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(value))
		key = mac.Sum(nil)
	}
	return "AWS4-HMAC-SHA256 Credential=" + provider.AccessKeyID + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + hex.EncodeToString(key)
}

type batch2S3Request struct {
	method, path, hash, authorization string
	body                              []byte
	request                           *http.Request
}

type batch2S3Transport struct {
	base  http.RoundTripper
	alter func(*http.Request)
}

func (transport batch2S3Transport) RoundTrip(request *http.Request) (*http.Response, error) {
	request = request.Clone(request.Context())
	transport.alter(request)
	return transport.base.RoundTrip(request)
}

func TestBatch2S3PayloadSigning(t *testing.T) {
	if os.Getenv("IC_BATCH2_S3_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestBatch2S3PayloadSigning$", "-test.v")
		command.Env = append(os.Environ(), "IC_BATCH2_S3_FIXTURE=1")
		if output, err := command.CombinedOutput(); err != nil {
			t.Fatalf("S3 payload fixture: %v\n%s", err, output)
		} else {
			t.Logf("%s", output)
		}
		return
	}
	t.Setenv("S3_UNSIGNED_PAYLOAD", "")
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "s3.db")
	if _, err := repository.DB(); err != nil {
		t.Fatal(err)
	}
	var imageBytes bytes.Buffer
	if err := png.Encode(&imageBytes, image.NewNRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	data := imageBytes.Bytes()
	digest := batch2S3Digest(data)
	provider := model.StorageProvider{ID: "s3-fixture", Type: model.StorageProviderTypeS3, Enabled: true, Bucket: "media", Region: "test-region", AccessKeyID: "fixture-key", SecretAccessKey: "fixture-secret"}
	var mu sync.Mutex
	var requests []batch2S3Request
	objects := map[string][]byte{}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, err := io.ReadAll(request.Body)
		if err != nil {
			http.Error(w, err.Error(), http.StatusBadRequest)
			return
		}
		mu.Lock()
		defer mu.Unlock()
		hash := request.Header.Get("X-Amz-Content-Sha256")
		requests = append(requests, batch2S3Request{request.Method, request.URL.Path, hash, request.Header.Get("Authorization"), body, request.Clone(request.Context())})
		if len(request.Header.Get("X-Amz-Date")) != 16 || request.Header.Get("Authorization") != batch2S3Authorization(request, provider, hash) {
			http.Error(w, "SignatureDoesNotMatch", http.StatusForbidden)
			return
		}
		if request.Method == http.MethodPut && hash != "UNSIGNED-PAYLOAD" && hash != batch2S3Digest(body) {
			http.Error(w, "SignatureDoesNotMatch: payload SHA-256 mismatch", http.StatusForbidden)
			return
		}
		switch request.Method {
		case http.MethodPut:
			if strings.HasSuffix(request.URL.Path, "/unsigned-only.png") && hash != "UNSIGNED-PAYLOAD" {
				http.Error(w, "signed payload not supported", http.StatusBadRequest)
				return
			}
			if strings.HasSuffix(request.URL.Path, "/rejected.png") {
				http.Error(w, "fixture upload unavailable", http.StatusServiceUnavailable)
				return
			}
			objects[request.URL.Path] = append([]byte(nil), body...)
			w.WriteHeader(http.StatusCreated)
		case http.MethodDelete:
			delete(objects, request.URL.Path)
			w.WriteHeader(http.StatusNoContent)
		default:
			if payload, ok := objects[request.URL.Path]; ok {
				_, _ = w.Write(payload)
			} else {
				w.WriteHeader(http.StatusNotFound)
			}
		}
	}))
	defer server.Close()
	provider.Endpoint = server.URL
	safeProxyHTTPClient = server.Client() // Local mock only, in this isolated subprocess.
	lastPut := func(t *testing.T) batch2S3Request {
		t.Helper()
		mu.Lock()
		defer mu.Unlock()
		for index := len(requests) - 1; index >= 0; index-- {
			if requests[index].method == http.MethodPut {
				return requests[index]
			}
		}
		t.Fatal("mock received no PUT")
		return batch2S3Request{}
	}

	t.Run("PUT uses real file SHA256 and preserves object path and bytes", func(t *testing.T) {
		if err := putS3Object(provider, "canvas/owner/image.png", "image/png", data); err != nil {
			t.Fatal(err)
		}
		got := lastPut(t)
		if got.hash != digest {
			t.Errorf("PUT payload hash actual=%q expected=%q", got.hash, digest)
		}
		if got.path != "/media/canvas/owner/image.png" || !bytes.Equal(got.body, data) {
			t.Fatal("S3 object path or file bytes changed")
		}
	})
	t.Run("canonical request signs exactly the real digest declared in header", func(t *testing.T) {
		if err := putS3Object(provider, "canonical.png", "image/png", data); err != nil {
			t.Fatal(err)
		}
		got := lastPut(t)
		expected := batch2S3Authorization(got.request, provider, digest)
		if got.authorization != expected {
			t.Errorf("canonical payload uses actual=%q expected=%q; authorization differs from independent SigV4 verifier", got.hash, digest)
		}
	})
	t.Run("tampered body is rejected before cloud accepts it", func(t *testing.T) {
		original := safeProxyHTTPClient
		client := *server.Client()
		client.Transport = batch2S3Transport{server.Client().Transport, func(request *http.Request) {
			if request.Method == http.MethodPut {
				corrupted := append([]byte(nil), data...)
				corrupted[len(corrupted)-1] ^= 1
				_ = request.Body.Close()
				request.Body = io.NopCloser(bytes.NewReader(corrupted))
			}
		}}
		safeProxyHTTPClient = &client
		t.Cleanup(func() { safeProxyHTTPClient = original })
		err := putS3Object(provider, "tampered.png", "image/png", data)
		if err == nil || !strings.Contains(err.Error(), "SHA-256 mismatch") {
			t.Errorf("tampered PUT actual error=%v expected=explicit payload SHA-256 rejection", err)
		}
		t.Logf("tampered PUT rejection: %v", err)
		mu.Lock()
		_, stored := objects["/media/tampered.png"]
		mu.Unlock()
		if stored {
			t.Error("tampered object was accepted by mock S3")
		}
	})
	t.Run("changing the declared digest without resigning is rejected", func(t *testing.T) {
		original := safeProxyHTTPClient
		client := *server.Client()
		client.Transport = batch2S3Transport{server.Client().Transport, func(request *http.Request) {
			request.Header.Set("X-Amz-Content-Sha256", strings.Repeat("0", 64))
		}}
		safeProxyHTTPClient = &client
		t.Cleanup(func() { safeProxyHTTPClient = original })
		err := putS3Object(provider, "tampered-header.png", "image/png", data)
		if err == nil || !strings.Contains(err.Error(), "SignatureDoesNotMatch") {
			t.Fatalf("unsigned header mutation was accepted: %v", err)
		}
	})
	t.Run("explicit fallback is unsigned and false restores signed uploads", func(t *testing.T) {
		for _, value := range []string{"true", "false"} {
			t.Setenv("S3_UNSIGNED_PAYLOAD", value)
			if err := putS3Object(provider, "fallback.png", "image/png", data); err != nil {
				t.Fatal(err)
			}
			want := digest
			if value == "true" {
				want = "UNSIGNED-PAYLOAD"
			}
			if got := lastPut(t).hash; got != want {
				t.Errorf("S3_UNSIGNED_PAYLOAD=%s actual=%q expected=%q", value, got, want)
			}
		}
	})
	t.Run("unsigned-only provider requires explicitly enabling compatibility", func(t *testing.T) {
		t.Setenv("S3_UNSIGNED_PAYLOAD", "false")
		err := putS3Object(provider, "unsigned-only.png", "image/png", data)
		if err == nil || !strings.Contains(err.Error(), "signed payload not supported") {
			t.Errorf("default signed upload actual error=%v expected=explicit compatibility rejection", err)
		}
		t.Setenv("S3_UNSIGNED_PAYLOAD", "true")
		if err := putS3Object(provider, "unsigned-only.png", "image/png", data); err != nil {
			t.Fatal(err)
		}
		if got := lastPut(t).hash; got != "UNSIGNED-PAYLOAD" {
			t.Errorf("compatibility PUT actual=%q expected=UNSIGNED-PAYLOAD", got)
		}
	})
	t.Run("bodyless GET DELETE HEAD remain unsigned in both modes", func(t *testing.T) {
		for _, value := range []string{"false", "true"} {
			t.Setenv("S3_UNSIGNED_PAYLOAD", value)
			for _, method := range []string{http.MethodGet, http.MethodDelete, http.MethodHead} {
				request, err := newS3Request(method, provider, "read.png", nil, 0)
				if err != nil {
					t.Fatal(err)
				}
				request.Host = request.URL.Host
				if request.Header.Get("X-Amz-Content-Sha256") != "UNSIGNED-PAYLOAD" || request.Header.Get("Authorization") != batch2S3Authorization(request, provider, "UNSIGNED-PAYLOAD") {
					t.Fatalf("%s changed its unsigned signature in fallback=%s", method, value)
				}
			}
		}
	})
	t.Run("stored SHA256 equals PUT hash and remains real in fallback mode", func(t *testing.T) {
		for _, value := range []string{"false", "true"} {
			t.Setenv("S3_UNSIGNED_PAYLOAD", value)
			ctx := WithUser(context.Background(), model.AuthUser{ID: "owner-" + value, Role: model.UserRoleUser})
			result, err := uploadStorageObject(ctx, "upload.png", "image/png", data, provider)
			if err != nil {
				t.Fatal(err)
			}
			stored, err := repository.GetStorageObject(result.ID)
			if err != nil {
				t.Fatal(err)
			}
			wantHeader := digest
			if value == "true" {
				wantHeader = "UNSIGNED-PAYLOAD"
			}
			got := lastPut(t)
			if stored.SHA256 != digest || got.hash != wantHeader || batch2S3Digest(got.body) != stored.SHA256 || stored.ObjectKey != strings.TrimPrefix(got.path, "/media/") {
				t.Errorf("metadata SHA256=%q PUT hash=%q expected=%q fallback=%s", stored.SHA256, got.hash, wantHeader, value)
			}
		}
	})
	t.Run("local file cloud sync also signs its already verified SHA256", func(t *testing.T) {
		if err := os.MkdirAll(GeneratedMediaDir(), 0700); err != nil {
			t.Fatal(err)
		}
		source := model.StorageObject{ID: "local-file", MimeType: "image/png", Bytes: int64(len(data)), SHA256: digest}
		if err := os.WriteFile(localMediaPath(source), data, 0600); err != nil {
			t.Fatal(err)
		}
		target := source
		target.Bucket, target.ObjectKey = provider.Bucket, "canvas/owner/local-file.png"
		for _, value := range []string{"false", "true"} {
			t.Setenv("S3_UNSIGNED_PAYLOAD", value)
			if err := uploadLocalMedia(context.Background(), source, target, provider); err != nil {
				t.Fatal(err)
			}
			want := digest
			if value == "true" {
				want = "UNSIGNED-PAYLOAD"
			}
			if got := lastPut(t); got.hash != want || !bytes.Equal(got.body, data) {
				t.Errorf("file sync PUT hash actual=%q expected=%q fallback=%s", got.hash, want, value)
			}
		}
	})
	t.Run("upload rejection stays explicit with no automatic unsigned retry", func(t *testing.T) {
		mu.Lock()
		before := len(requests)
		mu.Unlock()
		err := putS3Object(provider, "rejected.png", "image/png", data)
		if err == nil || !strings.Contains(err.Error(), "503") {
			t.Fatalf("S3 rejection hidden: %v", err)
		}
		mu.Lock()
		defer mu.Unlock()
		if len(requests)-before != 1 {
			t.Fatal("failed signed PUT was silently retried")
		}
	})
}
