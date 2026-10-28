package service

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
)

func newAICallLogTestIndex(t *testing.T, options aiCallLogIndexOptions) (*aiCallLogIndex, string) {
	t.Helper()
	dir := t.TempDir()
	originalDir := config.Cfg.AILogDir
	config.Cfg.AILogDir = dir
	t.Cleanup(func() {
		config.Cfg.AILogDir = originalDir
	})
	return newAICallLogIndex(options), dir
}

func aiCallLogTestItem(id, createdAt string) model.AICallLog {
	return model.AICallLog{
		ID:              id,
		UserID:          "user",
		UserDisplayName: "测试用户",
		Endpoint:        "/v1/responses",
		Method:          "POST",
		Model:           "gpt-image-2",
		ChannelID:       "channel-a",
		ChannelName:     "测试渠道",
		Status:          200,
		DurationMs:      120,
		Credits:         1.5,
		CreatedAt:       createdAt,
	}
}

func mustAICallLogLine(t *testing.T, item model.AICallLog) []byte {
	t.Helper()
	encoded, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	return append(encoded, '\n')
}

func writeAICallLogTestFile(t *testing.T, dir, name string, items ...model.AICallLog) string {
	t.Helper()
	var content bytes.Buffer
	for _, item := range items {
		content.Write(mustAICallLogLine(t, item))
	}
	path := filepath.Join(dir, name)
	if err := os.WriteFile(path, content.Bytes(), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

func writeAICallLogTestBytes(t *testing.T, path string, content []byte) {
	t.Helper()
	if err := os.WriteFile(path, content, 0o644); err != nil {
		t.Fatal(err)
	}
}

func mustListAICallLogTestIndex(t *testing.T, index *aiCallLogIndex, q model.Query) model.AICallLogList {
	t.Helper()
	list, err := index.list(q)
	if err != nil {
		t.Fatal(err)
	}
	return list
}

func aiCallLogTestIDs(items []model.AICallLogSummary) []string {
	ids := make([]string, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func TestAICallLogIndexReusesUnchangedAndAppendsOnlyNewBytes(t *testing.T) {
	var parseCalls atomic.Int64
	var parsedBytes atomic.Int64
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
		MaxEntries: 100,
		ParseCount: func(_ string, bytes int64) {
			parseCalls.Add(1)
			parsedBytes.Add(bytes)
		},
	})

	first := aiCallLogTestItem("first", "2026-10-28T10:00:00Z")
	second := aiCallLogTestItem("second", "2026-10-28T10:01:00Z")
	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", first, second)
	fileInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	initialSize := fileInfo.Size()

	list := mustListAICallLogTestIndex(t, index, model.Query{Page: 1, PageSize: 20})
	if list.Total != 2 {
		t.Fatalf("first total = %d, want 2", list.Total)
	}
	if got := parseCalls.Load(); got != 1 {
		t.Fatalf("initial parse calls = %d, want 1", got)
	}
	if got := parsedBytes.Load(); got != initialSize {
		t.Fatalf("initial parsed bytes = %d, want %d", got, initialSize)
	}

	if got := mustListAICallLogTestIndex(t, index, model.Query{Page: 1, PageSize: 1}); got.Total != 2 {
		t.Fatalf("unchanged page 1 total = %d, want 2", got.Total)
	}
	if got := mustListAICallLogTestIndex(t, index, model.Query{Page: 2, PageSize: 1}); got.Total != 2 {
		t.Fatalf("unchanged page 2 total = %d, want 2", got.Total)
	}
	if got := parseCalls.Load(); got != 1 {
		t.Fatalf("unchanged queries triggered parsing, parse calls = %d", got)
	}

	third := aiCallLogTestItem("third", "2026-10-28T10:02:00Z")
	appended := mustAICallLogLine(t, third)
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write(appended); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	list = mustListAICallLogTestIndex(t, index, model.Query{Page: 1, PageSize: 20})
	if list.Total != 3 {
		t.Fatalf("appended total = %d, want 3", list.Total)
	}
	if got := parseCalls.Load(); got != 2 {
		t.Fatalf("append parse calls = %d, want 2", got)
	}
	if got, want := parsedBytes.Load()-initialSize, int64(len(appended)); got != want {
		t.Fatalf("append parsed bytes = %d, want only appended bytes %d", got, want)
	}
}

func TestAICallLogIndexDetectsCrossDayTruncateReplaceAndDelete(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})

	oldItem := aiCallLogTestItem("old-day", "2026-10-27T23:59:00Z")
	oldPath := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-27.log", oldItem)
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 1 {
		t.Fatalf("old-day total = %d, want 1", got.Total)
	}

	newItem := aiCallLogTestItem("new-day", "2026-10-28T00:01:00Z")
	newPath := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", newItem)
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 2 {
		t.Fatalf("cross-day total = %d, want 2", got.Total)
	}
	if item, found, err := index.get("new-day"); err != nil || !found || item.ID != "new-day" {
		t.Fatalf("cross-day detail = %+v, found=%v err=%v", item, found, err)
	}

	truncated := aiCallLogTestItem("x", "2026-10-28T00:02:00Z")
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", truncated)
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 2 {
		t.Fatalf("truncated total = %d, want 2", got.Total)
	}
	if _, found, err := index.get("new-day"); err != nil || found {
		t.Fatalf("truncated old id found=%v err=%v, want found=false err=nil", found, err)
	}
	if item, found, err := index.get("x"); err != nil || !found || item.ID != "x" {
		t.Fatalf("truncated new detail = %+v, found=%v err=%v", item, found, err)
	}

	beforeReplace := aiCallLogTestItem("same-size-a", "2026-10-28T00:03:00Z")
	afterReplace := aiCallLogTestItem("same-size-b", "2026-10-28T00:03:00Z")
	beforeLine := mustAICallLogLine(t, beforeReplace)
	afterLine := mustAICallLogLine(t, afterReplace)
	if len(beforeLine) != len(afterLine) {
		t.Fatalf("same-size fixture lengths differ: before=%d after=%d", len(beforeLine), len(afterLine))
	}
	writeAICallLogTestBytes(t, newPath, beforeLine)
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 2 {
		t.Fatalf("pre-replacement total = %d, want 2", got.Total)
	}

	replacementPath := newPath + ".replacement"
	writeAICallLogTestBytes(t, replacementPath, afterLine)
	if err := os.Rename(replacementPath, newPath); err != nil {
		t.Fatal(err)
	}
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 2 {
		t.Fatalf("replacement total = %d, want 2", got.Total)
	}
	if _, found, err := index.get("same-size-a"); err != nil || found {
		t.Fatalf("replaced id found=%v err=%v, want found=false err=nil", found, err)
	}
	if _, found, err := index.get("same-size-b"); err != nil || !found {
		t.Fatalf("replacement id found=%v err=%v, want found=true err=nil", found, err)
	}

	if err := os.Remove(newPath); err != nil {
		t.Fatal(err)
	}
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 1 {
		t.Fatalf("deleted-file total = %d, want 1", got.Total)
	}
	if _, found, err := index.get("same-size-b"); err != nil || found {
		t.Fatalf("deleted id found=%v err=%v, want found=false err=nil", found, err)
	}
	if _, found, err := index.get("old-day"); err != nil || !found {
		t.Fatalf("remaining old id found=%v err=%v, want found=true err=nil", found, err)
	}

	if _, err := os.Stat(oldPath); err != nil {
		t.Fatalf("old log path was removed: %v", err)
	}
}

func TestAICallLogIndexSkipsIncompleteAndDamagedLines(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})

	valid := aiCallLogTestItem("valid", "2026-10-28T10:00:00Z")
	incomplete := aiCallLogTestItem("incomplete", "2026-10-28T10:01:00Z")
	validLine := mustAICallLogLine(t, valid)
	incompleteLine := mustAICallLogLine(t, incomplete)
	incompleteLine = bytes.TrimSuffix(incompleteLine, []byte("\n"))
	path := filepath.Join(dir, "ai-calls-2026-10-28.log")
	content := append([]byte{}, validLine...)
	content = append(content, []byte("{damaged json}\n")...)
	content = append(content, incompleteLine...)
	writeAICallLogTestBytes(t, path, content)

	list := mustListAICallLogTestIndex(t, index, model.Query{})
	if list.Total != 1 {
		t.Fatalf("incomplete/damaged total = %d, want only one complete valid record", list.Total)
	}
	if _, found, err := index.get("valid"); err != nil || !found {
		t.Fatalf("valid record found=%v err=%v, want found=true err=nil", found, err)
	}
	index.mu.Lock()
	entries := append([]*aiCallLogEntry(nil), index.files[path].entries...)
	index.mu.Unlock()
	for _, entry := range entries {
		if entry.summary.ID == "incomplete" {
			t.Fatal("incomplete line without newline was added to the index")
		}
	}

	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND, 0)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := file.Write([]byte("\n")); err != nil {
		_ = file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}

	list = mustListAICallLogTestIndex(t, index, model.Query{})
	if list.Total != 2 {
		t.Fatalf("completed-line total = %d, want 2", list.Total)
	}
	if _, found, err := index.get("incomplete"); err != nil || !found {
		t.Fatalf("completed record found=%v err=%v, want found=true err=nil", found, err)
	}
}

func TestAICallLogIndexConcurrentRefreshBuildsOnce(t *testing.T) {
	started := make(chan struct{})
	release := make(chan struct{})
	var parseCalls atomic.Int64

	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
		MaxEntries: 100,
		ParseCount: func(_ string, _ int64) {
			if parseCalls.Add(1) == 1 {
				close(started)
				<-release
			}
		},
	})
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", aiCallLogTestItem("concurrent", "2026-10-28T10:00:00Z"))

	var wg sync.WaitGroup
	errs := make(chan error, 16)
	runList := func() {
		defer wg.Done()
		if _, err := index.list(model.Query{}); err != nil {
			errs <- err
		}
	}

	wg.Add(1)
	go runList()
	select {
	case <-started:
	case <-time.After(2 * time.Second):
		close(release)
		t.Fatal("timed out waiting for the first index build")
	}

	for i := 0; i < 12; i++ {
		wg.Add(1)
		go runList()
	}
	close(release)
	wg.Wait()
	close(errs)
	for err := range errs {
		t.Errorf("concurrent list failed: %v", err)
	}

	if got := parseCalls.Load(); got != 1 {
		t.Fatalf("concurrent parse calls = %d, want 1", got)
	}
}

func TestAICallLogIndexFallsBackWhenOverLimit(t *testing.T) {
	var parseCalls atomic.Int64
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
		MaxEntries: 2,
		ParseCount: func(_ string, _ int64) {
			parseCalls.Add(1)
		},
	})

	first := aiCallLogTestItem("first", "2026-10-28T10:00:00Z")
	second := aiCallLogTestItem("second", "2026-10-28T10:01:00Z")
	third := aiCallLogTestItem("third", "2026-10-28T10:02:00Z")
	second.RequestBody = "body-only-needle"
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", first, second, third)

	list := mustListAICallLogTestIndex(t, index, model.Query{PageSize: 20})
	if list.Total != 3 {
		t.Fatalf("over-limit total = %d, want 3", list.Total)
	}
	if got := parseCalls.Load(); got != 1 {
		t.Fatalf("over-limit indexed parse calls = %d, want 1", got)
	}

	list = mustListAICallLogTestIndex(t, index, model.Query{Keyword: "body-only-needle", PageSize: 20})
	if list.Total != 1 {
		t.Fatalf("over-limit keyword total = %d, want 1", list.Total)
	}
	if len(list.Items) != 1 || list.Items[0].ID != "second" {
		t.Fatalf("over-limit keyword items = %+v, want second", list.Items)
	}

	if _, found, err := index.get("second"); err != nil || !found {
		t.Fatalf("over-limit detail found=%v err=%v, want found=true err=nil", found, err)
	}
	if _, found, err := index.get("missing"); err != nil || found {
		t.Fatalf("over-limit missing detail found=%v err=%v, want found=false err=nil", found, err)
	}
}

func TestAICallLogIndexConcurrentOverLimitFallsBackWithoutErrors(t *testing.T) {
	for _, test := range []struct {
		name string
		run  func(index *aiCallLogIndex) error
	}{
		{
			name: "list",
			run: func(index *aiCallLogIndex) error {
				_, err := index.list(model.Query{PageSize: 20})
				return err
			},
		},
		{
			name: "detail",
			run: func(index *aiCallLogIndex) error {
				_, found, err := index.get("id-050")
				if err == nil && !found {
					return errors.New("detail unexpectedly not found")
				}
				return err
			},
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 2})
			items := make([]model.AICallLog, 100)
			for i := range items {
				items[i] = aiCallLogTestItem(fmt.Sprintf("id-%03d", i), "2026-10-28T10:00:00Z")
			}
			writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", items...)

			start := make(chan struct{})
			errs := make(chan error, 16)
			var wg sync.WaitGroup
			for range 16 {
				wg.Add(1)
				go func() {
					defer wg.Done()
					<-start
					errs <- test.run(index)
				}()
			}
			close(start)
			wg.Wait()
			close(errs)
			for err := range errs {
				if err != nil {
					t.Errorf("concurrent over-limit request failed: %v", err)
				}
			}
		})
	}
}

func TestAICallLogIndexSortsStableAndSearchesBodyFields(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})

	items := []model.AICallLog{
		{
			ID:          "id-a",
			UserID:      "body-user-a",
			RequestBody: "request NeEdLe",
			CreatedAt:   "2026-10-28T10:00:00Z",
		},
		{
			ID:           "id-b",
			UserID:       "body-user-b",
			ResponseBody: "response NeEdLe",
			CreatedAt:    "2026-10-28T10:00:00Z",
		},
		{
			ID:        "id-c",
			UserID:    "body-user-c",
			Error:     "error NeEdLe",
			CreatedAt: "2026-10-28T10:00:00Z",
		},
		{
			ID:          "id-m",
			UserID:      "clean-user-m",
			RequestBody: "clean body",
			CreatedAt:   "2026-10-28T10:00:00Z",
		},
		{
			ID:          "id-z",
			UserID:      "clean-user-z",
			RequestBody: "clean body",
			CreatedAt:   "2026-10-28T11:00:00Z",
		},
	}
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", items...)

	list := mustListAICallLogTestIndex(t, index, model.Query{PageSize: 20})
	if list.Total != len(items) {
		t.Fatalf("sorted total = %d, want %d", list.Total, len(items))
	}
	wantOrder := []string{"id-z", "id-m", "id-c", "id-b", "id-a"}
	if got := aiCallLogTestIDs(list.Items); !equalStrings(got, wantOrder) {
		t.Fatalf("stable order = %v, want %v", got, wantOrder)
	}

	list = mustListAICallLogTestIndex(t, index, model.Query{Keyword: " NEEDLE ", PageSize: 20})
	if list.Total != 3 {
		t.Fatalf("body-field keyword total = %d, want 3", list.Total)
	}
	wantKeywordOrder := []string{"id-c", "id-b", "id-a"}
	if got := aiCallLogTestIDs(list.Items); !equalStrings(got, wantKeywordOrder) {
		t.Fatalf("body-field keyword order = %v, want %v", got, wantKeywordOrder)
	}
}

func TestAICallLogIndexGetUsesOffsetsAndMissing(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})

	first := aiCallLogTestItem("offset-first", "2026-10-28T10:00:00Z")
	first.RequestBody = strings.Repeat("a", 2048)
	second := aiCallLogTestItem("offset-second", "2026-10-28T10:01:00Z")
	second.ResponseBody = "second exact detail"
	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", first, second)

	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 2 {
		t.Fatalf("offset fixture total = %d, want 2", got.Total)
	}
	content, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	lines := bytes.SplitAfter(content, []byte("\n"))

	index.mu.Lock()
	entries := append([]*aiCallLogEntry(nil), index.files[path].entries...)
	index.mu.Unlock()
	if len(entries) != 2 {
		t.Fatalf("indexed entries = %d, want 2", len(entries))
	}
	if entries[0].offset != 0 {
		t.Fatalf("first offset = %d, want 0", entries[0].offset)
	}
	if got, want := entries[1].offset, int64(len(lines[0])); got != want {
		t.Fatalf("second offset = %d, want %d", got, want)
	}
	if got, want := entries[1].length, int64(len(lines[1])); got != want {
		t.Fatalf("second length = %d, want %d", got, want)
	}

	item, found, err := index.get("offset-second")
	if err != nil || !found {
		t.Fatalf("detail found=%v err=%v, want found=true err=nil", found, err)
	}
	if item.ID != "offset-second" || item.ResponseBody != "second exact detail" {
		t.Fatalf("detail = %+v, want offset-second with exact response", item)
	}

	if _, found, err := index.get("does-not-exist"); err != nil || found {
		t.Fatalf("missing detail found=%v err=%v, want found=false err=nil", found, err)
	}
}

func TestAICallLogIndexOverLimitDoesNotRetainAllSummaries(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 2})
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
		aiCallLogTestItem("limit-a", "2026-10-28T10:00:00Z"),
		aiCallLogTestItem("limit-b", "2026-10-28T10:01:00Z"),
		aiCallLogTestItem("limit-c", "2026-10-28T10:02:00Z"),
	)

	list := mustListAICallLogTestIndex(t, index, model.Query{PageSize: 20})
	if list.Total != 3 {
		t.Fatalf("over-limit total = %d, want 3", list.Total)
	}

	total, largest := residentAICallLogEntries(index)
	if total > 2 {
		t.Fatalf("resident summaries = %d, want <= MaxEntries 2", total)
	}
	if largest > 2 {
		t.Fatalf("largest resident file entries = %d, want <= MaxEntries 2", largest)
	}
}

func residentAICallLogEntries(index *aiCallLogIndex) (total, largest int) {
	index.mu.Lock()
	defer index.mu.Unlock()
	for _, cached := range index.files {
		count := len(cached.entries)
		total += count
		if count > largest {
			largest = count
		}
	}
	return total, largest
}

func TestAICallLogIndexIgnoresUnterminatedJSON(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})
	unterminated := aiCallLogTestItem("unterminated", "2026-10-28T10:00:00Z")
	line := bytes.TrimSuffix(mustAICallLogLine(t, unterminated), []byte("\n"))
	writeAICallLogTestBytes(t, filepath.Join(dir, "ai-calls-2026-10-28.log"), line)

	list := mustListAICallLogTestIndex(t, index, model.Query{})
	if list.Total != 0 {
		t.Fatalf("unterminated list total = %d, want 0", list.Total)
	}
	if _, found, err := index.get("unterminated"); err != nil || found {
		t.Fatalf("unterminated detail found=%v err=%v, want found=false err=nil", found, err)
	}

	streamIndex, streamDir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 1})
	streamPath := filepath.Join(streamDir, "ai-calls-2026-10-28.log")
	content := append(mustAICallLogLine(t, aiCallLogTestItem("complete-a", "2026-10-28T10:00:00Z")),
		mustAICallLogLine(t, aiCallLogTestItem("complete-b", "2026-10-28T10:01:00Z"))...)
	content = append(content, line...)
	writeAICallLogTestBytes(t, streamPath, content)

	list = mustListAICallLogTestIndex(t, streamIndex, model.Query{PageSize: 20})
	if list.Total != 2 {
		t.Fatalf("stream list total = %d, want 2 complete records", list.Total)
	}
	if _, found, err := streamIndex.get("unterminated"); err != nil || found {
		t.Fatalf("stream unterminated detail found=%v err=%v, want found=false err=nil", found, err)
	}
}

func TestAICallLogIndexKeywordSearchesRawContent(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})
	base64Keyword := "QUJDREVGR0g"
	base64Response := `{"data":[{"b64_json":"` + strings.Repeat("A", 5000) + base64Keyword + `"}]}`
	errorKeyword := "REMOVEDERRORDETAIL"

	items := []model.AICallLog{
		{
			ID:           "raw-base64",
			ResponseBody: base64Response,
			CreatedAt:    "2026-10-28T10:00:00Z",
		},
		{
			ID:        "raw-error",
			Error:     `<div data-detail="` + errorKeyword + `"></div>`,
			CreatedAt: "2026-10-28T10:01:00Z",
		},
		{
			ID:        "clean",
			CreatedAt: "2026-10-28T10:02:00Z",
		},
	}
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", items...)

	list := mustListAICallLogTestIndex(t, index, model.Query{Keyword: base64Keyword, PageSize: 20})
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ID != "raw-base64" {
		t.Fatalf("raw base64 keyword result = %+v, want only raw-base64", list)
	}

	list = mustListAICallLogTestIndex(t, index, model.Query{Keyword: errorKeyword, PageSize: 20})
	if list.Total != 1 || len(list.Items) != 1 || list.Items[0].ID != "raw-error" {
		t.Fatalf("raw error keyword result = %+v, want only raw-error", list)
	}
}

func TestAICallLogIndexConcurrentRefreshDuringInvalidation(t *testing.T) {
	var parseCalls atomic.Int64
	firstStarted := make(chan struct{})
	secondStarted := make(chan struct{})
	releaseFirst := make(chan struct{})
	var firstOnce, secondOnce, releaseOnce sync.Once
	release := func() {
		releaseOnce.Do(func() {
			close(releaseFirst)
		})
	}

	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
		MaxEntries: 100,
		ParseCount: func(_ string, _ int64) {
			switch parseCalls.Add(1) {
			case 1:
				firstOnce.Do(func() {
					close(firstStarted)
				})
				<-releaseFirst
			case 2:
				secondOnce.Do(func() {
					close(secondStarted)
				})
			}
		},
	})
	t.Cleanup(release)

	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
		aiCallLogTestItem("old-record", "2026-10-28T10:00:00Z"))

	type listResult struct {
		list model.AICallLogList
		err  error
	}
	results := make(chan listResult, 9)
	runList := func() {
		list, err := index.list(model.Query{PageSize: 20})
		results <- listResult{list: list, err: err}
	}

	go runList()
	select {
	case <-firstStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for first index build")
	}

	index.invalidate(path)
	replacement := filepath.Join(dir, "replacement.log")
	writeAICallLogTestFile(t, dir, "replacement.log",
		aiCallLogTestItem("new-record", "2026-10-28T10:01:00Z"))
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}

	for i := 0; i < 8; i++ {
		go runList()
	}
	select {
	case <-secondStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("timed out waiting for replacement index build")
	}
	release()

	for i := 0; i < 9; i++ {
		select {
		case result := <-results:
			if result.err != nil {
				t.Fatalf("concurrent list failed: %v", result.err)
			}
			if result.list.Total != 1 || len(result.list.Items) != 1 || result.list.Items[0].ID != "new-record" {
				t.Fatalf("concurrent list result = %+v, want only new-record", result.list)
			}
		case <-time.After(3 * time.Second):
			t.Fatal("concurrent list did not finish; possible deadlock")
		}
	}

	if _, found, err := index.get("new-record"); err != nil || !found {
		t.Fatalf("new record after refresh found=%v err=%v, want found=true err=nil", found, err)
	}
	if _, found, err := index.get("old-record"); err != nil || found {
		t.Fatalf("old record after replacement found=%v err=%v, want found=false err=nil", found, err)
	}
}

func TestAICallLogIndexReplacementWithLargerSizeIsRebuilt(t *testing.T) {
	var parseCalls atomic.Int64
	var parsedBytes atomic.Int64
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
		MaxEntries: 100,
		ParseCount: func(_ string, size int64) {
			parseCalls.Add(1)
			parsedBytes.Add(size)
		},
	})

	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
		aiCallLogTestItem("old-inode", "2026-10-28T10:00:00Z"))
	if got := mustListAICallLogTestIndex(t, index, model.Query{}); got.Total != 1 {
		t.Fatalf("old inode total = %d, want 1", got.Total)
	}
	oldInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	replacement := filepath.Join(dir, "replacement.log")
	writeAICallLogTestFile(t, dir, "replacement.log",
		aiCallLogTestItem("new-inode-a", "2026-10-28T10:01:00Z"),
		aiCallLogTestItem("new-inode-b", "2026-10-28T10:02:00Z"),
		aiCallLogTestItem("new-inode-c", "2026-10-28T10:03:00Z"),
	)
	if err := os.Rename(replacement, path); err != nil {
		t.Fatal(err)
	}
	newInfo, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}

	list := mustListAICallLogTestIndex(t, index, model.Query{PageSize: 20})
	if list.Total != 3 {
		t.Fatalf("larger replacement total = %d, want 3", list.Total)
	}
	if got := parseCalls.Load(); got != 2 {
		t.Fatalf("larger replacement parse calls = %d, want 2", got)
	}
	if got, want := parsedBytes.Load(), oldInfo.Size()+newInfo.Size(); got != want {
		t.Fatalf("parsed bytes = %d, want old size + new size = %d", got, want)
	}
	if _, found, err := index.get("old-inode"); err != nil || found {
		t.Fatalf("old inode detail found=%v err=%v, want found=false err=nil", found, err)
	}
	if _, found, err := index.get("new-inode-c"); err != nil || !found {
		t.Fatalf("new inode detail found=%v err=%v, want found=true err=nil", found, err)
	}
}

func TestAICallLogIndexInPlaceRewriteToLargerFile(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})
	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
		aiCallLogTestItem("old", "2026-10-28T10:00:00Z"))
	mustListAICallLogTestIndex(t, index, model.Query{})
	before, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
		aiCallLogTestItem("rewritten-a", "2026-10-28T10:01:00Z"),
		aiCallLogTestItem("rewritten-b", "2026-10-28T10:02:00Z"))
	after, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	if !os.SameFile(before, after) || after.Size() <= before.Size() {
		t.Fatal("fixture must rewrite the same inode to a larger file")
	}
	list := mustListAICallLogTestIndex(t, index, model.Query{})
	if !equalStrings(aiCallLogTestIDs(list.Items), []string{"rewritten-b", "rewritten-a"}) || list.Total != 2 {
		t.Fatalf("in-place rewritten list = %+v", list)
	}
	if _, found, err := index.get("old"); err != nil || found {
		t.Fatalf("old in-place record found=%v err=%v", found, err)
	}
	if item, found, err := index.get("rewritten-a"); err != nil || !found || item.ID != "rewritten-a" {
		t.Fatalf("rewritten detail = %+v, found=%v err=%v", item, found, err)
	}
}

func TestAICallLogIndexStopsRetainingAtLimitAndStreamsPages(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 2})
	items := make([]model.AICallLog, 100)
	for i := range items {
		items[i] = aiCallLogTestItem(fmt.Sprintf("id-%03d", i), "2026-10-28T10:00:00Z")
		items[i].RequestBody = "body-only-needle"
	}
	path := writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", items...)
	info, err := os.Stat(path)
	if err != nil {
		t.Fatal(err)
	}
	entries, scanned, err := scanAICallLogFile(path, 0, info, 2)
	if !errors.Is(err, errAICallLogIndexLimit) || len(entries) != 2 || scanned >= info.Size() {
		t.Fatalf("bounded scan retained=%d scanned=%d size=%d err=%v", len(entries), scanned, info.Size(), err)
	}
	for _, keyword := range []string{"", "BODY-ONLY-NEEDLE"} {
		for _, page := range []int{1, 3, 21} {
			list := mustListAICallLogTestIndex(t, index, model.Query{Keyword: keyword, Page: page, PageSize: 5})
			start := (page - 1) * 5
			want := []string{}
			for i := start; i < min(start+5, len(items)); i++ {
				want = append(want, fmt.Sprintf("id-%03d", len(items)-1-i))
			}
			if list.Total != len(items) || !equalStrings(aiCallLogTestIDs(list.Items), want) {
				t.Fatalf("stream page=%d keyword=%q total=%d ids=%v want=%v", page, keyword, list.Total, aiCallLogTestIDs(list.Items), want)
			}
			if resident, _ := residentAICallLogEntries(index); resident > 2 {
				t.Fatalf("stream retained %d summaries, limit 2", resident)
			}
		}
	}
}

func TestAICallLogIndexSkipsOversizedLineAndContinues(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})
	large := aiCallLogTestItem("oversized", "2026-10-28T10:00:00Z")
	large.RequestBody = strings.Repeat("x", aiLogScannerMax)
	writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log", large,
		aiCallLogTestItem("visible", "2026-10-28T10:01:00Z"))
	list := mustListAICallLogTestIndex(t, index, model.Query{})
	if list.Total != 1 || list.Items[0].ID != "visible" {
		t.Fatalf("oversized line prevented subsequent records: %+v", list)
	}
	if _, found, err := index.get("visible"); err != nil || !found {
		t.Fatalf("detail after oversized line found=%v err=%v", found, err)
	}
}

func TestAICallLogIndexDetailRecoversFromConcurrentRemovalAndReplacement(t *testing.T) {
	for _, replace := range []bool{false, true} {
		t.Run(fmt.Sprintf("replace=%v", replace), func(t *testing.T) {
			var once sync.Once
			index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{
				MaxEntries: 100,
				BeforeRead: func(path string) {
					once.Do(func() {
						if replace {
							replacement := path + ".replacement"
							line := mustAICallLogLine(t, aiCallLogTestItem("replacement", "2026-10-28T10:01:00Z"))
							writeAICallLogTestBytes(t, replacement, line)
							if err := os.Rename(replacement, path); err != nil {
								t.Fatal(err)
							}
						} else if err := os.Remove(path); err != nil {
							t.Fatal(err)
						}
					})
				},
			})
			writeAICallLogTestFile(t, dir, "ai-calls-2026-10-28.log",
				aiCallLogTestItem("removed", "2026-10-28T10:00:00Z"))
			if _, found, err := index.get("removed"); err != nil || found {
				t.Fatalf("removed detail found=%v err=%v, want false/nil", found, err)
			}
			if replace {
				if item, found, err := index.get("replacement"); err != nil || !found || item.ID != "replacement" {
					t.Fatalf("replacement detail=%+v found=%v err=%v", item, found, err)
				}
			}
		})
	}
}

func TestAICallLogIndexRecordsAllFilesInInitialBuild(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 100})
	var size int64
	for i, day := range []string{"2026-10-27", "2026-10-28"} {
		path := writeAICallLogTestFile(t, dir, "ai-calls-"+day+".log",
			aiCallLogTestItem(fmt.Sprint(i), day+"T10:00:00Z"))
		info, err := os.Stat(path)
		if err != nil {
			t.Fatal(err)
		}
		size += info.Size()
	}
	var output bytes.Buffer
	previous := log.Writer()
	log.SetOutput(&output)
	t.Cleanup(func() { log.SetOutput(previous) })
	mustListAICallLogTestIndex(t, index, model.Query{})
	if !strings.Contains(output.String(), "files=2 entries=2") ||
		!strings.Contains(output.String(), fmt.Sprintf("size=%d", size)) {
		t.Fatalf("initial build did not describe all files: %s", output.String())
	}
	if index.lastBuild <= 0 {
		t.Fatal("initial build duration was not recorded")
	}
	output.Reset()
	mustListAICallLogTestIndex(t, index, model.Query{Page: 2, PageSize: 1})
	if output.Len() != 0 {
		t.Fatalf("unchanged query repeated initial build metric: %s", output.String())
	}
}

func TestAICallLogIndexStreamFallbackRejectsMissingFile(t *testing.T) {
	index, dir := newAICallLogTestIndex(t, aiCallLogIndexOptions{MaxEntries: 10})
	missing := filepath.Join(dir, "ai-calls-2026-10-28.log")

	list, err := index.streamList([]string{missing}, model.Query{Page: 1, PageSize: 20})
	if !errors.Is(err, errAICallLogChanged) {
		t.Fatalf("stream fallback error = %v, want errAICallLogChanged", err)
	}
	if list.Total != 0 || len(list.Items) != 0 {
		t.Fatalf("stream fallback returned data after file disappearance: %+v", list)
	}
}

func equalStrings(left, right []string) bool {
	if len(left) != len(right) {
		return false
	}
	for index := range left {
		if left[index] != right[index] {
			return false
		}
	}
	return true
}
