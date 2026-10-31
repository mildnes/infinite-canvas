package model

import "strings"

const MaxPageSize = 500

const (
	AssetTagModeAny = "any"
	AssetTagModeAll = "all"
)

// Query 列表筛选和分页参数。
type Query struct {
	Keyword  string
	Tags     []string
	Category string
	Type     string
	TagMode  string
	Page     int
	PageSize int
}

func (q *Query) Normalize() {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PageSize < 1 {
		q.PageSize = 20
	}
	if q.PageSize > MaxPageSize {
		q.PageSize = MaxPageSize
	}
}

func (q *Query) Offset() int {
	return (q.Page - 1) * q.PageSize
}

// NormalizeAssetTagMode 将素材标签匹配模式归一化为 any 或 all。
func NormalizeAssetTagMode(value string) string {
	if strings.EqualFold(strings.TrimSpace(value), AssetTagModeAll) {
		return AssetTagModeAll
	}
	return AssetTagModeAny
}
