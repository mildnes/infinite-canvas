package service

import (
	"bufio"
	"bytes"
	"container/heap"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"io"
	"log"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/model"
)

const defaultAICallLogIndexLimit = 200_000
const aiCallLogRefreshAttempts = 3

var (
	errAICallLogChanged    = errors.New("ai call log changed during read")
	errAICallLogIndexLimit = errors.New("ai call log index limit exceeded")
)

type aiCallLogIndexOptions struct {
	MaxEntries int
	ParseCount func(file string, bytes int64)
	BeforeRead func(file string)
}

type aiCallLogEntry struct {
	filePath string
	fileInfo os.FileInfo
	offset   int64
	length   int64
	summary  model.AICallLogSummary
}

type aiCallLogFileIndex struct {
	size        int64
	mtime       time.Time
	fileInfo    os.FileInfo
	offset      int64
	entries     []*aiCallLogEntry
	fingerprint [sha256.Size]byte
	rebuilding  bool
	overLimit   bool
	ready       chan struct{}
}

type aiCallLogIndex struct {
	mu    sync.Mutex
	files map[string]*aiCallLogFileIndex

	optionsMu sync.RWMutex
	options   aiCallLogIndexOptions

	lastBuildOnce sync.Once
	lastBuild     time.Duration
}

var defaultAICallLogIndex = newAICallLogIndex(aiCallLogIndexOptions{MaxEntries: defaultAICallLogIndexLimit})

func newAICallLogIndex(options aiCallLogIndexOptions) *aiCallLogIndex {
	if options.MaxEntries <= 0 {
		options.MaxEntries = defaultAICallLogIndexLimit
	}
	return &aiCallLogIndex{files: map[string]*aiCallLogFileIndex{}, options: options}
}

func (index *aiCallLogIndex) setOptions(options aiCallLogIndexOptions) {
	index.optionsMu.Lock()
	defer index.optionsMu.Unlock()
	index.options = options
	if index.options.MaxEntries <= 0 {
		index.options.MaxEntries = defaultAICallLogIndexLimit
	}
}

func (index *aiCallLogIndex) snapshotOptions() aiCallLogIndexOptions {
	index.optionsMu.RLock()
	defer index.optionsMu.RUnlock()
	return index.options
}

func invalidateAICallLogFile(filePath string) {
	defaultAICallLogIndex.invalidate(filePath)
}

func (index *aiCallLogIndex) invalidate(filePath string) {
	index.mu.Lock()
	if cached := index.files[filePath]; cached != nil {
		finishAICallLogRefreshLocked(cached)
	}
	delete(index.files, filePath)
	index.mu.Unlock()
}

func finishAICallLogRefreshLocked(cached *aiCallLogFileIndex) {
	cached.rebuilding = false
	if cached.ready != nil {
		close(cached.ready)
		cached.ready = nil
	}
}

func listIndexedAICallLogs(q model.Query) (model.AICallLogList, error) {
	return defaultAICallLogIndex.list(q)
}

func indexedAICallLog(id string) (model.AICallLog, bool, error) {
	return defaultAICallLogIndex.get(id)
}

func (index *aiCallLogIndex) list(q model.Query) (model.AICallLogList, error) {
	started := time.Now()
	q.Normalize()
	files, err := aiLogFiles()
	if err != nil {
		return model.AICallLogList{}, err
	}
	current := make(map[string]bool, len(files))
	all := make([]*aiCallLogEntry, 0)
	overLimit := false
	options := index.snapshotOptions()
	for _, file := range files {
		current[file] = true
		entries, err := index.refresh(file)
		if errors.Is(err, errAICallLogIndexLimit) {
			overLimit = true
			break
		}
		if err != nil {
			return model.AICallLogList{}, err
		}
		all = append(all, entries...)
		if len(all) > options.MaxEntries {
			index.markFileOverLimit(file)
			overLimit = true
			break
		}
	}
	index.prune(current)
	if overLimit {
		log.Printf("ai call log index exceeded max entries=%d; falling back to streaming scan", options.MaxEntries)
		result, err := index.streamList(files, q)
		if err == nil {
			index.recordBuildDuration(started, files, result.Total)
		}
		return result, err
	}
	index.recordBuildDuration(started, files, len(all))

	keyword := strings.ToLower(strings.TrimSpace(q.Keyword))
	if keyword != "" {
		all, err = index.filterKeyword(all, keyword)
		if err != nil {
			return model.AICallLogList{}, err
		}
	}
	index.sortEntries(all)
	return index.page(all, q), nil
}

func (index *aiCallLogIndex) refresh(filePath string) ([]*aiCallLogEntry, error) {
	for attempt := 0; attempt < aiCallLogRefreshAttempts; attempt++ {
		info, err := os.Stat(filePath)
		if err != nil {
			if errors.Is(err, os.ErrNotExist) {
				index.invalidate(filePath)
				return nil, nil
			}
			return nil, err
		}

		index.mu.Lock()
		cached := index.files[filePath]
		sameFile := cached != nil && cached.fileInfo != nil && os.SameFile(cached.fileInfo, info)
		if cached != nil && sameFile && cached.size == info.Size() && cached.mtime.Equal(info.ModTime()) && !cached.rebuilding {
			if cached.overLimit {
				index.mu.Unlock()
				return nil, errAICallLogIndexLimit
			}
			entries := append([]*aiCallLogEntry(nil), cached.entries...)
			index.mu.Unlock()
			return entries, nil
		}
		if cached != nil && cached.rebuilding {
			wait := cached.ready
			index.mu.Unlock()
			<-wait
			continue
		}
		appendOnly := cached != nil && !cached.overLimit && sameFile && info.Size() > cached.size && !cached.rebuilding
		if !appendOnly {
			cached = &aiCallLogFileIndex{size: info.Size(), mtime: info.ModTime()}
		}
		cached.rebuilding = true
		cached.ready = make(chan struct{})
		index.files[filePath] = cached
		offset := cached.offset
		fingerprint := cached.fingerprint
		baseEntries := cached.entries
		index.mu.Unlock()

		options := index.snapshotOptions()
		if appendOnly && offset > 0 {
			current, checkErr := aiCallLogFingerprint(filePath, offset, info)
			if checkErr != nil {
				err = checkErr
			} else if current != fingerprint {
				// An in-place truncate/rewrite can keep the inode and grow in size.
				offset, baseEntries = 0, nil
			}
		}
		var entries []*aiCallLogEntry
		newOffset := offset
		if err == nil {
			entries, newOffset, err = scanAICallLogFile(filePath, offset, info, options.MaxEntries-len(baseEntries))
			if options.ParseCount != nil {
				options.ParseCount(filePath, newOffset-offset)
			}
		}
		if err == nil {
			fingerprint, err = aiCallLogFingerprint(filePath, newOffset, info)
		}
		index.mu.Lock()
		installed := index.files[filePath] == cached
		if installed && err == nil {
			resident := len(baseEntries) + len(entries)
			for path, other := range index.files {
				if path != filePath {
					resident += len(other.entries)
				}
			}
			if resident > options.MaxEntries {
				err = errAICallLogIndexLimit
			}
		}
		if installed && err == nil {
			cached.entries = append(baseEntries, entries...)
			cached.size = info.Size()
			cached.mtime = info.ModTime()
			cached.fileInfo = info
			cached.offset = newOffset
			cached.fingerprint = fingerprint
			cached.overLimit = false
		}
		if installed && errors.Is(err, errAICallLogIndexLimit) {
			cached.entries = nil
			cached.size = info.Size()
			cached.mtime = info.ModTime()
			cached.fileInfo = info
			cached.offset = 0
			cached.fingerprint = [sha256.Size]byte{}
			cached.overLimit = true
		}
		cached.rebuilding = false
		if cached.ready != nil {
			close(cached.ready)
			cached.ready = nil
		}
		if installed && err != nil && !errors.Is(err, errAICallLogIndexLimit) {
			delete(index.files, filePath)
		}
		index.mu.Unlock()
		if err != nil {
			if !installed || errors.Is(err, errAICallLogChanged) {
				if attempt+1 == aiCallLogRefreshAttempts {
					break
				}
				continue
			}
			return nil, err
		}
		if !installed {
			if attempt+1 == aiCallLogRefreshAttempts {
				break
			}
			continue
		}
		return index.snapshotEntries(filePath), nil
	}
	return nil, errAICallLogChanged
}

func (index *aiCallLogIndex) snapshotEntries(filePath string) []*aiCallLogEntry {
	index.mu.Lock()
	defer index.mu.Unlock()
	cached := index.files[filePath]
	if cached == nil {
		return nil
	}
	return append([]*aiCallLogEntry(nil), cached.entries...)
}

func (index *aiCallLogIndex) recordBuildDuration(start time.Time, files []string, entries int) {
	index.lastBuildOnce.Do(func() {
		elapsed := time.Since(start)
		var size int64
		for _, path := range files {
			if info, err := os.Stat(path); err == nil {
				size += info.Size()
			}
		}
		index.mu.Lock()
		index.lastBuild = elapsed
		index.mu.Unlock()
		log.Printf("ai call log index initial build files=%d entries=%d elapsed=%s size=%d", len(files), entries, elapsed, size)
	})
}

func scanAICallLogFile(filePath string, offset int64, info os.FileInfo, limit int) ([]*aiCallLogEntry, int64, error) {
	entries := make([]*aiCallLogEntry, 0)
	next, err := walkAICallLogFile(filePath, offset, info, func(line []byte, position int64, length int64) error {
		var item model.AICallLogSummary
		if json.Unmarshal(line, &item) != nil {
			return nil
		}
		if len(entries) >= limit {
			return errAICallLogIndexLimit
		}
		entries = append(entries, &aiCallLogEntry{
			filePath: filePath, fileInfo: info, offset: position, length: length, summary: item,
		})
		return nil
	})
	return entries, next, err
}

func aiCallLogFingerprint(filePath string, offset int64, expected os.FileInfo) ([sha256.Size]byte, error) {
	var fingerprint [sha256.Size]byte
	if offset == 0 {
		return fingerprint, nil
	}
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			err = errAICallLogChanged
		}
		return fingerprint, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return fingerprint, err
	}
	if !os.SameFile(expected, info) || info.Size() < offset {
		return fingerprint, errAICallLogChanged
	}
	size := min(offset, 256)
	edges := make([]byte, size*2)
	if _, err := file.ReadAt(edges[:size], 0); err != nil {
		return fingerprint, err
	}
	if _, err := file.ReadAt(edges[size:], offset-size); err != nil {
		return fingerprint, err
	}
	return sha256.Sum256(edges), nil
}

func walkAICallLogFile(filePath string, offset int64, expected os.FileInfo, visit func([]byte, int64, int64) error) (int64, error) {
	file, err := os.Open(filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			err = errAICallLogChanged
		}
		return offset, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return offset, err
	}
	if expected != nil && (!os.SameFile(expected, info) || info.Size() < expected.Size()) {
		return offset, errAICallLogChanged
	}
	end := info.Size()
	if expected != nil {
		end = expected.Size()
	}
	reader := bufio.NewReaderSize(io.NewSectionReader(file, offset, max(0, end-offset)), 64*1024)
	current, lineStart := offset, offset
	var line []byte
	oversized := false
	for {
		fragment, err := reader.ReadSlice('\n')
		current += int64(len(fragment))
		if !oversized && len(line)+len(fragment) <= aiLogScannerMax {
			line = append(line, fragment...)
		} else {
			oversized, line = true, nil
		}
		if errors.Is(err, bufio.ErrBufferFull) {
			continue
		}
		if errors.Is(err, io.EOF) {
			// A final line without a newline is still being written.
			return lineStart, nil
		}
		if err != nil {
			return lineStart, err
		}
		if !oversized {
			if err := visit(bytes.TrimSpace(line), lineStart, current-lineStart); err != nil {
				return current, err
			}
		}
		line, oversized, lineStart = line[:0], false, current
	}
}

func (index *aiCallLogIndex) get(id string) (model.AICallLog, bool, error) {
	id = strings.TrimSpace(id)
	if id == "" {
		return model.AICallLog{}, false, nil
	}
	for attempt := 0; attempt < 2; attempt++ {
		files, err := aiLogFiles()
		if err != nil {
			return model.AICallLog{}, false, err
		}
		retry := false
		for _, file := range files {
			entries, err := index.refresh(file)
			if errors.Is(err, errAICallLogIndexLimit) {
				log.Printf("ai call log index exceeded max entries=%d; falling back to streaming scan", index.snapshotOptions().MaxEntries)
				for _, fallbackFile := range files {
					item, found, err := streamFindAICallLog(fallbackFile, id)
					if err != nil || found {
						return item, found, err
					}
				}
				return model.AICallLog{}, false, nil
			}
			if err != nil {
				return model.AICallLog{}, false, err
			}
			for _, entry := range entries {
				if entry.summary.ID != id {
					continue
				}
				if beforeRead := index.snapshotOptions().BeforeRead; beforeRead != nil {
					beforeRead(file)
				}
				item, err := readAICallLogEntry(entry)
				if errors.Is(err, errAICallLogChanged) {
					index.invalidate(file)
					retry = true
					break
				}
				return item, err == nil, err
			}
			if retry {
				break
			}
		}
		if !retry {
			return model.AICallLog{}, false, nil
		}
	}
	return model.AICallLog{}, false, nil
}

func readAICallLogEntry(entry *aiCallLogEntry) (model.AICallLog, error) {
	item, err := readAICallLogEntryRaw(entry)
	if err != nil {
		return model.AICallLog{}, err
	}
	return normalizeAICallLogDetail(item), nil
}

func readAICallLogEntryRaw(entry *aiCallLogEntry) (model.AICallLog, error) {
	file, err := os.Open(entry.filePath)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			err = errAICallLogChanged
		}
		return model.AICallLog{}, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil {
		return model.AICallLog{}, err
	}
	if !os.SameFile(entry.fileInfo, info) || info.Size() < entry.offset+entry.length {
		return model.AICallLog{}, errAICallLogChanged
	}
	data := make([]byte, entry.length)
	n, err := file.ReadAt(data, entry.offset)
	if n != len(data) {
		return model.AICallLog{}, errAICallLogChanged
	}
	if err != nil {
		return model.AICallLog{}, err
	}
	var item model.AICallLog
	if err := json.Unmarshal(bytes.TrimSpace(data), &item); err != nil || item.ID != entry.summary.ID {
		return model.AICallLog{}, errAICallLogChanged
	}
	return item, nil
}

func streamFindAICallLog(filePath string, id string) (model.AICallLog, bool, error) {
	var result model.AICallLog
	found := false
	_, err := walkAICallLogFile(filePath, 0, nil, func(line []byte, _, _ int64) error {
		var item model.AICallLog
		if json.Unmarshal(line, &item) == nil && item.ID == id {
			result, found = item, true
			return io.EOF
		}
		return nil
	})
	if found {
		return normalizeAICallLogDetail(result), true, nil
	}
	return result, false, err
}

func (index *aiCallLogIndex) filterKeyword(entries []*aiCallLogEntry, keyword string) ([]*aiCallLogEntry, error) {
	result := make([]*aiCallLogEntry, 0, len(entries))
	for _, entry := range entries {
		summary := entry.summary
		text := strings.Join([]string{
			summary.UserID, summary.UserDisplayName, summary.Endpoint, summary.Method,
			summary.Model, summary.ChannelID, summary.ChannelName, strconv.Itoa(summary.Status),
		}, "\x00")
		if strings.Contains(strings.ToLower(text), keyword) {
			result = append(result, entry)
			continue
		}
		item, err := readAICallLogEntryRaw(entry)
		if err != nil {
			if errors.Is(err, errAICallLogChanged) {
				index.invalidate(entry.filePath)
			}
			return nil, err
		}
		if aiLogMatchesKeyword(item, keyword) {
			result = append(result, entry)
			continue
		}
	}
	return result, nil
}

func (index *aiCallLogIndex) sortEntries(entries []*aiCallLogEntry) {
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].summary.CreatedAt != entries[j].summary.CreatedAt {
			return entries[i].summary.CreatedAt > entries[j].summary.CreatedAt
		}
		return entries[i].summary.ID > entries[j].summary.ID
	})
}

func (index *aiCallLogIndex) page(entries []*aiCallLogEntry, q model.Query) model.AICallLogList {
	total := len(entries)
	start := q.Offset()
	if start >= total {
		return model.AICallLogList{Items: []model.AICallLogSummary{}, Total: total}
	}
	end := start + q.PageSize
	if end > total {
		end = total
	}
	items := make([]model.AICallLogSummary, 0, end-start)
	for _, entry := range entries[start:end] {
		items = append(items, entry.summary)
	}
	return model.AICallLogList{Items: items, Total: total}
}

type aiCallLogSummaryHeap []model.AICallLogSummary

func newerAICallLog(a, b model.AICallLogSummary) bool {
	if a.CreatedAt != b.CreatedAt {
		return a.CreatedAt > b.CreatedAt
	}
	return a.ID > b.ID
}

func (h aiCallLogSummaryHeap) Len() int           { return len(h) }
func (h aiCallLogSummaryHeap) Less(i, j int) bool { return newerAICallLog(h[j], h[i]) }
func (h aiCallLogSummaryHeap) Swap(i, j int)      { h[i], h[j] = h[j], h[i] }
func (h *aiCallLogSummaryHeap) Push(value any)    { *h = append(*h, value.(model.AICallLogSummary)) }
func (h *aiCallLogSummaryHeap) Pop() any {
	last := len(*h) - 1
	value := (*h)[last]
	*h = (*h)[:last]
	return value
}

func (index *aiCallLogIndex) streamList(files []string, q model.Query) (model.AICallLogList, error) {
	keyword := strings.ToLower(strings.TrimSpace(q.Keyword))
	matches := &aiCallLogSummaryHeap{}
	total, keep := 0, q.Offset()+q.PageSize
	for _, file := range files {
		_, err := walkAICallLogFile(file, 0, nil, func(line []byte, _, _ int64) error {
			var summary model.AICallLogSummary
			if keyword != "" {
				var item model.AICallLog
				if json.Unmarshal(line, &item) != nil || !aiLogMatchesKeyword(item, keyword) {
					return nil
				}
				summary = item.Summary()
			} else if json.Unmarshal(line, &summary) != nil {
				return nil
			}
			total++
			if matches.Len() < keep {
				heap.Push(matches, summary)
			} else if keep > 0 && newerAICallLog(summary, (*matches)[0]) {
				(*matches)[0] = summary
				heap.Fix(matches, 0)
			}
			return nil
		})
		if err != nil {
			return model.AICallLogList{}, err
		}
	}
	sort.Slice(*matches, func(i, j int) bool {
		return newerAICallLog((*matches)[i], (*matches)[j])
	})
	start := q.Offset()
	if start >= total {
		return model.AICallLogList{Items: []model.AICallLogSummary{}, Total: total}, nil
	}
	return model.AICallLogList{Items: (*matches)[start:], Total: total}, nil
}

func (index *aiCallLogIndex) prune(current map[string]bool) {
	index.mu.Lock()
	defer index.mu.Unlock()
	for file := range index.files {
		if !current[file] {
			finishAICallLogRefreshLocked(index.files[file])
			delete(index.files, file)
		}
	}
}

func (index *aiCallLogIndex) markFileOverLimit(filePath string) {
	index.mu.Lock()
	cached := index.files[filePath]
	if cached != nil && !cached.rebuilding {
		cached.entries = nil
		cached.overLimit = true
	}
	index.mu.Unlock()
}

func aiCallLogIndexDiagnostics() (time.Duration, int) {
	defaultAICallLogIndex.mu.Lock()
	defer defaultAICallLogIndex.mu.Unlock()
	return defaultAICallLogIndex.lastBuild, len(defaultAICallLogIndex.files)
}
