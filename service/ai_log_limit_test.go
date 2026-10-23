package service

import (
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestSaveAICallLogPreserves256KiBRequestBody(t *testing.T) {
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = t.TempDir()
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})

	requestBody := strings.Repeat("x", 256*1024)
	SaveAICallLog(AICallLogInput{
		UserID:      "user",
		Endpoint:    "/v1/responses",
		RequestBody: requestBody,
	})

	files, err := aiLogFiles()
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 1 {
		t.Fatalf("log file count = %d, want 1", len(files))
	}
	items, err := readAICallLogFile(files[0])
	if err != nil {
		t.Fatal(err)
	}
	if len(items) != 1 {
		t.Fatalf("log count = %d, want 1", len(items))
	}
	if got, want := len(items[0].RequestBody), len(requestBody); got != want {
		t.Fatalf("request body length = %d, want %d", got, want)
	}
	if items[0].RequestBody != requestBody {
		t.Fatal("saved request body differs from input")
	}
}
