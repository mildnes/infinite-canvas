package service

import (
	"context"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"strings"
	"testing"
	"time"
)

func TestIsBlockedProxyIP(t *testing.T) {
	cases := map[string]bool{
		"127.0.0.1":       true,
		"10.0.0.1":        true,
		"172.16.0.1":      true,
		"192.168.1.1":     true,
		"169.254.169.254": true,
		"100.100.100.200": true,
		"0.0.0.0":         true,
		"::1":             true,
		"fc00::1":         true,
		"fe80::1":         true,
		"1.1.1.1":         false,
		"8.8.8.8":         false,
	}
	for raw, expected := range cases {
		actual := isBlockedProxyIP(net.ParseIP(raw))
		if actual != expected {
			t.Fatalf(
				"isBlockedProxyIP(%q) = %v，期望 %v",
				raw,
				actual,
				expected,
			)
		}
	}
}

func TestSafeProxyHTTPClientRedirectLimit(t *testing.T) {
	client := SafeProxyHTTPClient()
	request, err := http.NewRequest(
		http.MethodGet,
		"https://example.com/image.png",
		nil,
	)
	if err != nil {
		t.Fatal(err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 5),
	); err != nil {
		t.Fatalf("第 5 次重定向不应被拒绝：%v", err)
	}
	if err := client.CheckRedirect(
		request,
		make([]*http.Request, 6),
	); err == nil {
		t.Fatal("超过 5 次重定向应被拒绝")
	}
}

func TestSSRFDialTimeout(t *testing.T) {
	var output strings.Builder
	previous := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previous) })
	t.Setenv("SSRF_DIAL_TIMEOUT", "")
	if got := ssrfDialTimeout(); got != 5*time.Second {
		t.Fatalf("empty SSRF_DIAL_TIMEOUT = %s, want 5s", got)
	}
	if output.Len() != 0 {
		t.Fatalf("empty SSRF_DIAL_TIMEOUT was logged: %q", output.String())
	}
	t.Setenv("SSRF_DIAL_TIMEOUT", "12s")
	if got := ssrfDialTimeout(); got != 12*time.Second {
		t.Fatalf("custom SSRF_DIAL_TIMEOUT = %s, want 12s", got)
	}
	t.Setenv("SSRF_DIAL_TIMEOUT", "invalid")
	if got := ssrfDialTimeout(); got != 5*time.Second {
		t.Fatalf("invalid SSRF_DIAL_TIMEOUT = %s, want fallback 5s", got)
	}
	if !strings.Contains(output.String(), "SSRF_DIAL_TIMEOUT") {
		t.Fatalf("invalid value was not logged: %q", output.String())
	}
	if SafeProxyHTTPClient().Timeout != 5*time.Minute {
		t.Fatalf("overall HTTP timeout changed to %s", SafeProxyHTTPClient().Timeout)
	}
}

func TestSSRFConfiguredDialTimeout(t *testing.T) {
	if os.Getenv("IC_SSRF_DIAL_TIMEOUT_FIXTURE") == "1" {
		t.Setenv("SSRF_DIAL_TIMEOUT", "80ms")
		start := time.Now()
		_, err := safeProxyDialContext(context.Background(), "tcp", "203.0.113.1:81", ssrfDialTimeout())
		if err == nil || time.Since(start) > time.Second {
			t.Fatalf("dial timeout fixture err=%v elapsed=%s", err, time.Since(start))
		}
		return
	}
	command := exec.Command(os.Args[0], "-test.run=^TestSSRFConfiguredDialTimeout$", "-test.v")
	command.Env = append(os.Environ(), "IC_SSRF_DIAL_TIMEOUT_FIXTURE=1", "SSRF_DIAL_TIMEOUT=80ms")
	output, err := command.CombinedOutput()
	if err != nil {
		t.Fatalf("SSRF dial timeout fixture: %v\n%s", err, output)
	}
}

func TestSSRFNewClientPreservesFiveMinuteTimeout(t *testing.T) {
	if got := newSafeProxyHTTPClient().Timeout; got != 5*time.Minute {
		t.Fatalf("new safe client timeout = %s, want 5m", got)
	}
}
