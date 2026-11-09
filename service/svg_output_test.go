package service

import "testing"

func TestSVGExtensionKeepsUploadPolicy(t *testing.T) {
	if got := extensionForContentType("image/svg+xml"); got != ".svg" {
		t.Errorf("SVG extension actual=%q expected=.svg", got)
	}
	if IsSupportedUploadedMIME("image/svg+xml") {
		t.Fatal("SVG must not gain a MIME whitelist exemption")
	}
	if _, err := NormalizeUploadedMIME("image/svg+xml", []byte(`<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"/>`)); err == nil {
		t.Fatal("SVG upload policy was relaxed")
	}
}
