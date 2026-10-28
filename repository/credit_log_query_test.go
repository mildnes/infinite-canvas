package repository

import (
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

const creditLogQueryIndex = "idx_credit_logs_created_at_id"

func prepareCreditLogQueryDB(t *testing.T, existing bool) *gorm.DB {
	t.Helper()
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	path := filepath.Join(t.TempDir(), "credit-logs.db")
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", path
	if existing {
		seed, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
		if err != nil {
			t.Fatal(err)
		}
		if err := seed.AutoMigrate(&model.CreditLog{}); err != nil {
			t.Fatal(err)
		}
		if seed.Migrator().HasIndex(&model.CreditLog{}, creditLogQueryIndex) {
			if err := seed.Migrator().DropIndex(&model.CreditLog{}, creditLogQueryIndex); err != nil {
				t.Fatal(err)
			}
		}
		log := model.CreditLog{
			ID: "existing", UserID: "owner", Type: model.CreditLogTypeAIConsume,
			Amount: -1.25, Balance: 8.75, RelatedID: "task", Remark: "kept",
			Extra: `{"kept":true}`, CreatedAt: "2026-10-28T10:00:00Z",
		}
		if err := seed.Create(&log).Error; err != nil {
			t.Fatal(err)
		}
		connection, err := seed.DB()
		if err != nil {
			t.Fatal(err)
		}
		if err := connection.Close(); err != nil {
			t.Fatal(err)
		}
	}
	initialized, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		connection, err := initialized.DB()
		if err == nil {
			_ = connection.Close()
		}
		config.Cfg = previousConfig
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})
	return initialized
}

func TestCreditLogQueryIndex(t *testing.T) {
	for _, existing := range []bool{false, true} {
		t.Run(fmt.Sprintf("existing=%t", existing), func(t *testing.T) {
			database := prepareCreditLogQueryDB(t, existing)
			if !database.Migrator().HasIndex(&model.CreditLog{}, creditLogQueryIndex) {
				t.Fatalf("DB initialization did not create %s", creditLogQueryIndex)
			}
			var columns []struct{ Name string }
			if err := database.Raw("PRAGMA index_info('" + creditLogQueryIndex + "')").Scan(&columns).Error; err != nil {
				t.Fatal(err)
			}
			if len(columns) != 2 || columns[0].Name != "created_at" || columns[1].Name != "id" {
				t.Fatalf("index columns = %+v, want (created_at, id)", columns)
			}
			if !database.Migrator().HasIndex(&model.CreditLog{}, "idx_credit_logs_user_id") {
				t.Fatal("existing user_id index was removed")
			}
			if existing {
				logs, total, err := ListCreditLogs(model.Query{})
				want := model.CreditLog{
					ID: "existing", UserID: "owner", Type: model.CreditLogTypeAIConsume,
					Amount: -1.25, Balance: 8.75, RelatedID: "task", Remark: "kept",
					Extra: `{"kept":true}`, CreatedAt: "2026-10-28T10:00:00Z",
				}
				if err != nil || total != 1 || len(logs) != 1 || logs[0] != want {
					t.Fatalf("existing data changed: logs=%+v total=%d err=%v", logs, total, err)
				}
			}
		})
	}
}

func TestCreditLogQueryOrder(t *testing.T) {
	database := prepareCreditLogQueryDB(t, false)
	fixtures := []model.CreditLog{
		{ID: "zz-old", CreatedAt: "2026-10-27T10:00:00Z"},
		{ID: "b", CreatedAt: "2026-10-28T10:00:00Z"},
		{ID: "d", CreatedAt: "2026-10-28T10:00:00Z"},
		{ID: "a", CreatedAt: "2026-10-28T10:00:00Z"},
		{ID: "c", CreatedAt: "2026-10-28T10:00:00Z"},
	}
	if err := database.Create(&fixtures).Error; err != nil {
		t.Fatal(err)
	}
	var plan []struct{ Detail string }
	if err := database.Raw("EXPLAIN QUERY PLAN SELECT * FROM credit_logs ORDER BY created_at DESC, id DESC LIMIT 2").Scan(&plan).Error; err != nil {
		t.Fatal(err)
	}
	t.Logf("order query plan: %+v", plan)
	for _, indexed := range []bool{true, false} {
		t.Run(fmt.Sprintf("indexed=%t", indexed), func(t *testing.T) {
			// Verify the tie-breaker without relying on SQLite's index scan order.
			if !indexed && database.Migrator().HasIndex(&model.CreditLog{}, creditLogQueryIndex) {
				if err := database.Migrator().DropIndex(&model.CreditLog{}, creditLogQueryIndex); err != nil {
					t.Fatal(err)
				}
			}
			for page, want := range [][]string{{"d", "c"}, {"b", "a"}, {"zz-old"}, {}} {
				logs, total, err := ListCreditLogs(model.Query{Page: page + 1, PageSize: 2})
				if err != nil {
					t.Fatal(err)
				}
				ids := make([]string, 0, len(logs))
				for _, log := range logs {
					ids = append(ids, log.ID)
				}
				if total != int64(len(fixtures)) || !slices.Equal(ids, want) {
					t.Fatalf("page %d: ids=%v total=%d, want ids=%v total=%d", page+1, ids, total, want, len(fixtures))
				}
			}
		})
	}
}

func TestCreditLogQuerySearch(t *testing.T) {
	database := prepareCreditLogQueryDB(t, false)
	fixtures := []model.CreditLog{
		{ID: "user", UserID: "prefix-needle-suffix", Type: model.CreditLogTypeAIConsume},
		{ID: "user-uppercase", UserID: "PREFIX-NEEDLE-SUFFIX", Type: model.CreditLogTypeAIConsume},
		{ID: "type", Type: model.CreditLogTypeAdminAdjust},
		{ID: "remark", Remark: "prefix Needle suffix", Type: model.CreditLogTypeAIConsume},
		{ID: "related", RelatedID: "task-needle-suffix", Type: model.CreditLogTypeAIConsume},
		{ID: "multiple", UserID: "needle", Remark: "needle", RelatedID: "needle", Type: model.CreditLogTypeAIRefund},
		{ID: "id-only-needle", Type: model.CreditLogTypeAIConsume},
		{ID: "extra", Extra: "needle payload-secret", Type: model.CreditLogTypeAIConsume},
		{ID: "amount", Amount: 12.34, Balance: 56.78, Type: model.CreditLogTypeAIConsume},
		{ID: "unmatched", Remark: "literal_a%b", Type: model.CreditLogTypeAIRefund},
	}
	allIDs := make([]string, 0, len(fixtures))
	for i := range fixtures {
		fixtures[i].CreatedAt = "2026-10-28T10:00:00Z"
		allIDs = append(allIDs, fixtures[i].ID)
	}
	if err := database.Create(&fixtures).Error; err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name    string
		keyword string
		want    []string
	}{
		{"all", "", allIDs},
		{"blank", "   ", allIDs},
		{"substring", "needle", []string{"user", "user-uppercase", "remark", "related", "multiple"}},
		{"case_and_whitespace", "  nEeDlE  ", []string{"user", "user-uppercase", "remark", "related", "multiple"}},
		{"user", "prefix-needle", []string{"user", "user-uppercase"}},
		{"type", "adjust", []string{"type"}},
		{"type_case_and_whitespace", "  AdJuSt  ", []string{"type"}},
		{"remark", "prefix Needle suffix", []string{"remark"}},
		{"related", "task-needle", []string{"related"}},
		{"id_not_searched", "id-only", nil},
		{"extra_not_searched", "payload-secret", nil},
		{"amount_not_searched", "12.34", nil},
		{"balance_not_searched", "56.78", nil},
		{"no_match", "missing", nil},
		{"percent_wildcard", "%", allIDs},
		{"underscore_wildcard", "_", allIDs},
		{"percent_pattern", "lit%a%b", []string{"unmatched"}},
		{"underscore_pattern", "literal_a_b", []string{"unmatched"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var ids []string
			for page := 1; page <= (len(tc.want)+1)/2+1; page++ {
				logs, total, err := ListCreditLogs(model.Query{Keyword: tc.keyword, Page: page, PageSize: 2})
				if err != nil {
					t.Fatal(err)
				}
				if total != int64(len(tc.want)) {
					t.Fatalf("page %d total=%d, want %d", page, total, len(tc.want))
				}
				if len(logs) > 2 {
					t.Fatalf("page %d returned %d items, limit is 2", page, len(logs))
				}
				for _, log := range logs {
					ids = append(ids, log.ID)
				}
			}
			slices.Sort(ids)
			want := slices.Clone(tc.want)
			slices.Sort(want)
			if !slices.Equal(ids, want) {
				t.Fatalf("matching IDs=%v, want %v", ids, want)
			}
			t.Logf("keyword=%q matchingIDs=%q total=%d", tc.keyword, ids, len(ids))
		})
	}
}
