package service

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"strings"
	"time"
)

var safeProxyHTTPClient = newSafeProxyHTTPClient()

const defaultSSRFDialTimeout = 5 * time.Second

func SafeProxyHTTPClient() *http.Client {
	return safeProxyHTTPClient
}
func newSafeProxyHTTPClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	dialTimeout := ssrfDialTimeout()
	transport.DialContext = func(ctx context.Context, network, address string) (net.Conn, error) {
		return safeProxyDialContext(ctx, network, address, dialTimeout)
	}
	return &http.Client{
		Transport: transport,
		Timeout:   5 * time.Minute,
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			if len(via) > 5 {
				return errors.New("重定向次数过多")
			}
			scheme := strings.ToLower(req.URL.Scheme)
			if scheme != "http" && scheme != "https" {
				return errors.New("重定向地址无效")
			}
			return nil
		},
	}
}

func ssrfDialTimeout() time.Duration {
	raw, found := os.LookupEnv("SSRF_DIAL_TIMEOUT")
	raw = strings.TrimSpace(raw)
	if !found || raw == "" {
		return defaultSSRFDialTimeout
	}
	value, err := time.ParseDuration(raw)
	if err != nil || value <= 0 {
		log.Printf("invalid SSRF_DIAL_TIMEOUT=%q, using %s", raw, defaultSSRFDialTimeout)
		return defaultSSRFDialTimeout
	}
	return value
}

func safeProxyDialContext(ctx context.Context, network, address string, timeout ...time.Duration) (net.Conn, error) {
	host, port, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	ips, err := net.DefaultResolver.LookupIPAddr(ctx, host)
	if err != nil || len(ips) == 0 {
		return nil, errors.New("无法解析目标地址")
	}
	for _, item := range ips {
		if isBlockedProxyIP(item.IP) {
			return nil, errors.New("禁止访问本地或内网地址")
		}
	}
	dialTimeout := defaultSSRFDialTimeout
	if len(timeout) > 0 && timeout[0] > 0 {
		dialTimeout = timeout[0]
	}
	dialer := net.Dialer{
		Timeout:   dialTimeout,
		KeepAlive: 30 * time.Second,
	}
	var lastErr error
	for _, item := range ips {
		conn, err := dialer.DialContext(
			ctx,
			network,
			net.JoinHostPort(item.String(), port),
		)
		if err == nil {
			return conn, nil
		}
		lastErr = err
	}
	return nil, fmt.Errorf("无法连接目标地址: %w", lastErr)
}

func isBlockedProxyIP(ip net.IP) bool {
	if ip == nil {
		return true
	}
	if ip.IsLoopback() ||
		ip.IsPrivate() ||
		ip.IsLinkLocalUnicast() ||
		ip.IsLinkLocalMulticast() ||
		ip.IsMulticast() ||
		ip.IsUnspecified() {
		return true
	}
	ip4 := ip.To4()
	if ip4 == nil {
		return false
	}
	// 100.64.0.0/10，包括部分云平台 metadata 地址。
	if ip4[0] == 100 && ip4[1] >= 64 && ip4[1] <= 127 {
		return true
	}
	return ip4[0] == 0
}
