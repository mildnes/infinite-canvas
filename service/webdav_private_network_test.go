package service

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestWebDAVPrivateNetworkOptInAndMediaIntegrity(t *testing.T) {
	for _, test := range []struct {
		name       string
		jsonConfig string
		media      bool
		wantHits   int32
		wantStatus int
	}{
		{name: "default remains blocked", jsonConfig: `{"endpoint":"http://127.0.0.1:1"}`},
		{name: "explicit opt in connects directly", jsonConfig: `{"endpoint":"%s","allowPrivateNetwork":true}`, wantHits: 1},
		{name: "media integrity honors opt in", jsonConfig: `{"endpoint":"%s","allowPrivateNetwork":true}`, media: true, wantHits: 1, wantStatus: http.StatusNotFound},
	} {
		t.Run(test.name, func(t *testing.T) {
			var hits atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				hits.Add(1)
				w.WriteHeader(http.StatusNotFound)
			}))
			defer server.Close()

			configJSON := test.jsonConfig
			if test.wantHits > 0 {
				configJSON = sprintfWebDAVEndpoint(configJSON, server.URL)
			}
			var provider model.StorageProvider
			if err := json.Unmarshal([]byte(configJSON), &provider); err != nil {
				t.Fatal(err)
			}

			var client interface {
				ReadDir(string) ([]os.FileInfo, error)
			}
			var err error
			status := 0
			if test.media {
				client, err = mediaWebDAVClient(context.Background(), provider, &status)
			} else {
				client, err = newWebDAVClient(provider)
			}
			if err != nil {
				t.Fatal(err)
			}
			_, _ = client.ReadDir("probe")
			if got := hits.Load(); (test.wantHits == 0 && got != 0) || (test.wantHits > 0 && got == 0) {
				t.Fatalf("private endpoint requests = %d, want zero=%t", got, test.wantHits == 0)
			}
			if test.media && status != test.wantStatus {
				t.Fatalf("media response status = %d, want %d", status, test.wantStatus)
			}
		})
	}
}

func TestStorageProviderAllowPrivateNetworkJSON(t *testing.T) {
	for _, test := range []struct {
		name string
		json string
		want bool
	}{
		{name: "omitted defaults false", json: `{}`, want: false},
		{name: "false remains false", json: `{"allowPrivateNetwork":false}`, want: false},
		{name: "true round trips", json: `{"allowPrivateNetwork":true}`, want: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			var provider model.StorageProvider
			if err := json.Unmarshal([]byte(test.json), &provider); err != nil {
				t.Fatal(err)
			}
			if providerValue(provider) != test.want {
				t.Fatalf("allowPrivateNetwork = %t, want %t", providerValue(provider), test.want)
			}
			encoded, err := json.Marshal(provider)
			if err != nil {
				t.Fatal(err)
			}
			if test.want && !containsJSONTrue(encoded, `"allowPrivateNetwork":true`) {
				t.Fatalf("true setting was not serialized: %s", encoded)
			}
		})
	}
}

func sprintfWebDAVEndpoint(template, endpoint string) string {
	const marker = "%s"
	for i := 0; i+len(marker) <= len(template); i++ {
		if template[i:i+len(marker)] == marker {
			return template[:i] + endpoint + template[i+len(marker):]
		}
	}
	return template
}

func providerValue(provider model.StorageProvider) bool {
	value := reflect.ValueOf(provider)
	field := value.FieldByName("AllowPrivateNetwork")
	return field.IsValid() && field.Bool()
}

func containsJSONTrue(data []byte, value string) bool {
	return strings.Contains(string(data), value)
}
