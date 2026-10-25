package model

// CanvasImageTaskResult is the durable, bounded result index, not a task/audit log.
// Heavy task details may expire without discarding the association to original media.
type CanvasImageTaskResult struct {
	UserID     string `gorm:"primaryKey;size:191"`
	TaskID     string `gorm:"primaryKey;size:191"`
	ResultJSON string `gorm:"type:text"`
}
