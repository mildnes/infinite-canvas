package handler

import (
	"encoding/json"
	"errors"
	"net/http"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

func StopCanvasTask(w http.ResponseWriter, r *http.Request) {
	user, ok := service.UserFromContext(r.Context())
	if !ok {
		Fail(w, "未登录或权限不足")
		return
	}
	var request struct {
		Kind   string `json:"kind"`
		TaskID string `json:"taskId"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil || strings.TrimSpace(request.TaskID) == "" {
		Fail(w, "任务参数无效")
		return
	}
	status, stopped, refunded, err := service.StopCanvasTask(request.Kind, user.ID, request.TaskID)
	if err != nil {
		if errors.Is(err, service.ErrCanvasTaskNotFound) {
			FailWithStatus(w, http.StatusNotFound, "任务不存在")
			return
		}
		FailError(w, err)
		return
	}
	OK(w, map[string]any{"status": status, "stopped": stopped, "creditsRefunded": refunded})
}
