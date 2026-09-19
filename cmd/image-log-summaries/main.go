package main

import (
	"encoding/json"
	"flag"
	"fmt"
	"os"

	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/service"
)

func main() {
	apply := flag.Bool("apply", false, "persist list summaries; default is a preview")
	limit := flag.Int("limit", 10, "legacy logs to inspect, 1-100")
	after := flag.String("after", "", "continue after this log ID")
	flag.Parse()
	if err := config.Load(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	result, err := service.BackfillImageLogSummaries(*after, *limit, *apply)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	if err := json.NewEncoder(os.Stdout).Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
