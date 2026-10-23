package middleware

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/gin-gonic/gin"
)

const apiGzipTestMinimum = 1025

func TestMain(m *testing.M) {
	gin.SetMode(gin.TestMode)
	os.Exit(m.Run())
}

func TestAPIGzipCompressesLargeJSONAndUpdatesHeaders(t *testing.T) {
	body := apiGzipTestJSON(apiGzipTestMinimum)
	response := serveAPIRequest(t, "gzip", http.MethodGet, "/api/items", func(c *gin.Context) {
		c.Header("Content-Type", "application/json; charset=utf-8")
		c.Header("Vary", "Origin")
		c.Header("Content-Length", strconv.Itoa(len(body)))
		_, _ = c.Writer.Write(body)
	})

	if response.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", response.Code)
	}
	if got := response.Header().Get("Content-Type"); got != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q, want application/json; charset=utf-8", got)
	}
	if got := response.Header().Get("Content-Length"); got != "" {
		t.Fatalf("Content-Length = %q, want absent", got)
	}
	if got := strings.Join(response.Header().Values("Vary"), ", "); got != "Origin, Accept-Encoding" {
		t.Fatalf("Vary = %q, want Origin, Accept-Encoding", got)
	}
	assertGzipDecodesTo(t, response, body)
}

func TestAPIGzipEligibilityAndExclusions(t *testing.T) {
	body := apiGzipTestJSON(apiGzipTestMinimum)
	tests := []struct {
		name            string
		acceptEncoding  string
		method          string
		path            string
		status          int
		contentType     string
		wantCompression bool
	}{
		{name: "gzip JSON", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: true},
		{name: "gzip JSON charset", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json; charset=utf-8", wantCompression: true},
		{name: "gzip JSON suffix", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/problem+json", wantCompression: true},
		{name: "gzip token among encodings", acceptEncoding: "br, gzip;q=0.8", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: true},
		{name: "gzip token is case-insensitive", acceptEncoding: "GZip", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: true},
		{name: "only GET", acceptEncoding: "gzip", method: http.MethodPost, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "no Accept-Encoding", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "gzip q is zero", acceptEncoding: "gzip;q=0", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "gzip q is zero with spaces", acceptEncoding: "gzip; q = 0.000", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "not 200", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusCreated, contentType: "application/json", wantCompression: false},
		{name: "range is 206", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusPartialContent, contentType: "application/json", wantCompression: false},
		{name: "SSE", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/events", status: http.StatusOK, contentType: "text/event-stream; charset=utf-8", wantCompression: false},
		{name: "image media", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/proxy-image", status: http.StatusOK, contentType: "image/png", wantCompression: false},
		{name: "video media", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/proxy-media", status: http.StatusOK, contentType: "video/mp4", wantCompression: false},
		{name: "precompressed media", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/items", status: http.StatusOK, contentType: "application/gzip", wantCompression: false},
		{name: "file info", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/files/id", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "file content", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/files/id/content", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "file preview", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/files/id/preview", status: http.StatusOK, contentType: "application/json", wantCompression: false},
		{name: "filesystem is not files", acceptEncoding: "gzip", method: http.MethodGet, path: "/api/filesystem", status: http.StatusOK, contentType: "application/json", wantCompression: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			response := serveAPIRequestWithBody(t, test.acceptEncoding, test.method, test.path, body, func(c *gin.Context) {
				c.Header("Content-Type", test.contentType)
				c.Status(test.status)
				_, _ = c.Writer.Write(body)
			})
			if response.Code != test.status {
				t.Fatalf("status = %d, want %d", response.Code, test.status)
			}
			if got := response.Header().Get("Content-Encoding") == "gzip"; got != test.wantCompression {
				t.Fatalf("gzip compressed = %t, want %t; headers: %v", got, test.wantCompression, response.Header())
			}
			if !test.wantCompression && !bytes.Equal(response.Body.Bytes(), body) {
				t.Fatalf("uncompressed body changed: got %d bytes, want %d", response.Body.Len(), len(body))
			}
			if test.wantCompression {
				assertGzipDecodesTo(t, response, body)
			}
		})
	}
}

func TestAPIGzipExcludedFileRangePreservesStatusAndBody(t *testing.T) {
	body := []byte(`{"data":"file"}`)
	response := serveAPIRequestWithBody(t, "gzip", http.MethodGet, "/api/files/object/content", body, func(c *gin.Context) {
		c.Header("Content-Type", "application/json")
		c.Header("Content-Range", "bytes 0-13/14")
		c.Status(http.StatusPartialContent)
		_, _ = c.Writer.Write(body)
	}, map[string]string{"Range": "bytes=0-13"})

	if response.Code != http.StatusPartialContent {
		t.Fatalf("status = %d, want 206", response.Code)
	}
	if got := response.Header().Get("Content-Range"); got != "bytes 0-13/14" {
		t.Fatalf("Content-Range = %q, want bytes 0-13/14", got)
	}
	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want absent", got)
	}
	if !bytes.Equal(response.Body.Bytes(), body) {
		t.Fatalf("body = %q, want %q", response.Body.Bytes(), body)
	}
}

func TestAPIGzipThresholdPreservesSmallResponses(t *testing.T) {
	for _, size := range []int{0, 1, 512, 1024} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			body := apiGzipTestJSON(size)
			response := serveAPIRequestWithBody(t, "gzip", http.MethodGet, "/api/items", body, func(c *gin.Context) {
				c.Header("Content-Type", "application/json")
				_, _ = c.Writer.Write(body)
			})
			if got := response.Header().Get("Content-Encoding"); got != "" {
				t.Fatalf("Content-Encoding = %q, want absent", got)
			}
			if !bytes.Equal(response.Body.Bytes(), body) {
				t.Fatalf("body = %q, want %q", response.Body.Bytes(), body)
			}
		})
	}
}

func TestAPIGzipCompressesGinJSONAfterWriteHeaderNow(t *testing.T) {
	body := gin.H{"data": strings.Repeat("compressible", 100)}
	response := serveAPIRequest(t, "gzip", http.MethodGet, "/api/json", func(c *gin.Context) {
		c.JSON(http.StatusOK, body)
	})

	assertGzipDecodesJSONTo(t, response, body)
}

func TestAPIGzipLeavesSmallGinJSONUncompressed(t *testing.T) {
	response := serveAPIRequest(t, "gzip", http.MethodGet, "/api/json", func(c *gin.Context) {
		c.JSON(http.StatusOK, gin.H{"ok": true})
	})

	if got := response.Header().Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want absent", got)
	}
	var body map[string]any
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode JSON: %v", err)
	}
	if body["ok"] != true {
		t.Fatalf("decoded body = %#v", body)
	}
}

func TestAPIGzipSSEFlushIsImmediateAndUncompressed(t *testing.T) {
	handler := gin.New()
	handler.Use(APIGzip())
	handler.GET("/api/events", func(c *gin.Context) {
		c.Header("Content-Type", "text/event-stream")
		_, _ = c.Writer.WriteString("data: first\n\n")
		c.Writer.Flush()
		time.Sleep(200 * time.Millisecond)
		_, _ = c.Writer.WriteString("data: second\n\n")
		c.Writer.Flush()
	})
	server := httptest.NewServer(handler)
	defer server.Close()

	request, err := http.NewRequest(http.MethodGet, server.URL+"/api/events", nil)
	if err != nil {
		t.Fatal(err)
	}
	request.Header.Set("Accept-Encoding", "gzip")
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	if got := response.Header.Get("Content-Encoding"); got != "" {
		t.Fatalf("Content-Encoding = %q, want absent", got)
	}
	started := time.Now()
	line, err := bufio.NewReader(response.Body).ReadString('\n')
	elapsed := time.Since(started)
	if err != nil {
		t.Fatalf("read first SSE line: %v", err)
	}
	if line != "data: first\n" {
		t.Fatalf("first SSE line = %q, want data: first", line)
	}
	if elapsed >= 150*time.Millisecond {
		t.Fatalf("first SSE line arrived after %v, want immediate Flush", elapsed)
	}
}

func TestAPIGzipPreservesResponseWriterInterfaces(t *testing.T) {
	source := &apiGzipTestGinWriter{header: make(http.Header)}
	writer := newAPIGzipWriter(source)
	var _ http.Flusher = writer
	var _ http.Hijacker = writer
	var _ http.Pusher = writer
	var _ io.ReaderFrom = writer
	source.header.Set("Content-Type", "application/json")
	if _, err := writer.Write(bytes.Repeat([]byte("a"), apiGzipTestMinimum)); err != nil {
		t.Fatal(err)
	}
	if got := source.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := source.Header().Get("Content-Length"); got != "" {
		t.Fatalf("Content-Length = %q, want absent", got)
	}
	writer.Flush()
	writer.Close()
	reader, err := gzip.NewReader(bytes.NewReader(source.body.Bytes()))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer reader.Close()
	decoded, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip body: %v", err)
	}
	if !bytes.Equal(decoded, bytes.Repeat([]byte("a"), apiGzipTestMinimum)) {
		t.Fatalf("decoded body differs: got %d bytes", len(decoded))
	}
}

func apiGzipTestJSON(size int) []byte {
	if size == 0 {
		return nil
	}
	body := bytes.Repeat([]byte(" "), size)
	if size >= 11 {
		copy(body, []byte(`{"data":"`))
		copy(body[len(body)-2:], []byte(`"}`))
	}
	return body
}

func serveAPIRequest(t *testing.T, acceptEncoding, method, path string, handler gin.HandlerFunc) *httptest.ResponseRecorder {
	t.Helper()
	return serveAPIRequestWithBody(t, acceptEncoding, method, path, nil, handler)
}

func serveAPIRequestWithBody(t *testing.T, acceptEncoding, method, path string, body []byte, handler gin.HandlerFunc, headers ...map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	gin.SetMode(gin.TestMode)
	engine := gin.New()
	engine.Use(APIGzip())
	engine.Any("/*path", handler)
	var request *http.Request
	if body == nil {
		request = httptest.NewRequest(method, path, nil)
	} else {
		request = httptest.NewRequest(method, path, bytes.NewReader(body))
	}
	if acceptEncoding != "" {
		request.Header.Set("Accept-Encoding", acceptEncoding)
	}
	if len(headers) > 0 {
		for key, value := range headers[0] {
			request.Header.Set(key, value)
		}
	}
	response := httptest.NewRecorder()
	engine.ServeHTTP(response, request)
	return response
}

func assertGzipDecodesTo(t *testing.T, response *httptest.ResponseRecorder, want []byte) {
	t.Helper()
	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	reader, err := gzip.NewReader(bytes.NewReader(response.Body.Bytes()))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer reader.Close()
	got, err := io.ReadAll(reader)
	if err != nil {
		t.Fatalf("read gzip: %v", err)
	}
	if !bytes.Equal(got, want) {
		t.Fatalf("decoded body differs: got %d bytes, want %d", len(got), len(want))
	}
}

func assertGzipDecodesJSONTo(t *testing.T, response *httptest.ResponseRecorder, want any) {
	t.Helper()
	if got := response.Header().Get("Content-Encoding"); got != "gzip" {
		t.Fatalf("Content-Encoding = %q, want gzip", got)
	}
	if got := response.Header().Get("Content-Length"); got != "" {
		t.Fatalf("Content-Length = %q, want absent", got)
	}
	reader, err := gzip.NewReader(bytes.NewReader(response.Body.Bytes()))
	if err != nil {
		t.Fatalf("gzip.NewReader: %v", err)
	}
	defer reader.Close()
	var got any
	if err := json.NewDecoder(reader).Decode(&got); err != nil {
		t.Fatalf("decode gzip JSON: %v", err)
	}
	wantJSON, _ := json.Marshal(want)
	gotJSON, _ := json.Marshal(got)
	if !bytes.Equal(gotJSON, wantJSON) {
		t.Fatalf("decoded JSON = %s, want %s", gotJSON, wantJSON)
	}
}

type apiGzipTestGinWriter struct {
	header     http.Header
	body       bytes.Buffer
	status     int
	written    bool
	headerCode int
}

func (w *apiGzipTestGinWriter) Header() http.Header { return w.header }
func (w *apiGzipTestGinWriter) Write(p []byte) (int, error) {
	w.written = true
	return w.body.Write(p)
}
func (w *apiGzipTestGinWriter) WriteHeader(status int) {
	w.status = status
	w.written = true
}
func (w *apiGzipTestGinWriter) WriteHeaderNow() {
	w.headerCode = w.status
	w.written = true
}
func (w *apiGzipTestGinWriter) Status() int                       { return w.status }
func (w *apiGzipTestGinWriter) Size() int                         { return w.body.Len() }
func (w *apiGzipTestGinWriter) WriteString(s string) (int, error) { return w.Write([]byte(s)) }
func (w *apiGzipTestGinWriter) Written() bool                     { return w.written }
func (w *apiGzipTestGinWriter) Flush()                            { w.WriteHeaderNow() }
func (w *apiGzipTestGinWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return nil, nil, nil
}
func (w *apiGzipTestGinWriter) CloseNotify() <-chan bool { return make(chan bool) }
func (w *apiGzipTestGinWriter) Pusher() http.Pusher      { return w }
func (w *apiGzipTestGinWriter) Push(string, *http.PushOptions) error {
	return nil
}
func (w *apiGzipTestGinWriter) ReadFrom(r io.Reader) (int64, error) {
	return io.Copy(io.Discard, r)
}
