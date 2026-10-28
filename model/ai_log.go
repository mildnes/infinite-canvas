package model

type AICallLog struct {
	ID              string  `json:"id" gorm:"primaryKey"`
	UserID          string  `json:"userId" gorm:"index"`
	UserDisplayName string  `json:"userDisplayName" gorm:"->;-:migration"`
	Endpoint        string  `json:"endpoint" gorm:"index"`
	Method          string  `json:"method"`
	Model           string  `json:"model" gorm:"index"`
	ChannelID       string  `json:"channelId" gorm:"index"`
	ChannelName     string  `json:"channelName"`
	Status          int     `json:"status" gorm:"index"`
	DurationMs      int64   `json:"durationMs"`
	Credits         float64 `json:"credits" gorm:"type:decimal(20,2);size:20"`
	RequestBody     string  `json:"requestBody" gorm:"type:text"`
	ResponseBody    string  `json:"responseBody" gorm:"type:text"`
	Error           string  `json:"error" gorm:"type:text"`
	CreatedAt       string  `json:"createdAt" gorm:"index"`
}

type AICallLogSummary struct {
	ID              string  `json:"id"`
	UserID          string  `json:"userId"`
	UserDisplayName string  `json:"userDisplayName"`
	Endpoint        string  `json:"endpoint"`
	Method          string  `json:"method"`
	Model           string  `json:"model"`
	ChannelID       string  `json:"channelId"`
	ChannelName     string  `json:"channelName"`
	Status          int     `json:"status"`
	DurationMs      int64   `json:"durationMs"`
	Credits         float64 `json:"credits"`
	CreatedAt       string  `json:"createdAt"`
}

type AICallLogList struct {
	Items []AICallLogSummary `json:"items"`
	Total int                `json:"total"`
}

func (item AICallLog) Summary() AICallLogSummary {
	return AICallLogSummary{
		ID: item.ID, UserID: item.UserID, UserDisplayName: item.UserDisplayName,
		Endpoint: item.Endpoint, Method: item.Method, Model: item.Model,
		ChannelID: item.ChannelID, ChannelName: item.ChannelName,
		Status: item.Status, DurationMs: item.DurationMs, Credits: item.Credits,
		CreatedAt: item.CreatedAt,
	}
}
