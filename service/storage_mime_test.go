package service

import (
	"context"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func TestUploadedMediaMIMEPolicyDetectsContainers(t *testing.T) {
	ftyp := func(brand string) []byte { return []byte("\x00\x00\x00\x18ftyp" + brand + "\x00\x00\x00\x00isom") }
	for _, sample := range []struct {
		mime string
		data []byte
	}{
		{"video/mp4", ftyp("isom")},
		{"video/quicktime", ftyp("qt  ")},
		{"video/3gpp", ftyp("3gp4")},
		{"video/3gpp2", ftyp("3g2a")},
		{"video/webm", []byte("\x1a\x45\xdf\xa3\x42\x82\x84webm")},
		{"video/x-matroska", []byte("\x1a\x45\xdf\xa3\x42\x82\x88matroska")},
		{"video/mpeg", []byte{0, 0, 1, 0xb3, 1}},
		{"audio/mpeg", []byte("ID3\x03\x00\x00\x00\x00\x00\x00")},
		{"audio/wav", []byte("RIFF\x00\x00\x00\x00WAVEfmt ")},
		{"audio/aiff", []byte("FORM\x00\x00\x00\x00AIFFCOMM")},
		{"audio/flac", []byte("fLaC\x00\x00\x00\x22")},
		{"audio/aac", []byte{0xff, 0xf1, 0x50, 0x80}},
		{"image/avif", ftyp("avif")},
	} {
		got, err := NormalizeUploadedMIME(sample.mime, sample.data)
		if err != nil || got != sample.mime {
			t.Errorf("%s detection: %s %v", sample.mime, got, err)
		}
	}
	for _, mime := range []string{"text/html", "application/json", "application/xml", "image/svg+xml", "video/unknown", "audio/unknown"} {
		if IsSupportedUploadedMIME(mime) {
			t.Errorf("unsupported MIME admitted: %s", mime)
		}
	}
}

func TestImageProxySourceAuthorizationIsIndependentAndExact(t *testing.T) {
	previous := config.Cfg.ImageProxyAllowedHosts
	t.Cleanup(func() { config.Cfg.ImageProxyAllowedHosts = previous })
	config.Cfg.ImageProxyAllowedHosts = "images.example, cdn.example:8443"
	for _, raw := range []string{"https://images.example/a.png", "https://cdn.example:8443/a.png"} {
		if err := AuthorizeImageProxySource(raw); err != nil {
			t.Error(err)
		}
	}
	for _, raw := range []string{"https://images.example.evil/a.png", "https://cdn.example/a.png", "https://user:password@images.example/a.png", "ftp://images.example/a.png"} {
		if err := AuthorizeImageProxySource(raw); err == nil {
			t.Errorf("unapproved source admitted: %s", raw)
		}
	}
}

func TestStorageDeletionRequiresExplicitAdminOrRealOwner(t *testing.T) {
	object := model.StorageObject{ID: "object", CreatedBy: "owner"}
	for _, sample := range []struct {
		user           model.AuthUser
		admin, allowed bool
	}{
		{model.AuthUser{ID: "owner", Role: model.UserRoleUser}, false, true},
		{model.AuthUser{ID: "other", Role: model.UserRoleUser}, false, false},
		{model.AuthUser{ID: "admin", Role: model.UserRoleAdmin}, false, false},
		{model.AuthUser{ID: "admin", Role: model.UserRoleAdmin}, true, true},
		{model.AuthUser{ID: "owner", Role: model.UserRoleUser}, true, false},
		{model.AuthUser{ID: "anonymous-session", Role: model.UserRoleGuest}, false, false},
	} {
		err := authorizeStorageObjectDeletion(WithUser(context.Background(), sample.user), object, sample.admin)
		if (err == nil) != sample.allowed {
			t.Errorf("role=%s admin=%v allowed=%v err=%v", sample.user.Role, sample.admin, sample.allowed, err)
		}
	}
	if authorizeStorageObjectDeletion(context.Background(), object, false) == nil {
		t.Fatal("missing authentication accepted")
	}
}
