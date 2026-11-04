package service

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"strings"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestBatch3S3VendorAddressing(t *testing.T) {
	for _, test := range []struct {
		name, provider, endpoint, region, host, path string
	}{
		{"cos-virtual", "cos", "https://cos.ap-shanghai.myqcloud.com", "ap-shanghai", "media.cos.ap-shanghai.myqcloud.com", "/owner/image.png"},
		{"oss-virtual", "oss", "https://oss-cn-hangzhou.aliyuncs.com", "cn-hangzhou", "media.oss-cn-hangzhou.aliyuncs.com", "/owner/image.png"},
		{"cos-path", "cos", "https://cos.ap-shanghai.myqcloud.com", "ap-shanghai", "cos.ap-shanghai.myqcloud.com", "/media/owner/image.png"},
		{"oss-path", "oss", "https://oss-cn-hangzhou.aliyuncs.com", "cn-hangzhou", "oss-cn-hangzhou.aliyuncs.com", "/media/owner/image.png"},
	} {
		t.Run(test.name, func(t *testing.T) {
			style := "virtual"
			if test.name[len(test.name)-4:] == "path" {
				style = "path"
			}
			raw, err := json.Marshal(map[string]any{
				"type": "s3", "s3Provider": test.provider, "s3AddressingStyle": style,
				"endpoint": test.endpoint, "region": test.region, "bucket": "media",
				"accessKeyId": "key", "secretAccessKey": "secret",
			})
			if err != nil {
				t.Fatal(err)
			}
			provider := normalizeStorageProvider(mustBatch3Provider(t, string(raw)))
			request, err := newS3Request(http.MethodPut, provider, "owner/image.png", nil, 0, sha256Hex([]byte("image")))
			if err != nil {
				t.Fatal(err)
			}
			if request.URL.Host != test.host || request.URL.Path != test.path {
				t.Fatalf("URL actual=%s%s expected=%s%s", request.URL.Host, request.URL.Path, test.host, test.path)
			}
			if request.Header.Get("Host") != test.host {
				t.Fatalf("signed host actual=%q expected=%q", request.Header.Get("Host"), test.host)
			}
			if request.Header.Get("Authorization") != batch3S3Authorization(request, provider, sha256Hex([]byte("image"))) {
				t.Fatal("SigV4 canonical host/path does not match the vendor-addressed URL")
			}
		})
	}
}

func TestBatch3S3AddressingDefaultAndEncoding(t *testing.T) {
	legacy := normalizeStorageProvider(mustBatch3Provider(t, `{"type":"s3","endpoint":"https://legacy.example.com","bucket":"media","accessKeyId":"key","secretAccessKey":"secret"}`))
	if batch3ProviderFields(t, legacy)["s3Provider"] != "s3" || batch3ProviderFields(t, legacy)["s3AddressingStyle"] != "path" {
		t.Fatalf("legacy defaults actual=%v expected vendor=s3 style=path", batch3ProviderFields(t, legacy))
	}
	legacyRequest, err := newS3Request(http.MethodGet, legacy, "owner/a b.png", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if legacyRequest.URL.Host != "legacy.example.com" || legacyRequest.URL.Path != "/media/owner/a b.png" || legacyRequest.URL.EscapedPath() != "/media/owner/a%20b.png" {
		t.Fatalf("legacy URL changed host=%q path=%q rawPath=%q", legacyRequest.URL.Host, legacyRequest.URL.Path, legacyRequest.URL.RawPath)
	}
	virtual := normalizeStorageProvider(mustBatch3Provider(t, `{"type":"s3","s3AddressingStyle":"virtual","endpoint":"https://endpoint.example.com/base","bucket":"media","accessKeyId":"key","secretAccessKey":"secret"}`))
	request, err := newS3Request(http.MethodGet, virtual, "owner/a b.png", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if request.URL.Host != "media.endpoint.example.com" || request.URL.Path != "/base/owner/a b.png" {
		t.Fatalf("virtual endpoint path lost host=%q path=%q", request.URL.Host, request.URL.Path)
	}
	if request.URL.EscapedPath() != "/base/owner/a%20b.png" || !strings.Contains(request.Header.Get("Authorization"), "Signature=") {
		t.Fatalf("virtual URL encoding or signature missing: %s", request.URL.String())
	}
	webDAV := batch3ProviderFields(t, normalizeStorageProvider(mustBatch3Provider(t, `{"type":"webdav","endpoint":"https://dav.example.com","username":"user","password":"secret","s3Provider":"oss","s3AddressingStyle":"virtual"}`)))
	if value, found := webDAV["s3AddressingStyle"]; found && !reflect.DeepEqual(value, "") {
		t.Fatal("WebDAV must not retain S3 addressing fields")
	}
	if got := newS3RequestWithQuery; got == nil {
		t.Fatal("query request helper removed")
	}
	query := url.Values{"list-type": {"2"}}
	list, err := newS3RequestWithQuery(http.MethodGet, virtual, "", query, nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	if list.URL.RawQuery != "list-type=2" || list.URL.Path != "/base" && list.URL.Path != "/base/" {
		t.Fatalf("list request must keep query and base path: %s", list.URL.String())
	}
}

func batch3S3Authorization(request *http.Request, provider model.StorageProvider, payloadHash string) string {
	date := request.Header.Get("X-Amz-Date")
	region := provider.Region
	if region == "" {
		region = "auto"
	}
	scope := date[:8] + "/" + region + "/s3/aws4_request"
	headers := "host:" + request.URL.Host + "\nx-amz-content-sha256:" + payloadHash + "\nx-amz-date:" + date + "\n"
	signedHeaders := "host;x-amz-content-sha256;x-amz-date"
	canonical := strings.Join([]string{request.Method, request.URL.EscapedPath(), request.URL.RawQuery, headers, signedHeaders, payloadHash}, "\n")
	key := []byte("AWS4" + provider.SecretAccessKey)
	for _, value := range []string{date[:8], region, "s3", "aws4_request", "AWS4-HMAC-SHA256\n" + date + "\n" + scope + "\n" + sha256Hex([]byte(canonical))} {
		mac := hmac.New(sha256.New, key)
		_, _ = mac.Write([]byte(value))
		key = mac.Sum(nil)
	}
	return "AWS4-HMAC-SHA256 Credential=" + provider.AccessKeyID + "/" + scope + ", SignedHeaders=" + signedHeaders + ", Signature=" + hex.EncodeToString(key)
}

func mustBatch3Provider(t *testing.T, raw string) model.StorageProvider {
	t.Helper()
	var provider model.StorageProvider
	if err := json.Unmarshal([]byte(raw), &provider); err != nil {
		t.Fatal(err)
	}
	return provider
}

func batch3ProviderFields(t *testing.T, provider model.StorageProvider) map[string]any {
	t.Helper()
	raw, err := json.Marshal(provider)
	if err != nil {
		t.Fatal(err)
	}
	var fields map[string]any
	if err := json.Unmarshal(raw, &fields); err != nil {
		t.Fatal(err)
	}
	return fields
}
