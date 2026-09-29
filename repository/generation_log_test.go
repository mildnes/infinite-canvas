package repository

import "testing"

func TestGenerationLogStatusIsTerminal(t *testing.T) {
	for _, status := range []string{"成功", "失败", "success", "completed", "failed", "error", "cancelled"} {
		if !generationLogStatusIsTerminal(status) {
			t.Fatalf("expected %q to be terminal", status)
		}
	}
	for _, status := range []string{"", "生成中", "queued", "processing", "running"} {
		if generationLogStatusIsTerminal(status) {
			t.Fatalf("expected %q to be non-terminal", status)
		}
	}
}
