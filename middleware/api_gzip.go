package middleware

import (
	"bufio"
	"compress/gzip"
	"io"
	"mime"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/gin-gonic/gin"
)

const apiGzipMinimumSize = 1024

// APIGzip compresses eligible GET JSON responses made by the API group.
func APIGzip() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !apiGzipRequestEligible(c.Request) {
			c.Next()
			return
		}
		writer := newAPIGzipWriter(c.Writer)
		c.Writer = writer
		c.Next()
		writer.Close()
	}
}

func apiGzipRequestEligible(r *http.Request) bool {
	return r.Method == http.MethodGet &&
		!strings.HasPrefix(r.URL.Path, "/api/files/") &&
		apiGzipAccepted(r.Header.Get("Accept-Encoding"))
}

type apiGzipWriter struct {
	gin.ResponseWriter
	status        int
	headerPending bool
	decided       bool
	compressed    bool
	gzipWriter    *gzip.Writer
}

func newAPIGzipWriter(writer gin.ResponseWriter) *apiGzipWriter {
	return &apiGzipWriter{ResponseWriter: writer, status: http.StatusOK}
}

func (w *apiGzipWriter) WriteHeader(status int) {
	if w.decided {
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.status = status
	if status != http.StatusOK {
		w.decide(nil)
		w.ResponseWriter.WriteHeader(status)
		return
	}
	if w.Header().Get("Content-Length") != "" || w.ResponseWriter.Written() {
		w.decide(nil)
		w.ResponseWriter.WriteHeader(status)
		return
	}
	w.headerPending = true
}

func (w *apiGzipWriter) WriteHeaderNow() {
	w.decide(nil)
	w.ResponseWriter.WriteHeader(w.status)
}

func (w *apiGzipWriter) Write(data []byte) (int, error) {
	w.decide(data)
	if !w.compressed {
		return w.ResponseWriter.Write(data)
	}
	if len(data) == 0 {
		return 0, nil
	}
	return w.gzipWriter.Write(data)
}

func (w *apiGzipWriter) WriteString(value string) (int, error) {
	return w.Write([]byte(value))
}

func (w *apiGzipWriter) Flush() {
	w.decide(nil)
	w.ResponseWriter.Flush()
}

func (w *apiGzipWriter) Close() {
	if w.decided {
		if w.compressed {
			_ = w.gzipWriter.Close()
		}
		return
	}
	if w.headerPending {
		w.decide(nil)
		w.ResponseWriter.WriteHeader(w.status)
		return
	}
	if w.ResponseWriter.Written() {
		w.decide(nil)
		if w.compressed {
			_ = w.gzipWriter.Close()
		}
	}
}

func (w *apiGzipWriter) decide(first []byte) {
	if w.decided {
		return
	}
	w.decided = true
	if w.status != http.StatusOK {
		return
	}
	if !w.jsonResponse() || w.Header().Get("Content-Encoding") != "" {
		return
	}
	if len(first) <= apiGzipMinimumSize {
		return
	}
	w.Header().Del("Content-Length")
	w.Header().Set("Content-Encoding", "gzip")
	appendVary(w.Header(), "Accept-Encoding")
	w.gzipWriter = gzip.NewWriter(w.ResponseWriter)
	w.compressed = true
	w.headerPending = false
	w.ResponseWriter.WriteHeader(w.status)
}

func apiGzipAccepted(value string) bool {
	for _, part := range strings.Split(strings.ToLower(value), ",") {
		encoding, params, _ := strings.Cut(strings.TrimSpace(part), ";")
		if strings.TrimSpace(encoding) != "gzip" {
			continue
		}
		params = strings.TrimSpace(params)
		params = strings.ReplaceAll(params, " ", "")
		if strings.HasPrefix(params, "q=") {
			quality, err := strconv.ParseFloat(strings.TrimPrefix(params, "q="), 64)
			if err == nil && quality == 0 {
				return false
			}
		}
		return true
	}
	return false
}

func (w *apiGzipWriter) jsonResponse() bool {
	contentType, _, err := mime.ParseMediaType(w.Header().Get("Content-Type"))
	return err == nil && isAPIJSONContentType(contentType)
}

func (w *apiGzipWriter) Header() http.Header {
	return w.ResponseWriter.Header()
}

func (w *apiGzipWriter) Status() int {
	return w.status
}

func (w *apiGzipWriter) Size() int {
	return w.ResponseWriter.Size()
}

func (w *apiGzipWriter) Written() bool {
	return w.status != http.StatusOK || w.ResponseWriter.Written()
}

func (w *apiGzipWriter) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return w.ResponseWriter.Hijack()
}

func (w *apiGzipWriter) Push(target string, options *http.PushOptions) error {
	if pusher := w.ResponseWriter.Pusher(); pusher != nil {
		return pusher.Push(target, options)
	}
	return http.ErrNotSupported
}

func (w *apiGzipWriter) ReadFrom(reader io.Reader) (int64, error) {
	return io.Copy(w, reader)
}

func (w *apiGzipWriter) Unwrap() http.ResponseWriter {
	return w.ResponseWriter
}

func (w *apiGzipWriter) CloseNotify() <-chan bool {
	return w.ResponseWriter.CloseNotify()
}

func isAPIJSONContentType(contentType string) bool {
	contentType = strings.ToLower(contentType)
	return contentType == "application/json" || strings.HasSuffix(contentType, "+json")
}

func appendVary(header http.Header, value string) {
	for _, existing := range header.Values("Vary") {
		for _, item := range strings.Split(existing, ",") {
			if strings.EqualFold(strings.TrimSpace(item), value) {
				return
			}
		}
	}
	header.Add("Vary", value)
}
