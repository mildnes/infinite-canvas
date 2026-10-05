package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"sync"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	apply := flag.Bool("apply", false, "perform verified repairs; default is read-only dry-run")
	writesStopped := flag.Bool("writes-stopped", false, "confirm application writes have stopped before apply")
	limit := flag.Int("limit", 100, "maximum active objects in this batch (1-1000)")
	after := flag.String("after", "", "continue after this object ID")
	userID := flag.String("user-id", "", "inspect only this account")
	providerID := flag.String("provider-id", "", "inspect only this indexed provider")
	objectID := flag.String("object-id", "", "inspect only this object")
	workers := flag.Int("workers", 2, "parallel verification workers (1-6)")
	restoreRemoved := flag.Bool("restore-removed-local", false, "also refill deliberately removed local copies when the cloud is healthy")
	syncLocal := flag.Bool("sync-local", false, "explicitly promote local-generated objects to their allowed cloud provider")
	flag.Parse()
	if *limit < 1 || *limit > 1000 || *workers < 1 || *workers > 6 || (*apply && !*writesStopped) {
		fmt.Fprintln(os.Stderr, "invalid limit/workers, or apply requires -writes-stopped; no media was changed")
		os.Exit(2)
	}
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := repository.OpenExistingDatabase(!*apply); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	objects, err := repository.ListStorageObjectsForVerification(repository.StorageObjectFilter{After: *after, UserID: *userID, ProviderID: *providerID, ObjectID: *objectID, Limit: *limit})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	options := service.MediaVerifyOptions{Apply: *apply, WritesStopped: *writesStopped, RestoreRemovedLocal: *restoreRemoved, SyncLocal: *syncLocal}
	reports := make(chan service.MediaVerifyReport, *workers)
	jobs := make(chan int)
	var group sync.WaitGroup
	for i := 0; i < *workers; i++ {
		group.Add(1)
		go func() {
			defer group.Done()
			for index := range jobs {
				ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
				reports <- service.VerifyStorageMedia(ctx, objects[index], options)
				cancel()
			}
		}()
	}
	go func() {
		for index := range objects {
			jobs <- index
		}
		close(jobs)
		group.Wait()
		close(reports)
	}()
	encoder := json.NewEncoder(os.Stdout)
	counts := map[string]int{"verified": 0, "planned": 0, "repaired": 0, "failed": 0, "skipped": 0}
	var bytes int64
	localMissing, cloudMissing, doubleMissing := 0, 0, 0
	for report := range reports {
		counts[report.Status]++
		bytes += report.Bytes
		if report.BeforeLocalStatus == "missing" {
			localMissing++
		}
		if report.BeforeCloudStatus == "missing" {
			cloudMissing++
		}
		if report.BeforeLocalStatus == "missing" && report.BeforeCloudStatus == "missing" {
			doubleMissing++
		}
		if err := encoder.Encode(report); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
	}
	cursor := *after
	if len(objects) > 0 {
		cursor = objects[len(objects)-1].ID
	}
	if err := encoder.Encode(map[string]any{"type": "summary", "apply": *apply, "inspected": len(objects), "counts": counts, "bytes": bytes, "localMissing": localMissing, "cloudMissing": cloudMissing, "doubleMissing": doubleMissing, "nextCursor": cursor}); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if counts["failed"] > 0 {
		os.Exit(1)
	}
}
