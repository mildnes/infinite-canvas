package handler

import "testing"

func TestIsReusableCanvasImageTaskStatus(t *testing.T) {
	for _, status := range []string{"queued", "processing", "running", "in_progress", "completed", "success", "succeeded", " PROCESSING "} {
		if !isReusableCanvasImageTaskStatus(status) {
			t.Errorf("status %q should remain idempotent", status)
		}
	}
	for _, status := range []string{"failed", "error", "cancelled", ""} {
		if isReusableCanvasImageTaskStatus(status) {
			t.Errorf("status %q should allow a new retry task", status)
		}
	}
}
