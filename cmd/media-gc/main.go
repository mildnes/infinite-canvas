package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

// media-gc is intentionally a review-only maintenance command. The service
// refuses destructive reclamation until browser-only and legacy references
// are globally observable.
func main() {
	limit := flag.Int("limit", 50, "最多检查的候选数量")
	flag.Parse()
	if *limit <= 0 {
		*limit = 50
	}
	if *limit > 500 {
		*limit = 500
	}
	if err := config.Load(); err != nil {
		fail(err)
	}
	if _, err := repository.DB(); err != nil {
		fail(err)
	}
	reports, err := service.ReviewDueMediaCleanup(*limit)
	if err != nil {
		fail(err)
	}
	if err := json.NewEncoder(os.Stdout).Encode(map[string]any{
		"mode":    "review-only",
		"count":   len(reports),
		"reports": reports,
	}); err != nil {
		fail(err)
	}
}

func fail(err error) {
	_, _ = fmt.Fprintf(os.Stderr, "media-gc: %v\n", err)
	os.Exit(1)
}
