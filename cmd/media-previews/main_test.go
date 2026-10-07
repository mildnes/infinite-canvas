package main

import "testing"

func TestPreviewReportFormat(t *testing.T) {
	for name, want := range map[string]string{"/cache/id.png": "png", "/cache/id.jpg": "jpeg", "": ""} {
		if got := previewFormat(name); got != want {
			t.Fatalf("format %q: %q != %q", name, got, want)
		}
	}
}
