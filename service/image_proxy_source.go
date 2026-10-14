package service

import (
	"errors"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
)

// Source authorization is deliberately separate from MIME and SSRF checks.
// Exact hosts (including any non-default port) can be restricted without
// choosing or migrating the provider reference transport before R8 is measured.
func AuthorizeImageProxySource(raw string) error {
	u, err := url.Parse(raw)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || u.User != nil {
		return errors.New("无效的图片来源")
	}
	allowed := strings.TrimSpace(config.Cfg.ImageProxyAllowedHosts)
	if allowed == "" {
		return nil
	}
	for _, host := range strings.Split(allowed, ",") {
		if strings.EqualFold(strings.TrimSpace(host), u.Host) {
			return nil
		}
	}
	return errors.New("图片来源未获授权")
}
