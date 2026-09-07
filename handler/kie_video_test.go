package handler

import (
	"encoding/json"
	"testing"

	"github.com/tigerowo/infinite-canvas/model"
)

func TestNormalizeKIESeedance25Duration(t *testing.T) {
	tests := []struct {
		name  string
		value any
		want  any
	}{
		{name: "auto", value: -1, want: float64(-1)},
		{name: "twenty", value: 20, want: float64(20)},
		{name: "twenty five", value: 25, want: float64(25)},
		{name: "thirty", value: 30, want: float64(30)},
		{name: "clamp upper bound", value: 31, want: float64(30)},
		{name: "clamp lower bound", value: 3, want: float64(4)},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			body, err := json.Marshal(map[string]any{
				"model":    "bytedance/seedance-2-5",
				"prompt":   "test",
				"duration": tt.value,
			})
			if err != nil {
				t.Fatal(err)
			}
			normalized, _, err := normalizeKIEVideoBody(body, "application/json", "bytedance/seedance-2-5", model.ModelChannel{Protocol: "kie"})
			if err != nil {
				t.Fatal(err)
			}
			var payload map[string]any
			if err := json.Unmarshal(normalized, &payload); err != nil {
				t.Fatal(err)
			}
			input, ok := payload["input"].(map[string]any)
			if !ok {
				t.Fatalf("input = %#v", payload["input"])
			}
			if got := input["duration"]; got != tt.want {
				t.Fatalf("duration = %#v, want %#v", got, tt.want)
			}
		})
	}
}
