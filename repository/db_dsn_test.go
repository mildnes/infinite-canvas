package repository

import (
	"database/sql"
	"net/url"
	"path/filepath"
	"reflect"
	"runtime"
	"strings"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
)

func TestPrepareSQLiteDSN(t *testing.T) {
	tests := []struct {
		name        string
		dsn         string
		wantPath    string
		wantPragmas []string
		wantCache   string
	}{
		{
			name:        "plain file",
			dsn:         "data/x.db",
			wantPath:    "data/x.db",
			wantPragmas: []string{"journal_mode(WAL)"},
		},
		{
			name:        "preserve existing query parameters",
			dsn:         "data/x.db?_pragma=busy_timeout(5000)&cache=shared&_txlock=deferred",
			wantPath:    "data/x.db",
			wantPragmas: []string{"busy_timeout(5000)", "journal_mode(WAL)"},
			wantCache:   "shared",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got, err := prepareSQLiteDSN(tt.dsn)
			if err != nil {
				t.Fatal(err)
			}
			t.Logf("rewritten DSN: %s", got)
			path, rawQuery, _ := strings.Cut(got, "?")
			if path != tt.wantPath {
				t.Fatalf("path = %q, want %q", path, tt.wantPath)
			}
			params, err := url.ParseQuery(rawQuery)
			if err != nil {
				t.Fatal(err)
			}
			if !reflect.DeepEqual(params["_pragma"], tt.wantPragmas) {
				t.Fatalf("_pragma = %#v, want %#v", params["_pragma"], tt.wantPragmas)
			}
			if got := params.Get("_txlock"); got != "immediate" {
				t.Fatalf("_txlock = %q, want immediate", got)
			}
			if tt.wantCache != "" && params.Get("cache") != tt.wantCache {
				t.Fatalf("cache = %q, want %q", params.Get("cache"), tt.wantCache)
			}
		})
	}
}

func TestPrepareSQLiteDSNIsIdempotent(t *testing.T) {
	first, err := prepareSQLiteDSN("data/x.db?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	second, err := prepareSQLiteDSN(first)
	if err != nil {
		t.Fatal(err)
	}
	if second != first {
		t.Fatalf("second rewrite = %q, want %q", second, first)
	}
	params, err := url.ParseQuery(strings.SplitN(second, "?", 2)[1])
	if err != nil {
		t.Fatal(err)
	}
	if len(params["_pragma"]) != 2 {
		t.Fatalf("_pragma = %#v, want busy_timeout plus one journal_mode", params["_pragma"])
	}
}

func TestPrepareSQLiteDSNPreservesMemoryDSN(t *testing.T) {
	for _, dsn := range []string{
		":memory:",
		"file::memory:?cache=shared",
		"file:test.db?mode=memory&cache=shared",
	} {
		got, err := prepareSQLiteDSN(dsn)
		if err != nil {
			t.Fatal(err)
		}
		t.Logf("memory DSN: %q -> %q", dsn, got)
		if got != dsn {
			t.Errorf("prepareSQLiteDSN(%q) = %q, want unchanged", dsn, got)
		}
	}
}

func TestGORMOpenRealFileSQLite(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("Linux gate: production SQLite file and WAL verification runs in the Go 1.25 container")
	}

	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	path := filepath.Join(t.TempDir(), "gorm.db")
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", path
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	t.Cleanup(func() {
		if db != nil {
			connection, _ := db.DB()
			_ = connection.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})

	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	sqliteDialector, ok := database.Config.Dialector.(*sqlite.Dialector)
	if !ok {
		t.Fatalf("dialector type = %T, want *sqlite.Dialector", database.Config.Dialector)
	}
	rewritten, err := prepareSQLiteDSN(path)
	if err != nil {
		t.Fatal(err)
	}
	if sqliteDialector.DSN != rewritten {
		t.Fatalf("GORM DSN = %q, want %q", sqliteDialector.DSN, rewritten)
	}

	var journalMode string
	if err := database.Raw("PRAGMA journal_mode").Scan(&journalMode).Error; err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(journalMode, "wal") {
		t.Fatalf("journal_mode = %q, want wal", journalMode)
	}
}

func TestPrepareSQLiteDSNAppliesWALAndBusyTimeout(t *testing.T) {
	dsn, err := prepareSQLiteDSN(filepath.Join(t.TempDir(), "pragmas.db") + "?_pragma=busy_timeout(5000)")
	if err != nil {
		t.Fatal(err)
	}
	database, err := sql.Open("sqlite", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = database.Close() })

	var journalMode string
	if err := database.QueryRow("PRAGMA journal_mode").Scan(&journalMode); err != nil {
		t.Fatal(err)
	}
	if !strings.EqualFold(journalMode, "wal") {
		t.Fatalf("journal_mode = %q, want wal", journalMode)
	}
	var busyTimeout int
	if err := database.QueryRow("PRAGMA busy_timeout").Scan(&busyTimeout); err != nil {
		t.Fatal(err)
	}
	if busyTimeout != 5000 {
		t.Fatalf("busy_timeout = %d, want 5000", busyTimeout)
	}
}
