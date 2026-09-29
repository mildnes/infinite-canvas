package service

import (
	"testing"
	"time"
)

func TestGenerationTaskStartedBefore(t *testing.T) {
	current := time.Date(2026, 9, 29, 12, 0, 0, 0, time.FixedZone("CST", 8*60*60))
	cutoff := current.Add(-GenerationTaskTimeout)
	tests := []struct {
		name      string
		startedAt string
		createdAt string
		want      bool
	}{
		{name: "older UTC timestamp", startedAt: "2026-09-29T03:29:59Z", want: true},
		{name: "boundary", startedAt: "2026-09-29T03:30:00Z", want: true},
		{name: "recent timestamp", startedAt: "2026-09-29T03:30:01Z", want: false},
		{name: "fallback to created at", createdAt: "2026-09-29T03:00:00Z", want: true},
		{name: "invalid timestamp", startedAt: "not-a-time", createdAt: "2026-09-29T03:00:00Z", want: false},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if got := generationTaskStartedBefore(test.startedAt, test.createdAt, cutoff); got != test.want {
				t.Fatalf("generationTaskStartedBefore() = %v, want %v", got, test.want)
			}
		})
	}
}
