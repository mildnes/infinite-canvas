package handler

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"

	"github.com/tigerowo/infinite-canvas/service"
)

func UserVideoGenerationLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := service.CurrentUserVideoGenerationLogs(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func SaveUserVideoGenerationLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Logs []json.RawMessage `json:"logs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "历史记录不能为空")
		return
	}
	logs, err := service.SaveCurrentUserVideoGenerationLogs(r.Context(), request.Logs)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func DeleteUserVideoGenerationLog(w http.ResponseWriter, r *http.Request, id string) {
	if strings.TrimSpace(id) == "" {
		Fail(w, "删除历史记录参数无效")
		return
	}
	if err := service.DeleteCurrentUserVideoGenerationLog(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}

func DeleteUserVideoGenerationLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "删除历史记录参数无效")
		return
	}
	if len(request.IDs) == 0 {
		OK(w, map[string]bool{"deleted": true})
		return
	}
	if err := service.DeleteCurrentUserVideoGenerationLogs(r.Context(), request.IDs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}

func UserImageGenerationLogs(w http.ResponseWriter, r *http.Request) {
	logs, err := service.CurrentUserImageGenerationLogs(r.Context())
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func UserImageGenerationLogPage(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	page, err := service.CurrentUserImageGenerationLogPage(r.Context(), limit, r.URL.Query().Get("cursor"))
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, page)
}

func UserImageGenerationLog(w http.ResponseWriter, r *http.Request, id string) {
	log, err := service.CurrentUserImageGenerationLog(r.Context(), id)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, log)
}

func UpsertUserImageGenerationLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Logs []json.RawMessage `json:"logs"`
	}
	if json.NewDecoder(r.Body).Decode(&request) != nil || len(request.Logs) == 0 || len(request.Logs) > 40 {
		Fail(w, "历史记录参数无效")
		return
	}
	if err := service.UpsertCurrentUserImageGenerationLogs(r.Context(), request.Logs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"saved": true})
}

func DeleteUserWorkbenchImageLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		IDs     []string `json:"ids"`
		TaskIDs []string `json:"taskIds"`
	}
	if json.NewDecoder(r.Body).Decode(&request) != nil {
		Fail(w, "删除历史记录参数无效")
		return
	}
	if err := service.DeleteCurrentUserWorkbenchImageLogs(r.Context(), request.IDs, request.TaskIDs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}

func SaveUserImageGenerationLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		Logs []json.RawMessage `json:"logs"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "历史记录不能为空")
		return
	}
	logs, err := service.SaveCurrentUserImageGenerationLogs(r.Context(), request.Logs)
	if err != nil {
		FailError(w, err)
		return
	}
	OK(w, logs)
}

func DeleteUserImageGenerationLog(w http.ResponseWriter, r *http.Request, id string) {
	if strings.TrimSpace(id) == "" {
		Fail(w, "历史记录不存在")
		return
	}
	if err := service.DeleteCurrentUserImageGenerationLog(r.Context(), id); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}

func DeleteUserImageGenerationLogs(w http.ResponseWriter, r *http.Request) {
	var request struct {
		IDs []string `json:"ids"`
	}
	if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
		Fail(w, "删除历史记录参数无效")
		return
	}
	if len(request.IDs) == 0 {
		OK(w, map[string]bool{"deleted": true})
		return
	}
	if err := service.DeleteCurrentUserImageGenerationLogs(r.Context(), request.IDs); err != nil {
		FailError(w, err)
		return
	}
	OK(w, map[string]bool{"deleted": true})
}
