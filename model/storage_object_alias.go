package model

// StorageObjectAlias preserves references to retired duplicate objects.
// Operations tools write aliases; application saves only read them.
type StorageObjectAlias struct {
	OldID     string `gorm:"primaryKey;column:old_id"`
	NewID     string `gorm:"column:new_id;not null"`
	CreatedAt string `gorm:"column:created_at"`
}
