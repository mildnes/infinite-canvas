package repository

import (
	"errors"
	"net/url"
	"strings"

	"github.com/tigerowo/infinite-canvas/config"
	"gorm.io/gorm"
	"gorm.io/gorm/logger"
)

// OpenExistingDatabase is for maintenance commands: no schema creation or migrations.
func OpenExistingDatabase(readOnly bool) error {
	dbOnce.Do(func() {
		driver := strings.ToLower(strings.TrimSpace(config.Cfg.StorageDriver))
		dsn := config.Cfg.DatabaseDSN
		if driver == "" || driver == "sqlite" {
			driver = "sqlite"
			parts := strings.SplitN(dsn, "?", 2)
			if parts[0] == "" || strings.Contains(parts[0], ":memory:") {
				dbErr = errors.New("维护命令必须使用已存在的数据库")
				return
			}
			query := url.Values{}
			if len(parts) == 2 {
				query, dbErr = url.ParseQuery(parts[1])
				if dbErr != nil {
					return
				}
			}
			query.Set("mode", "rw")
			if readOnly {
				query.Set("mode", "ro")
			}
			if !strings.HasPrefix(parts[0], "file:") {
				parts[0] = "file:" + parts[0]
			}
			dsn = parts[0] + "?" + query.Encode()
		}
		// SQL errors must not log an entire project's inline payload.
		db, dbErr = gorm.Open(dialector(driver, dsn), &gorm.Config{Logger: logger.Default.LogMode(logger.Silent)})
	})
	return dbErr
}
