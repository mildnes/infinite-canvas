package model

// MediaCleanupStatus describes the server-side review state of a media
// reclamation candidate. A candidate is never physically deleted by changing
// this status.
type MediaCleanupStatus string

const (
	MediaCleanupStatusPending    MediaCleanupStatus = "pending"
	MediaCleanupStatusNotDue     MediaCleanupStatus = "not_due"
	MediaCleanupStatusReferenced MediaCleanupStatus = "referenced"
	MediaCleanupStatusUnknown    MediaCleanupStatus = "unknown"
	MediaCleanupStatusProtected  MediaCleanupStatus = "protected"
	MediaCleanupStatusNotFound   MediaCleanupStatus = "not_found"
)

// MediaCleanupCandidate is a delayed, reviewable request to reclaim a
// server-backed object after its owning history/task has been removed.
//
// StorageKey is deliberately retained in addition to ObjectID so old callers
// can enqueue the stable public reference without ever passing provider paths
// or credentials into the cleanup layer.
type MediaCleanupCandidate struct {
	ID            string             `json:"id" gorm:"primaryKey"`
	UserID        string             `json:"userId" gorm:"index"`
	ObjectID      string             `json:"objectId" gorm:"index"`
	StorageKey    string             `json:"storageKey" gorm:"uniqueIndex"`
	RequestedAt   string             `json:"requestedAt" gorm:"index"`
	EligibleAt    string             `json:"eligibleAt" gorm:"index"`
	Status        MediaCleanupStatus `json:"status" gorm:"index"`
	LastCheckedAt string             `json:"lastCheckedAt"`
	ReviewReason  string             `json:"reviewReason" gorm:"type:text"`
	AttemptCount  int                `json:"attemptCount"`
	ResolvedAt    string             `json:"resolvedAt" gorm:"index"`
	CreatedAt     string             `json:"createdAt"`
	UpdatedAt     string             `json:"updatedAt"`
}

// MediaCleanupReference records a server-side reference found during a
// review. Values are intentionally omitted from the public report because
// they may contain prompts, URLs, or user data.
type MediaCleanupReference struct {
	Table    string `json:"table"`
	RecordID string `json:"recordId"`
	Field    string `json:"field"`
}

// MediaCleanupReport is a conservative inspection result. UnknownReasons is
// non-empty whenever the application cannot account for browser-only or
// legacy references; callers must treat that as unsafe to delete.
type MediaCleanupReport struct {
	Candidate       MediaCleanupCandidate   `json:"candidate"`
	ObjectFound     bool                    `json:"objectFound"`
	CloudVerified   bool                    `json:"cloudVerified"`
	Eligible        bool                    `json:"eligible"`
	SafeToDelete    bool                    `json:"safeToDelete"`
	References      []MediaCleanupReference `json:"references"`
	UnknownReasons  []string                `json:"unknownReasons"`
	ProtectedReason string                  `json:"protectedReason,omitempty"`
	ReviewedAt      string                  `json:"reviewedAt"`
}
