// media-previews regenerates disposable previews without changing originals or DB rows.
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"os/signal"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	apply := flag.Bool("apply", false, "generate previews; default is read-only dry-run")
	after := flag.String("after", "", "resume after object ID returned as nextCursor")
	limit := flag.Int("limit", 500, "maximum objects scanned this batch (1-1000)")
	workers := flag.Int("workers", 2, "preview workers (1-2)")
	userID := flag.String("user", "", "filter owner")
	objectID := flag.String("object", "", "filter one object")
	flag.Parse()
	if *limit < 1 || *limit > 1000 || *workers < 1 || *workers > 2 {
		fmt.Fprintln(os.Stderr, "invalid limit/workers")
		os.Exit(2)
	}
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	// Even apply only writes cache files, so keep the DB read-only; no migrations.
	if err := repository.OpenExistingDatabase(true); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	objects, err := repository.ListStorageObjectsForVerification(repository.StorageObjectFilter{After: *after, UserID: *userID, ObjectID: *objectID, Limit: *limit})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	started := time.Now()
	defer cancel()
	jobs := make(chan int)
	reports := make(chan map[string]any, *workers)
	var group sync.WaitGroup
	for n := 0; n < *workers; n++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				jobStarted := time.Now()
				object := objects[index]
				report := map[string]any{"objectId": object.ID, "sourceBytes": object.Bytes, "status": "skipped"}
				if len(object.MimeType) >= 6 && object.MimeType[:6] == "image/" {
					if info, err := os.Stat(service.StoragePreviewPath(object.ID)); err == nil {
						report["status"], report["previewBytes"] = "existing", info.Size()
					} else if !*apply {
						report["status"], report["estimatedPreviewBytes"] = "candidate", 300<<10
					} else {
						jobCtx, stop := context.WithTimeout(ctx, 6*time.Minute)
						bytes, err := service.GenerateStoragePreview(jobCtx, object.ID)
						stop()
						if err != nil {
							report["status"], report["error"] = "failed", err.Error()
						} else {
							report["status"], report["previewBytes"] = "generated", bytes
						}
					}
				}
				report["index"] = index
				report["durationMs"] = time.Since(jobStarted).Milliseconds()
				reports <- report
			}
		}()
	}
	go func() {
		defer close(jobs)
		for index := range objects {
			select {
			case jobs <- index:
			case <-ctx.Done():
				return
			}
		}
	}()
	go func() { group.Wait(); close(reports) }()
	encoder := json.NewEncoder(os.Stdout)
	completed := make([]bool, len(objects))
	failed, candidates := 0, 0
	for report := range reports {
		index := report["index"].(int)
		completed[index] = true
		delete(report, "index")
		if report["status"] == "failed" {
			failed++
		}
		if report["status"] == "candidate" {
			candidates++
		}
		_ = encoder.Encode(report)
	}
	cursor := *after
	for index, done := range completed {
		if !done {
			break
		}
		cursor = objects[index].ID
	}
	_ = encoder.Encode(map[string]any{"summary": true, "apply": *apply, "scanned": len(objects), "candidates": candidates, "failed": failed, "nextCursor": cursor, "estimatedPreviewBytes": candidates * (300 << 10), "estimateOnly": !*apply, "estimatedSeconds": nil, "durationMs": time.Since(started).Milliseconds(), "interrupted": ctx.Err() != nil})
	if failed > 0 || ctx.Err() != nil {
		os.Exit(1)
	}
}
