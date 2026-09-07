package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestModelProtocolVideoResponseHookPrecedence(t *testing.T) {
	tests := []struct {
		name, protocol, requestPath, modelName, payload, want string
	}{
		{
			name:     "KIE create before APIMart",
			protocol: "kie", requestPath: "/jobs/createTask", modelName: "future-model",
			payload: `{"code":200,"data":{"taskId":"task","state":"submitted"}}`,
			want:    `{"id":"task","object":"video","status":"processing","model":"future-model"}`,
		},
		{
			name:     "APIMart status",
			protocol: "apimart", requestPath: "/tasks/task", modelName: "future-model",
			payload: `{"code":200,"data":{"id":"task","status":"completed","result":{"videos":[{"url":"https://media.invalid/video"}]}}}`,
			want:    `{"id":"task","object":"video","status":"completed","progress":0,"model":"future-model","video":{"url":"https://media.invalid/video"},"url":"https://media.invalid/video","data":[{"url":"https://media.invalid/video"}]}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "https://upstream.invalid"+test.requestPath, nil)
			channel := model.ModelChannel{Protocol: test.protocol, BaseURL: "https://api.example"}
			got := transformAIProtocolVideoPayload([]byte(test.payload), request, channel, test.modelName, test.requestPath != "/jobs/createTask")
			assertModelProtocolJSON(t, got, test.want)
		})
	}
}
