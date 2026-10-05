package model

// StorageObject 存储对象（S3/R2、WebDAV 共用文件索引）。
type StorageObject struct {
	ID                     string `json:"id" gorm:"primaryKey"`
	ProviderID             string `json:"providerId" gorm:"index"`
	Bucket                 string `json:"bucket"`
	ObjectKey              string `json:"objectKey" gorm:"uniqueIndex"`
	PublicURL              string `json:"publicUrl"`
	MimeType               string `json:"mimeType"`
	Bytes                  int64  `json:"bytes"`
	Width                  int    `json:"width"`
	Height                 int    `json:"height"`
	SHA256                 string `json:"sha256" gorm:"index"`
	SourceURL              string `json:"sourceUrl" gorm:"type:text"`
	Direct                 bool   `json:"direct"`
	CreatedBy              string `json:"createdBy" gorm:"index"`
	CreatedAt              string `json:"createdAt"`
	CloudSyncedAt          string `json:"cloudSyncedAt" gorm:"index"`
	CloudCheckedAt         string `json:"cloudCheckedAt"`
	CloudCheckStatus       string `json:"cloudCheckStatus"`
	CloudVerifiedAt        string `json:"cloudVerifiedAt"`
	CloudSyncStatus        string `json:"cloudSyncStatus" gorm:"index"`
	CloudSyncError         string `json:"cloudSyncError"`
	CloudSyncAttempts      int    `json:"cloudSyncAttempts"`
	CloudSyncLastAttemptAt string `json:"cloudSyncLastAttemptAt"`
	CloudSyncNextRetryAt   string `json:"cloudSyncNextRetryAt" gorm:"index"`
	CloudSyncLeaseUntil    string `json:"-"`
	CloudSyncLeaseToken    string `json:"-"`
	CloudSyncExplicit      bool   `json:"-"`
	CloudTargetProviderID  string `json:"-"`
	CloudTargetBucket      string `json:"-"`
	CloudTargetKey         string `json:"-"`
	CloudTargetConfigHash  string `json:"-"`
	LocalCopyRemovedAt     string `json:"localCopyRemovedAt"`
	DeletedAt              string `json:"deletedAt"`
}
