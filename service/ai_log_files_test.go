package service

import (
	"errors"
	"io/fs"
	"os"
	"path/filepath"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestAICallLogFilesMissingDirectoryIsEmpty(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = filepath.Join(t.TempDir(), "missing")
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	files, err := aiLogFiles()
	if err != nil {
		t.Fatalf("missing log directory error = %v", err)
	}
	if len(files) != 0 {
		t.Fatalf("missing log directory files = %v, want none", files)
	}
}

func TestAICallLogFilesNonDirectoryReturnsError(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	path := filepath.Join(t.TempDir(), "ai-logs-file")
	if err := os.WriteFile(path, []byte("not a directory"), 0o644); err != nil {
		t.Fatal(err)
	}
	config.Cfg.AILogDir = path
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	files, err := aiLogFiles()
	if err == nil {
		t.Fatalf("non-directory log path returned files=%v without an error", files)
	}
	if !errors.Is(err, fs.ErrInvalid) && !errors.Is(err, os.ErrInvalid) {
		t.Logf("non-directory log path returned platform error: %v", err)
	}
}
