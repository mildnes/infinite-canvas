package model

// WorkflowMediaMetadata describes a durable result referenced by a workflow
// task. The URL is the public short reference written to the task record.
type WorkflowMediaMetadata struct {
	URL        string `json:"url"`
	StorageKey string `json:"storageKey,omitempty"`
	MimeType   string `json:"mimeType,omitempty"`
	Bytes      int64  `json:"bytes,omitempty"`
	Width      int    `json:"width,omitempty"`
	Height     int    `json:"height,omitempty"`
}
