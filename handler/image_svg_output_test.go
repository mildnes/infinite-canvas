package handler

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/service"
)

func TestSVGGenerationRequestConstraints(t *testing.T) {
	channel := model.ModelChannel{Protocol: "openai", BaseURL: "https://aiimg.qzz.io", Models: []string{"gpt-image-2.6-flare"}}
	body := []byte(`{"model":"gpt-image-2.6-flare","output_format":"svg","n":6,"stream":true,"partial_images":3,"output_compression":50,"prompt_rewriter":"x","prompt":"vector"}`)
	normalized, _, _, err := normalizeImageOutputFormatRequest(body, "application/json", channel, "gpt-image-2.6-flare", "/images/generations")
	if err != nil {
		t.Fatal(err)
	}
	var payload map[string]any
	if err := json.Unmarshal(normalized, &payload); err != nil {
		t.Fatal(err)
	}
	if payload["output_format"] != "svg" || payload["n"] != float64(1) {
		t.Fatalf("SVG request actual format=%v n=%v expected=svg/1", payload["output_format"], payload["n"])
	}
	for _, field := range []string{"stream", "partial_images", "output_compression", "prompt_rewriter"} {
		if _, exists := payload[field]; exists {
			t.Errorf("SVG still sends unsupported field %s", field)
		}
	}
	if _, _, _, err := normalizeImageOutputFormatRequest(body, "application/json", channel, "gpt-image-2.6-flare", "/images/edits"); err == nil || !strings.Contains(err.Error(), "仅支持文生图") {
		t.Errorf("SVG edits must fail explicitly: %v", err)
	}
	channel.BaseURL = "https://api-cn.rolldek.com"
	if _, _, _, err := normalizeImageOutputFormatRequest(body, "application/json", channel, "gpt-image-2.6-flare", "/images/generations"); err == nil || !strings.Contains(err.Error(), "当前渠道不支持 SVG") {
		t.Errorf("rolldek SVG must fail explicitly: %v", err)
	}
}

func TestSVGOriginalFileKeepsAttachmentPolicy(t *testing.T) {
	if os.Getenv("IC_SVG_FILE_FIXTURE") != "1" {
		command := exec.Command(os.Args[0], "-test.run=^TestSVGOriginalFileKeepsAttachmentPolicy$", "-test.v")
		command.Env = append(os.Environ(), "IC_SVG_FILE_FIXTURE=1")
		output, err := command.CombinedOutput()
		t.Logf("%s", output)
		if err != nil {
			t.Fatal(err)
		}
		return
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", filepath.Join(t.TempDir(), "svg.db")
	data := []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0h10v10z"/></svg>`)
	saved, err := service.SaveGeneratedMedia("owner", "image/svg+xml", data)
	if err != nil {
		t.Fatal(err)
	}
	for _, endpoint := range []string{"content", "preview"} {
		request := httptest.NewRequest(http.MethodGet, "/api/files/"+saved.ID+"/"+endpoint, nil)
		response := httptest.NewRecorder()
		if endpoint == "preview" {
			FilePreview(response, request, saved.ID)
		} else {
			FileContent(response, request, saved.ID)
		}
		if response.Code != http.StatusOK || !bytes.Equal(response.Body.Bytes(), data) {
			t.Errorf("%s must stream original SVG without rasterizing: code=%d bytes=%d", endpoint, response.Code, response.Body.Len())
		}
		if response.Header().Get("Content-Type") != "application/octet-stream" || response.Header().Get("Content-Disposition") != "attachment" || response.Header().Get("X-Content-Type-Options") != "nosniff" {
			t.Errorf("%s relaxed existing SVG MIME policy: %v", endpoint, response.Header())
		}
	}
	if _, err := service.GenerateStoragePreview(context.Background(), saved.ID); err == nil || !strings.Contains(err.Error(), "SVG") {
		t.Errorf("SVG must skip bitmap preview generation: %v", err)
	}
}
