package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/repository"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	apply := flag.Bool("apply", false, "persist verified media and update canvas references; default is dry-run")
	writesStopped := flag.Bool("writes-stopped", false, "confirm application writes are stopped before apply")
	limit := flag.Int("limit", 100, "maximum active canvas projects to inspect (1-1000)")
	afterUser := flag.String("after-user", "", "continue after this user ID")
	afterCanvas := flag.String("after-canvas", "", "continue after this canvas ID within after-user")
	flag.Parse()
	if *limit < 1 || *limit > 1000 || (*apply && !*writesStopped) {
		fmt.Fprintln(os.Stderr, "invalid limit, or apply requires -writes-stopped; no canvas was changed")
		os.Exit(2)
	}
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	projects, err := repository.ListCanvasProjectsForMediaRepair(*afterUser, *afterCanvas, *limit)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	total, succeeded, failed := 0, 0, 0
	for _, project := range projects {
		reports, repairErr := service.RepairCanvasProjectMedia(context.Background(), project, *apply)
		if repairErr != nil {
			fmt.Fprintf(os.Stderr, "canvas %s: %v\n", project.ID, repairErr)
			failed++
			continue
		}
		for _, report := range reports {
			total++
			if report.Status == "failed" {
				failed++
			} else {
				succeeded++
			}
			_ = encoder.Encode(report)
		}
	}
	_ = encoder.Encode(map[string]any{"mode": map[bool]string{true: "apply", false: "dry-run"}[*apply], "projects": len(projects), "candidates": total, "succeeded": succeeded, "failed": failed})
	if failed > 0 {
		os.Exit(1)
	}
}
