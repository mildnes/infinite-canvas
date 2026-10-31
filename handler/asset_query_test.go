package handler

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"testing"
)

func TestParseAssetTagModeQuery(t *testing.T) {
	for _, tc := range []struct {
		name string
		url  string
		want string
	}{
		{name: "missing", url: "/api/assets", want: "any"},
		{name: "any", url: "/api/assets?tagMode=any", want: "any"},
		{name: "all", url: "/api/assets?tagMode=all", want: "all"},
		{name: "invalid", url: "/api/assets?tagMode=unsupported", want: "any"},
		{name: "case and whitespace", url: "/api/assets?tagMode=+ALL+", want: "all"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, tc.url, nil)
			if got := parseQuery(request).TagMode; got != tc.want {
				t.Fatalf("TagMode = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestParseAssetQueryKeepsRepeatedTags(t *testing.T) {
	request := httptest.NewRequest(http.MethodGet, "/api/assets?tag=red&tag=blue&tagMode=all&category=photo", nil)
	q := parseQuery(request)
	if !reflect.DeepEqual(q.Tags, []string{"red", "blue"}) || q.Category != "photo" || q.TagMode != "all" {
		t.Fatalf("query = %+v", q)
	}
}
