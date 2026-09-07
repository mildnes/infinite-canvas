package handler

import (
	"bytes"
	"io"
	"net/http"
	"sync"
	"testing"
	"time"
)

type streamingResponseWriter struct {
	header    http.Header
	body      bytes.Buffer
	wrote     chan struct{}
	flushed   chan struct{}
	once      sync.Once
	flushOnce sync.Once
}

func (w *streamingResponseWriter) Header() http.Header { return w.header }
func (w *streamingResponseWriter) WriteHeader(int)     {}
func (w *streamingResponseWriter) Write(data []byte) (int, error) {
	w.once.Do(func() { close(w.wrote) })
	return w.body.Write(data)
}
func (w *streamingResponseWriter) Flush() {
	w.flushOnce.Do(func() { close(w.flushed) })
}

func TestProxyImageResponseStreamsBeforeUpstreamEOF(t *testing.T) {
	reader, writer := io.Pipe()
	responseWriter := &streamingResponseWriter{header: make(http.Header), wrote: make(chan struct{}), flushed: make(chan struct{})}
	responseHeader := make(http.Header)
	responseHeader.Set("Content-Type", "image/png")
	responseHeader.Set("ETag", "image-version")
	response := &http.Response{
		StatusCode: http.StatusOK,
		Header:     responseHeader,
		Body:       reader,
	}
	done := make(chan error, 1)
	go func() { done <- writeProxyImageResponse(responseWriter, response) }()

	if _, err := writer.Write([]byte("first-chunk")); err != nil {
		t.Fatal(err)
	}
	select {
	case <-responseWriter.wrote:
	case <-time.After(time.Second):
		_ = writer.Close()
		t.Fatal("代理响应在上游结束前没有写出首个数据块")
	}
	select {
	case <-responseWriter.flushed:
	case <-time.After(time.Second):
		_ = writer.Close()
		t.Fatal("代理响应写出数据后没有刷新到客户端")
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	if err := <-done; err != nil {
		t.Fatal(err)
	}
	if got := responseWriter.body.String(); got != "first-chunk" {
		t.Fatalf("代理响应内容 = %q", got)
	}
	if got := responseWriter.header.Get("ETag"); got != "image-version" {
		t.Fatalf("ETag = %q", got)
	}
}
