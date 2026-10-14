package service

import (
	"net/http/httptest"
	"testing"

	"github.com/tigerowo/infinite-canvas/config"
)

func TestRequestOriginRejectsForwardedAndRequestHostInjection(t *testing.T) {
	previous := config.Cfg
	t.Cleanup(func() { config.Cfg = previous })
	config.Cfg.PublicBaseURL = "https://canvas.example/base"
	for _, host := range []string{"attacker.example", "canvas.example"} {
		r := httptest.NewRequest("GET", "http://"+host+"/api/auth/linux-do/callback", nil)
		r.Header.Set("X-Forwarded-Host", "attacker.example")
		r.Header.Set("X-Forwarded-Proto", "javascript")
		if got := RequestOrigin(r); got != "https://canvas.example" {
			t.Errorf("untrusted host escaped trusted origin: %s", got)
		}
	}
	config.Cfg.PublicBaseURL, config.Cfg.Port = "", "8080"
	if got := RequestOrigin(httptest.NewRequest("GET", "http://attacker.example/", nil)); got != "http://localhost:8080" {
		t.Errorf("missing origin must use fixed local fallback: %s", got)
	}
}
