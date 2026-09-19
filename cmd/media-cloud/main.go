package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"
	"time"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	mode := flag.String("mode", "sync", "sync old local media to configured cloud, or cleanup verified local copies")
	apply := flag.Bool("apply", false, "perform writes; default is read-only dry-run")
	limit := flag.Int("limit", 50, "maximum objects to inspect (1-500)")
	after := flag.String("after", "", "continue after this object ID")
	minAge := flag.Int("min-age-days", 30, "minimum days after successful cloud synchronization before cleanup (at least 7)")
	backupConfirmed := flag.Bool("backup-confirmed", false, "confirm media directory has an independently verified backup before cleanup")
	flag.Parse()
	if (*mode != "sync" && *mode != "cleanup") || *limit < 1 || *limit > 500 || *minAge < 7 {
		fmt.Fprintln(os.Stderr, "invalid mode, limit or retention period")
		os.Exit(2)
	}
	if *mode == "cleanup" && *apply && !*backupConfirmed {
		fmt.Fprintln(os.Stderr, "cleanup requires -backup-confirmed; no file was removed")
		os.Exit(2)
	}
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var objects []model.StorageObject
	var err error
	if *mode == "sync" {
		objects, err = repository.ListLocalGeneratedObjects(*after, *limit)
	} else {
		cutoff := time.Now().UTC().Add(-time.Duration(*minAge) * 24 * time.Hour).Format(time.RFC3339Nano)
		objects, err = repository.ListGeneratedCloudCopies(*after, cutoff, *limit)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	summary := struct {
		Mode       string `json:"mode"`
		Apply      bool   `json:"apply"`
		Inspected  int    `json:"inspected"`
		Succeeded  int    `json:"succeeded"`
		Failed     int    `json:"failed"`
		Bytes      int64  `json:"bytes"`
		NextCursor string `json:"nextCursor"`
	}{Mode: *mode, Apply: *apply}
	for _, object := range objects {
		summary.Inspected++
		summary.Bytes += object.Bytes
		summary.NextCursor = object.ID
		if !*apply {
			continue
		}
		if *mode == "sync" {
			var user model.User
			var found bool
			user, found, err = repository.GetUserByID(object.CreatedBy)
			if err == nil && !found {
				err = fmt.Errorf("对象所属账号不存在")
			}
			if err == nil {
				err = service.PromoteGeneratedMedia(service.WithUser(context.Background(), model.PublicUser(user)), object.ID)
			}
		} else {
			err = service.RemoveVerifiedGeneratedCopy(object.ID, time.Duration(*minAge)*24*time.Hour)
		}
		if err != nil {
			summary.Failed++
			fmt.Fprintf(os.Stderr, "object %s: %v\n", object.ID, err)
		} else {
			summary.Succeeded++
		}
	}
	if err := json.NewEncoder(os.Stdout).Encode(summary); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if summary.Failed > 0 {
		os.Exit(1)
	}
}
