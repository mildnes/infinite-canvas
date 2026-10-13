package model

type VideoTask struct {
	ID              string  `json:"id" gorm:"primaryKey"`
	UserID          string  `json:"userId" gorm:"index"`
	UserDisplayName string  `json:"userDisplayName"`
	Model           string  `json:"model" gorm:"index"`
	ChannelID       string  `json:"channelId" gorm:"index"`
	UserChannelID   string  `json:"userChannelId" gorm:"index"`
	ChannelName     string  `json:"channelName"`
	WorkflowRef     string  `json:"workflowRef,omitempty" gorm:"type:text"`
	Source          string  `json:"source" gorm:"index"`
	SourceID        string  `json:"source_id" gorm:"index"`
	UpstreamTaskID  string  `json:"upstreamTaskId" gorm:"index"`
	UpstreamVideoID string  `json:"upstreamVideoId" gorm:"index"`
	Status          string  `json:"status" gorm:"index:idx_video_tasks_status_created_at,priority:1"`
	Progress        int     `json:"progress"`
	Seconds         string  `json:"seconds"`
	Size            string  `json:"size"`
	VideoURL        string  `json:"videoUrl" gorm:"type:text"`
	OriginalURL     string  `json:"originalUrl" gorm:"type:text"`
	StorageKey      string  `json:"storageKey"`
	MimeType        string  `json:"mimeType"`
	Bytes           int64   `json:"bytes"`
	Width           int     `json:"width"`
	Height          int     `json:"height"`
	Error           string  `json:"error" gorm:"type:text"`
	ErrorDetail     string  `json:"errorDetail" gorm:"type:text"`
	RequestBody     string  `json:"requestBody" gorm:"type:text"`
	ResponseBody    string  `json:"responseBody" gorm:"type:text"`
	LastResponse    string  `json:"lastResponse" gorm:"type:text"`
	Credits         float64 `json:"credits" gorm:"type:decimal(20,2);size:20"`
	CreatedAt       string  `json:"createdAt" gorm:"index;index:idx_video_tasks_status_created_at,priority:2"`
	UpdatedAt       string  `json:"updatedAt" gorm:"index"`
	StartedAt       string  `json:"startedAt"`
	CompletedAt     string  `json:"completedAt"`
	LastPolledAt    string  `json:"lastPolledAt" gorm:"index"`
}
