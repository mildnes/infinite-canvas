package service

import (
	"net/http"
	"net/http/httptest"
	"reflect"
	"sort"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestModelProtocolRegistryContainsCurrentProtocols(t *testing.T) {
	want := []string{
		ModelChannelProtocolOpenAI,
		ModelChannelProtocolGemini,
		ModelChannelProtocolGrok2API,
		ModelChannelProtocolXAI,
		ModelChannelProtocolMetaso,
		ModelChannelProtocolAPIMart,
		ModelChannelProtocolKIE,
		ModelChannelProtocolMiMo,
		ModelChannelProtocolArk,
	}
	if !reflect.DeepEqual(modelProtocolIDs, want) {
		t.Fatalf("protocol IDs = %v, want %v", modelProtocolIDs, want)
	}
	for _, id := range want {
		adapter, ok := modelProtocolRegistry[id]
		if !ok || adapter.buildURL == nil || adapter.setAuth == nil || adapter.models == nil || adapter.testModel == nil {
			t.Fatalf("protocol %q is not fully registered: %#v", id, adapter)
		}
	}
}

func TestModelProtocolAuthAndURLContracts(t *testing.T) {
	for _, test := range []struct {
		name, protocol, baseURL, path, wantURL, wantAuth, wantGoogle string
	}{
		{"openai", "openai", "https://api.example/", "/models", "https://api.example/v1/models", "Bearer key", "existing"},
		{"grok2api", "grok2api", "https://api.example/v1", "/videos/generations", "https://api.example/v1/videos/generations", "Bearer key", "existing"},
		{"xai", "xai", "https://api.x.ai", "/images/generations", "https://api.x.ai/v1/images/generations", "Bearer key", "existing"},
		{"ark", "ark", "https://ark.cn-beijing.volces.com/api/v3", "/contents/generations/tasks", "https://ark.cn-beijing.volces.com/api/v3/contents/generations/tasks", "Bearer key", "existing"},
		{"metaso", "metaso", "https://api.example/", "/v2/video_generation", "https://api.example/v2/video_generation", "Bearer key", "existing"},
		{"gemini", " GEMINI ", "https://api.example/v1beta", "/v1beta/models/test:generateContent", "https://api.example/v1beta/models/test:generateContent", "existing", "key"},
	} {
		t.Run(test.name, func(t *testing.T) {
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL, APIKey: "key"}
			adapter := modelProtocolForChannel(channel)
			if got := adapter.buildURL(channel, test.path); got != test.wantURL {
				t.Fatalf("URL = %q, want %q", got, test.wantURL)
			}
			request := httptest.NewRequest(http.MethodPost, "https://upstream.invalid", nil)
			request.Header.Set("Authorization", "existing")
			request.Header.Set("x-goog-api-key", "existing")
			adapter.setAuth(request, channel)
			if request.Header.Get("Authorization") != test.wantAuth || request.Header.Get("x-goog-api-key") != test.wantGoogle {
				t.Fatalf("headers = %v, want Authorization=%q x-goog-api-key=%q", request.Header, test.wantAuth, test.wantGoogle)
			}
		})
	}
}

func TestModelProtocolGrokAndProviderPrecedence(t *testing.T) {
	tests := []struct {
		name, protocol, baseURL string
		want                    modelProtocolAdapter
	}{
		{"explicit grok2api", "grok2api", "https://api.example", modelProtocolRegistry[ModelChannelProtocolGrok2API]},
		{"explicit xai", "xai", "https://api.example", modelProtocolRegistry[ModelChannelProtocolXAI]},
		{"xai base URL", "openai", "https://api.x.ai", modelProtocolRegistry[ModelChannelProtocolGrok2API]},
		{"kie wins URL inference", "kie", "https://api.x.ai", modelProtocolRegistry[ModelChannelProtocolKIE]},
		{"apimart wins URL inference", "apimart", "https://api.x.ai", modelProtocolRegistry[ModelChannelProtocolAPIMart]},
		{"metaso wins URL inference", "metaso", "https://api.x.ai", modelProtocolRegistry[ModelChannelProtocolMetaso]},
		{"explicit ark wins URL inference", "ark", "https://api.x.ai", modelProtocolRegistry[ModelChannelProtocolArk]},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := modelProtocolForChannel(model.ModelChannel{Protocol: test.protocol, BaseURL: test.baseURL})
			if got.buildURL == nil || got.models == nil || reflect.ValueOf(got.testModel).Pointer() != reflect.ValueOf(test.want.testModel).Pointer() {
				t.Fatalf("adapter does not match expected protocol: %#v", got)
			}
		})
	}
	if isGrok2APIProtocolChannel(model.ModelChannel{Protocol: "kie", BaseURL: "https://api.x.ai"}) {
		t.Fatal("KIE must not be inferred as Grok/xAI")
	}
}

func TestModelProtocolStaticModelLists(t *testing.T) {
	for _, test := range []struct {
		name, protocol string
		want           []string
	}{
		{"metaso", ModelChannelProtocolMetaso, []string{"MiniMax-H3"}},
		{"mimo", ModelChannelProtocolMiMo, func() []string { result := MiMoModels(); sort.Strings(result); return result }()},
		{"kie", ModelChannelProtocolKIE, func() []string { result := kieMarketModels(); sort.Strings(result); return result }()},
	} {
		t.Run(test.name, func(t *testing.T) {
			got, err := modelProtocolRegistry[test.protocol].models(model.ModelChannel{})
			if err != nil || !reflect.DeepEqual(got, test.want) {
				t.Fatalf("models = %v, %v; want %v", got, err, test.want)
			}
		})
	}
}
