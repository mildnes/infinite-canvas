package repository

import (
	"context"
	"fmt"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/glebarez/sqlite"
	"github.com/tigerowo/infinite-canvas/config"
	"github.com/tigerowo/infinite-canvas/model"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

type creditMigrationFixture struct {
	table   string
	model   any
	rows    []any
	columns []string
}

type creditMigrationSnapshot struct {
	rows    []map[string]string
	indices []struct{ Name, SQL string }
	sums    map[string]float64
}

type creditMigrationRecorder struct {
	logger.Interface
	statements []string
}

func (r *creditMigrationRecorder) LogMode(logger.LogLevel) logger.Interface { return r }

func (r *creditMigrationRecorder) Trace(_ context.Context, _ time.Time, sql func() (string, int64), _ error) {
	statement, _ := sql()
	upper := strings.ToUpper(statement)
	for _, prefix := range []string{"CREATE TABLE", "CREATE INDEX", "CREATE UNIQUE INDEX", "DROP TABLE", "ALTER TABLE"} {
		if strings.HasPrefix(upper, prefix) {
			r.statements = append(r.statements, statement)
			return
		}
	}
	if strings.HasPrefix(upper, "INSERT INTO") && strings.Contains(statement, "__temp") {
		r.statements = append(r.statements, statement)
	}
}

func TestCreditDecimalMigrationPreservesSQLiteValuesAndIndices(t *testing.T) {
	fixtures := []creditMigrationFixture{
		{"users", &model.User{}, []any{
			model.User{ID: "owner", Username: "owner", AffCode: "owner-code", Credits: 53613, GroupID: "default", Status: model.UserStatusActive, Extra: `{"kept":true}`},
			model.User{ID: "second", Username: "second", AffCode: "second-code", Credits: 0, Status: model.UserStatusActive},
		}, []string{"credits"}},
		{"credit_logs", &model.CreditLog{}, []any{
			model.CreditLog{ID: "adjust", UserID: "owner", Type: model.CreditLogTypeAdminAdjust, Amount: 53613, Balance: 53613, Extra: `{"kept":true}`},
			model.CreditLog{ID: "consume", UserID: "owner", Type: model.CreditLogTypeAIConsume, Amount: -21, Balance: 53592},
			model.CreditLog{ID: "refund", UserID: "owner", Type: model.CreditLogTypeAIRefund, Amount: 21, Balance: 53613},
		}, []string{"amount", "balance"}},
		{"canvas_image_tasks", &model.CanvasImageTask{}, []any{
			model.CanvasImageTask{ID: "image", UserID: "owner", Source: "canvas", SourceID: "board", NodeID: "image", Credits: 21, Status: "completed", ImageURLs: []string{"/api/files/image/content"}, ImageStorage: []*model.CanvasImageStorage{{URL: "/api/files/image/content", StorageKey: "server:image", Width: 1024, Height: 1024}}},
			model.CanvasImageTask{ID: "image-workflow", UserID: "second", Credits: 7, Status: "cancelled", WorkflowRef: `{"scope":"system","kind":"image"}`},
		}, []string{"credits"}},
		{"canvas_audio_tasks", &model.CanvasAudioTask{}, []any{
			model.CanvasAudioTask{ID: "audio", UserID: "owner", Source: "canvas", SourceID: "board", NodeID: "audio", Credits: 7, Status: "failed", AudioURL: "/api/files/audio/content"},
			model.CanvasAudioTask{ID: "audio-workflow", UserID: "second", Credits: 0, Status: "processing", WorkflowRef: `{"scope":"system","kind":"audio"}`},
		}, []string{"credits"}},
		{"video_tasks", &model.VideoTask{}, []any{
			model.VideoTask{ID: "video", UserID: "owner", Model: "video-model", ChannelID: "channel", Credits: 30, Status: "completed", Seconds: "5", VideoURL: "/api/files/video/content", CreatedAt: "2026-01-01"},
			model.VideoTask{ID: "video-workflow", UserID: "second", Credits: 7, Status: "cancelled", WorkflowRef: `{"scope":"system","kind":"video"}`},
		}, []string{"credits"}},
		{"ai_call_logs", &model.AICallLog{}, []any{
			model.AICallLog{ID: "ai-log", UserID: "owner", Model: "image-model", ChannelID: "channel", Endpoint: "/images/generations", Credits: 21, Status: 200, RequestBody: `{"n":3}`, CreatedAt: "2026-01-01"},
			model.AICallLog{ID: "free-log", UserID: "second", Credits: 0, Status: 200},
		}, []string{"credits"}},
	}
	previousConfig := config.Cfg
	previousDB, previousErr, previousOnce := db, dbErr, dbOnce
	previousLogger := logger.Default
	path := filepath.Join(t.TempDir(), "legacy-credits.db")
	seed, err := gorm.Open(sqlite.Open(path), &gorm.Config{Logger: previousLogger.LogMode(logger.Silent)})
	if err != nil {
		t.Fatal(err)
	}
	connection, err := seed.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_ = connection.Close()
		if db != nil {
			if current, err := db.DB(); err == nil {
				_ = current.Close()
			}
		}
		config.Cfg, logger.Default = previousConfig, previousLogger
		db, dbErr, dbOnce = previousDB, previousErr, previousOnce
	})

	before := make(map[string]creditMigrationSnapshot)
	for _, fixture := range fixtures {
		legacyType := legacyCreditModelType(t, seed, fixture.model, fixture.table)
		if err := seed.Table(fixture.table).AutoMigrate(reflect.New(legacyType).Interface()); err != nil {
			t.Fatal(err)
		}
		for _, row := range fixture.rows {
			value := reflect.ValueOf(row)
			legacy := reflect.New(legacyType)
			for i := 0; i < value.NumField(); i++ {
				legacy.Elem().Field(i).Set(value.Field(i).Convert(legacyType.Field(i).Type))
			}
			if err := seed.Table(fixture.table).Create(legacy.Interface()).Error; err != nil {
				t.Fatal(err)
			}
		}
		assertCreditColumnTypes(t, seed, fixture, "INTEGER")
		before[fixture.table] = snapshotCreditMigration(t, seed, fixture)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	config.Cfg.StorageDriver, config.Cfg.DatabaseDSN = "sqlite", path
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	recorder := &creditMigrationRecorder{Interface: previousLogger.LogMode(logger.Silent)}
	logger.Default = recorder
	started := time.Now()
	database, err := DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("isolated SQLite AutoMigrate elapsed=%s (synthetic fixture, not production-copy acceptance)", time.Since(started))
	for _, fixture := range fixtures {
		assertCreditColumnTypes(t, database, fixture, "DECIMAL(20,2)")
		after := snapshotCreditMigration(t, database, fixture)
		if !reflect.DeepEqual(before[fixture.table], after) {
			t.Fatalf("%s changed during migration: before=%#v after=%#v", fixture.table, before[fixture.table], after)
		}
		t.Logf("%s rows=%d indices=%d sums=%v unchanged", fixture.table, len(after.rows), len(after.indices), after.sums)
		for _, statement := range recorder.statements {
			if strings.Contains(statement, fixture.table) {
				t.Logf("migration DDL: %s", statement)
			}
		}
	}
	assertCreditDatabaseIntegrity(t, database)
	connection, err = database.DB()
	if err != nil {
		t.Fatal(err)
	}
	if err := connection.Close(); err != nil {
		t.Fatal(err)
	}
	db, dbErr, dbOnce = nil, nil, sync.Once{}
	recorder.statements = nil
	database, err = DB()
	if err != nil {
		t.Fatal(err)
	}
	if len(recorder.statements) != 0 {
		t.Fatalf("repeat startup changed schema again: %v", recorder.statements)
	}
	for _, fixture := range fixtures {
		if after := snapshotCreditMigration(t, database, fixture); !reflect.DeepEqual(before[fixture.table], after) {
			t.Fatalf("repeat startup changed %s values or indices", fixture.table)
		}
	}
	assertCreditDatabaseIntegrity(t, database)
	t.Log("repeat startup: no DDL; PRAGMA integrity_check=ok")
}

func legacyCreditModelType(t *testing.T, database *gorm.DB, current any, table string) reflect.Type {
	t.Helper()
	statement := &gorm.Statement{DB: database}
	if err := statement.Parse(current); err != nil {
		t.Fatal(err)
	}
	typeOf := reflect.TypeOf(current).Elem()
	fields := make([]reflect.StructField, typeOf.NumField())
	for i := range fields {
		field := typeOf.Field(i)
		if field.Type.Kind() == reflect.Float64 {
			field.Type = reflect.TypeOf(int(0))
		}
		parts := make([]string, 0)
		for _, tag := range strings.Split(field.Tag.Get("gorm"), ";") {
			if strings.HasPrefix(tag, "type:decimal(") {
				continue
			}
			if tag == "index" || tag == "uniqueIndex" {
				tag += ":" + database.NamingStrategy.IndexName(table, statement.Schema.FieldsByName[field.Name].DBName)
			}
			if tag != "" {
				parts = append(parts, tag)
			}
		}
		field.Tag = reflect.StructTag(fmt.Sprintf("json:%q gorm:%q", field.Tag.Get("json"), strings.Join(parts, ";")))
		fields[i] = field
	}
	return reflect.StructOf(fields)
}

func snapshotCreditMigration(t *testing.T, database *gorm.DB, fixture creditMigrationFixture) creditMigrationSnapshot {
	t.Helper()
	result := creditMigrationSnapshot{sums: make(map[string]float64)}
	var rows []map[string]any
	if err := database.Table(fixture.table).Order("id").Find(&rows).Error; err != nil {
		t.Fatal(err)
	}
	for _, row := range rows {
		values := make(map[string]string, len(row))
		for column, value := range row {
			if bytes, ok := value.([]byte); ok {
				values[column] = string(bytes)
			} else {
				values[column] = fmt.Sprint(value)
			}
		}
		result.rows = append(result.rows, values)
	}
	if err := database.Raw("SELECT name, COALESCE(sql, '') AS sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? ORDER BY name", fixture.table).Scan(&result.indices).Error; err != nil {
		t.Fatal(err)
	}
	for _, column := range fixture.columns {
		var sum float64
		if err := database.Raw("SELECT COALESCE(SUM(`" + column + "`), 0) FROM `" + fixture.table + "`").Scan(&sum).Error; err != nil {
			t.Fatal(err)
		}
		result.sums[column] = sum
	}
	return result
}

func assertCreditColumnTypes(t *testing.T, database *gorm.DB, fixture creditMigrationFixture, expected string) {
	t.Helper()
	var columns []struct{ Name, Type string }
	if err := database.Raw("PRAGMA table_info(`" + fixture.table + "`)").Scan(&columns).Error; err != nil {
		t.Fatal(err)
	}
	for _, name := range fixture.columns {
		found := false
		for _, column := range columns {
			if column.Name == name {
				found = true
				if !strings.EqualFold(column.Type, expected) {
					t.Fatalf("%s.%s type=%q, want %q", fixture.table, name, column.Type, expected)
				}
			}
		}
		if !found {
			t.Fatalf("missing %s.%s", fixture.table, name)
		}
	}
}

func assertCreditDatabaseIntegrity(t *testing.T, database *gorm.DB) {
	t.Helper()
	var checks []string
	if err := database.Raw("PRAGMA integrity_check").Scan(&checks).Error; err != nil || len(checks) != 1 || checks[0] != "ok" {
		t.Fatalf("SQLite integrity_check=%v err=%v", checks, err)
	}
}
